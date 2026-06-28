# Deal Hunter — Architecture

How the deal-finding pipeline is put together, and how to extend it. Read this before adding
a vertical or a source.

## The core idea: one pipeline, polymorphic at the seams

Deal Hunter is **one pipeline** that works the same for every kind of thing it hunts. What
changes between a car and a mini-PC is *how* you search, price, and judge — not the flow. So
the pipeline is built like an API: a uniform flow with pluggable implementations behind named
seams.

- **Core (the WHAT)** — the flow: discover requirements → recon the market → baseline prices →
  create + monitor a hunt → evaluate new listings → surface results. This is vertical-agnostic
  and lives in the core skills, the watcher scheduler, the DB, and the dashboard shell.
- **Specialist (the HOW)** — the per-vertical/per-source knowledge: which source to search and
  how, how to price it, how to judge a listing, how to render it. This lives in specialist
  skills and in the backend plugins (adapters, translators, formatters).

A vertical is declared once, in `config/verticals.yml`. Everything else resolves its behaviour
from that declaration at runtime. Adding a vertical on a source that already exists is config +
skills, with no code change.

## The single source of truth: `config/verticals.yml`

Each vertical is one block. `_default` supplies fallbacks; a vertical `inherit:`s it and
overrides. Fields:

| Field | Meaning |
|-------|---------|
| `sources` | Which data sources the watcher polls (e.g. `[ebay]`, `[autotrader]`). |
| `default_poll_minutes` | Poll cadence when a hunt doesn't override it. |
| `criteria_schema` | The criteria fields a hunt in this vertical accepts. |
| `recon_tool` | The search tool used for market reconnaissance during discovery. |
| `sourcing_skill` | The skill describing how to search this source and baseline its prices. |
| `evaluator_skill` | The skill describing how to evaluate a listing in this vertical. |
| `knowledge_base_path` | File-path pattern for the vertical's reference knowledge (empty = none). |
| `notification_formatter` | (optional) Named formatter that pre-renders the notification line. |
| `attributes_required` | (optional) Attribute keys an offer should carry to be fully renderable. |
| `agent` | (optional) `{ name, description, prompt }` for the vertical's evaluator sub-agent. |

The loader (`watcher/src/verticals.ts`; a lockstep copy at `src/verticals/loader.ts`) resolves
`inherit:` and applies the `_default` fallbacks.

## Runtime discovery: how the agent learns a vertical's capabilities

`config/verticals.yml` is not mounted inside the container, but the deal-hunter DB always is.
So the watcher **mirrors** the resolved verticals into a `verticals` table at startup
(`syncVerticals` in `watcher/src/db.ts`), and the container agent reads them through two MCP
tools (`container/agent-runner/src/deal-hunter-mcp.ts`):

- `list_verticals` — what verticals exist and their capabilities.
- `get_vertical(name)` — one vertical's capabilities.

The core skills call these to adapt to the hunt's vertical instead of assuming a source. The
single source of truth stays `verticals.yml`; the table is a read-through mirror.

## The flow and where verticals plug in

```
discover ─► recon ─► baseline ─► create+monitor ─► (watcher polls) ─► evaluate ─► surface
   │          │         │             │                 │                │           │
   └ core skills resolve get_vertical and follow the vertical's specialist skills ──┘
              recon_tool   sourcing_skill   sources/cadence    adapter+translator  evaluator_skill
                                                               +formatter          (agent block)
```

- **Discovery / hunt creation / baselining** — core skills (`requirements-discovery`,
  `hunt-management`, `price-baselining`). They describe the flow and delegate the source-specific
  "how" to the vertical's `sourcing_skill`. `price-baselining` additionally owns the **uniform
  DB-recording contract** (market segments + baseline prices), identical for every vertical.
- **Watching** — `watcher/src/scheduler.ts` polls each hunt's `sources` at the vertical's
  cadence, dispatching through the source-adapter registry. New listings are normalised and
  upserted; change detection and notification follow.
- **Evaluation** — the watcher writes an IPC task; the orchestrator delegates to the vertical's
  evaluator sub-agent, which follows the vertical's `evaluator_skill`.
- **Surfacing** — the dashboard renders source-specific blocks; the watcher's notifier uses the
  vertical's `notification_formatter` if declared.

## The seams (each defined in exactly one place)

| Seam | Contract | Lives in |
|------|----------|----------|
| Vertical descriptor | `verticals.yml` block (fields above) | `config/verticals.yml` |
| Runtime discovery | `list_verticals` / `get_vertical` MCP tools, fed by the `verticals` table | `watcher/src/db.ts`, `deal-hunter-mcp.ts` |
| Source adapter | `SourceAdapter` interface — `search`/`fetchDetail`/`getState`, returns `NormalisedListing` | `watcher/src/sources/<source>/`, registry in `sources/index.ts` |
| Translator | maps hunt criteria → source-native params, keyed `${vertical}/${source}` | `verticals/<vertical>/translators/<source>.ts`, registry `watcher/src/translators/index.ts` |
| Formatter | renders the notification line, keyed by `notification_formatter` name | `verticals/<vertical>/formatter.ts`, registry `watcher/src/formatters/index.ts` |
| Sourcing skill | how to search the source + baseline prices | `container/skills/<x>-sourcing/SKILL.md` |
| Evaluator skill | how to judge a listing | `container/skills/<x>-evaluation/SKILL.md` |
| Evaluator sub-agent | built from the vertical's `agent` block; tools derived from `sources` | `container/agent-runner/src/vertical-agents.ts` |

The source→MCP-server/tool mapping (`mcpServersForSource`/`toolGlobsForSource` in
`vertical-agents.ts`) is the one piece that is legitimately code: a data source is shared
infrastructure, not vertical policy. Everything else a vertical needs is config + skills.

## Runbook: add a vertical on an existing source

No code. Example — a `headphones` vertical on eBay:

1. Add a block to `config/verticals.yml`:
   ```yaml
   headphones:
     inherit: _default          # gives ebay-sourcing, ebay recon_tool, product KB path, ebay source
     evaluator_skill: generic-deal-evaluator   # or a bespoke skill (see below)
     sources: [ebay]
     default_poll_minutes: 120
   ```
2. If the category needs bespoke evaluation, add `container/skills/headphones-evaluation/SKILL.md`
   and point `evaluator_skill` at it, plus an `agent:` block (`name`, `description`, `prompt`) so
   it gets its own evaluator sub-agent. If generic evaluation is fine, skip this — it falls back
   to `generic-deal-evaluator`.
3. If its price research differs from the inherited `ebay-sourcing`, add a `<x>-sourcing` skill
   and point `sourcing_skill` at it. Otherwise inherit.
4. Rebuild the watcher and restart it so it re-syncs the `verticals` table:
   `cd watcher && npx tsc && systemctl restart deal-hunter-watcher.service`. If you added/edited
   skills or the `agent` block, also redeploy the container (see below).

A hunt then sets `vertical: headphones` via `manage_hunt`.

## Runbook: add a new source

Code, because a source is a new integration. Once added, any vertical can use it.

1. **Adapter** — `watcher/src/sources/<source>/` implementing `SourceAdapter`; self-register it
   (side-effect import in `scheduler.ts`).
2. **Translator** — `verticals/<vertical>/translators/<source>.ts`; register under
   `${vertical}/${source}`.
3. **Formatter** (if the notification differs) — `verticals/<vertical>/formatter.ts`; register by name.
4. **MCP search server** for the container agent (mirror `autotrader-search-mcp.ts`); register it
   in `index.ts` `mcpServers`, and add a case to `mcpServersForSource`/`toolGlobsForSource` in
   `vertical-agents.ts`.
5. **Sourcing skill** — `container/skills/<x>-sourcing/SKILL.md` for how to search/price it.
6. Declare a vertical that uses it in `verticals.yml`.
7. Rebuild + redeploy: `cd verticals && npx tsc && cd ../watcher && npx tsc && cd .. &&
   ./container/build.sh && rm -rf data/sessions/*/agent-runner-src/`, then restart the watcher,
   dashboard, and NanoClaw.

## Deploy checklist (when container code or skills change)

Per [CLAUDE.md](../../CLAUDE.md): `./container/build.sh` → `rm -rf data/sessions/*/agent-runner-src/`
→ restart services. Skill edits and `verticals.yml` `agent`/skill changes require the container
rebuild + cache clear; schema/cadence changes require the watcher rebuild + restart.

## See also

- [multi-vertical-rollout.md](multi-vertical-rollout.md) — the original rollout changelog (cars/AutoTrader).
- [deal-hunter-addendum-hunt-files.md](deal-hunter-addendum-hunt-files.md) — hunt file conventions.
