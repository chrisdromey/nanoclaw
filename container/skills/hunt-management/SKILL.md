---
name: hunt-management
description: >
  Create, update, pause, resume, or close hunts. Use after requirements
  discovery to formalise a hunt, when criteria need changing, when the
  user wants to pause or stop looking, or when managing multiple hunts.
---

# /hunt-management — Manage Hunts

Read `HUNT-PHILOSOPHY.md` (in this skill directory) for the foundational approach — hunts are market-driven feedback loops, not waterfall projects.

## When to use

- Requirements have enough shape to define meaningful search terms (they don't need to be complete)
- The user wants to change criteria, pause, resume, or close a hunt
- Managing multiple concurrent hunts
- Market findings suggest the hunt should be updated (new products, changed criteria, refined search terms)

## Orientation

1. `mcp__deal-hunter-db__get_hunt` (no ID) — list all hunts for the full picture
2. `mcp__deal-hunter-db__get_vertical` for this hunt's vertical — its `sourcing_skill` (how to
   design search terms and filters for the source), `criteria_schema` (what criteria the hunt
   accepts), and `knowledge_base_path` (whether the vertical expects reference knowledge)
3. Check for dependencies between hunts

## Workflows

### Create

1. Take criteria from the requirements-discovery conversation
2. `mcp__deal-hunter-db__manage_hunt` with action `create`: criteria, search terms, cadence,
   and the `vertical` (plus `sources` if it differs from the vertical default). The watcher
   derives the poll cadence from the vertical unless you set `poll_interval_minutes`.
3. Define search terms broadly — design them per the vertical's `sourcing_skill` (term count,
   filtering, and budget are source-specific).
4. Set `monitoring: true` to start learning from the market immediately. Only set
   `monitoring: false` if you have a specific reason (e.g. search terms are completely
   untested) — but you should have tested them with ad-hoc search during requirements
   discovery.
5. Create the hunt markdown file at `references/hunts/{hunt-name}.md` with a requirements summary.
6. **Run `/price-baselining` via the `market-researcher` sub-agent — this is mandatory, not
   optional.** A hunt without market segments is broken: the dashboard "vs Base" column will
   be empty and evaluations won't be grounded in real market data. Do not move on until you
   have recorded at least one segment with a baseline price. If unsure about segments, start
   with a single broad segment and refine later — but never leave a hunt with zero segments.
   Informal price notes in the hunt markdown are NOT a substitute for structured DB segments.
7. **If the vertical declares a `knowledge_base_path` and the brief is feature-led, the
   knowledge base must exist before monitoring is enabled** — the evaluator verifies must-have
   features against it and will otherwise silently skip the check. The vertical's
   `sourcing_skill` covers how to build it. (If the user already knows the exact product and
   the brief isn't feature-led, a knowledge base is recommended but not blocking.)
8. Confirm to the user: what's being watched, how often, what criteria.
9. This is a living document. Come back and update search terms, criteria, and strategy as you
   learn from monitoring and evaluation.

### Update

1. Identify what changed and why
2. `mcp__deal-hunter-db__manage_hunt` with action `update`
3. Assess impact on active watches and search terms
4. Confirm changes to user

### Pause / Resume

1. `mcp__deal-hunter-db__manage_hunt` with action `pause` or `resume`
2. Update the hunt file status
3. Confirm to user

### Close

1. Confirm with user first
2. `mcp__deal-hunter-db__manage_hunt` with action `close` (cascades watches, retains history)
3. Summarise: how long the hunt ran, what was learned
4. Append closing summary to the hunt file

## Monitoring

A hunt has a `monitoring` flag that controls whether the background watcher polls its search terms for new listings.

- **`monitoring: true`** — the watcher automatically searches the hunt's sources using its
  search terms at the configured cadence, records new offers, and triggers an event-driven
  invocation so you can evaluate them.
- **`monitoring: false`** — the hunt exists for tracking and organisation but the watcher
  ignores it. Use this during research, baselining, or when refining search terms.
- **Pausing** a hunt (`status: 'paused'`) also stops monitoring — the watcher only queries
  active hunts.

Toggle monitoring with: `manage_hunt(action: 'update', hunt_id: X, monitoring: true/false)`

Ad-hoc searches are never monitored — they're just research tools. Only hunt search terms get polled by the watcher.

## Rules

- Always confirm with the user before closing a hunt
- When creating, explain clearly what will be monitored and how often
- Start monitoring early — a broad hunt learning from the market beats a perfect hunt that hasn't started
- Keep search terms to the minimum needed — polling costs add up; the vertical's `sourcing_skill` explains the source's cost model
- Hunts are iterative — creating one is not a commitment to fixed criteria. Update search terms, criteria, and strategy freely as market data comes in
