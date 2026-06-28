# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw

# Deal Hunter services (system-level, not --user)
systemctl restart deal-hunter-watcher.service
systemctl restart deal-hunter-dashboard.service
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Deal Hunter

Automated multi-vertical, multi-source deal-finding system. Currently supports `computers` (eBay) and `cars` (AutoTrader). The pipeline is vertical-agnostic — one flow, with the per-vertical "how" in specialist skills and `config/verticals.yml`. Adding a vertical on an existing source is config + skills (no code); a new source needs a `SourceAdapter`. **See [docs/delhunter/deal-hunter-architecture.md](docs/delhunter/deal-hunter-architecture.md) for the model, the seam contracts, and the add-a-vertical / add-a-source runbooks.**

| Component | Service | Purpose |
|-----------|---------|---------|
| Watcher | `deal-hunter-watcher.service` | Polls all configured sources, triggers agent evaluations |
| Dashboard | `deal-hunter-dashboard.service` | Web UI for hunts, offers, activity |
| Agent MCP | `container/agent-runner/src/deal-hunter-mcp.ts` | DB tools for the container agent |

**Verticals:** declared in `config/verticals.yml` (the single source of truth — sources, cadence, criteria_schema, sourcing/evaluator skills, recon_tool, knowledge_base_path, and an optional `agent` block). The watcher parses it via `verticals.ts` and mirrors resolved capabilities into a `verticals` DB table at startup; the container agent reads them through the `get_vertical`/`list_verticals` MCP tools (verticals.yml isn't mounted in-container). `src/verticals/loader.ts` is a lockstep copy kept for the orchestrator (currently unused) — keep the two in sync when adding fields. Evaluator sub-agents are built from the `agent` blocks by `container/agent-runner/src/vertical-agents.ts`.

**Source adapters:** live in `watcher/src/sources/<name>/`. Each implements the `SourceAdapter` interface (`watcher/src/sources/types.ts`). The eBay adapter is in `sources/ebay/`; AutoTrader in `sources/autotrader/`. The dashboard has parallel adapters in `dashboard/server/sources/`.

**Database:** `groups/telegram_main/deal-hunter.db` (SQLite). Schema is managed by the watcher's `ensureSchema()` in `watcher/src/db.ts` — runs at watcher startup.

**Hunt files:** `groups/telegram_main/references/hunts/*.md` — stable reference material only (requirements, price research, strategy notes). Hunt files are not eBay-specific; cars hunts live here too. Run-level logging goes to the `hunt_log` DB table via `log_hunt_run` MCP tool.

**Key principle:** If you add/change DB schema in `watcher/src/db.ts`, you must rebuild and restart the watcher for `ensureSchema()` to run:
```bash
cd watcher && npx tsc && systemctl restart deal-hunter-watcher.service
```

## Deploying Agent-Runner Changes

When you modify files in `container/agent-runner/src/`, three steps are needed:

1. `./container/build.sh` — rebuild the container image
2. `rm -rf data/sessions/*/agent-runner-src/` — clear the per-group source cache
3. Restart NanoClaw (or wait for the next container to spawn)

**Why:** Each group gets a writable copy of `agent-runner/src/` on first container start (`data/sessions/{group}/agent-runner-src/`). This copy is never auto-updated — it's a feature allowing per-group customization. If you skip step 2, existing groups will keep running the old code even after rebuilding the image.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
