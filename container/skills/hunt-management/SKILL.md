---
name: hunt-management
description: >
  Create, update, pause, resume, or close hunts. Use after requirements
  discovery to formalise a hunt, when criteria need changing, when the
  user wants to pause or stop looking, or when managing multiple hunts.
---

# /hunt-management — Manage Hunts

Read `HUNT-PHILOSOPHY.md` (in this skill directory) for the foundational approach — hunts are market-driven feedback loops, not waterfall projects.

## Lifecycle

A hunt moves through an enforced state machine: **`draft` → `active` → `paused`/`closed`**.

- **`draft`** — every new hunt starts here. It is NOT monitored; the watcher ignores it. This is
  where you refine criteria and record the price baseline.
- **`active`** — reached only by calling `manage_hunt action:activate`, which is a **gate**: it
  refuses unless the criteria are valid for the vertical **and** the hunt's facts are grounded in
  evidence — segment prices derived from sourced comps, and (for feature-led hunts) a cited spec KB
  plus independent verification of every must-have. Only active hunts are polled by the watcher.
  See step 6 under **Create** for the full checklist; the gate's rejection message lists exactly
  what's missing.
- **`paused`** — monitoring stopped (user intent). `resume` re-runs the gate.
- **`closed`** — terminal.

You cannot turn monitoring on directly (`update` rejects `monitoring:true`). Activation is the
only path, and it is gated — so a half-set-up hunt can never silently run with no baseline.

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

   **Searchable vs evaluator-only — get the split right.** A hunt's monitoring search is a
   *wide net* that can only filter on the structured fields the source supports. Put **only
   searchable constraints** in the searchable part of `criteria`; put everything judgement-based
   (must-have features, trims/packs, "reject if…" rules, free-text notes) where the evaluator
   reads it. Check the vertical's `criteria_schema` for the zone names. For **cars**:
   - `criteria.shared` — hunt-wide searchable fields (postcode, budget, mileage, fuel).
   - `criteria.targets` — one entry per candidate model (make/model/year), **keyed by the search
     term string**. A single "family EV" hunt carries all its models here; don't split it into
     one hunt per model.
   - `criteria.intent` — features, trims, reject rules, per-model notes. The search never sees
     this; the evaluator applies it to the returned listings.

   **search_terms must use the exact keys of `criteria.targets`** — the watcher iterates
   search_terms and looks each one up in `targets`, so a mismatch means that model is never
   searched. Set search_terms to the target keys, e.g. keys `"Jaguar I-Pace"`, `"Kia EV6"` →
   `search_terms = [{"terms":"Jaguar I-Pace"},{"terms":"Kia EV6"}]`.
   The hunt is created as a **`draft`** — it is not monitored yet. Monitoring is enabled later
   by `activate` (step 7), which is gated on a valid criteria shape, so getting the
   searchable/evaluator-only split right here is what lets the hunt activate at all.
4. Create the hunt markdown file at `references/hunts/{hunt-name}.md` with a requirements summary.
5. **Run `/price-baselining` via the `market-researcher` sub-agent — this is mandatory, not
   optional, and the activation gate enforces it.** A hunt without market segments is broken:
   the dashboard "vs Base" column will be empty and evaluations won't be grounded in real
   market data. You **cannot** activate a hunt with zero segments — `activate` will refuse. If
   unsure about segments, start with a single broad segment and refine later. Informal price
   notes in the hunt markdown are NOT a substitute for structured DB segments.
6. **For a feature-led hunt (one with `criteria.intent.must_have`), the gate now also requires
   researched, verified specs — not just a baseline.** Before `activate` will succeed you must:
   - **Build the per-target knowledge base** via `/car-spec-research` (the vertical's `sourcing_skill`
     points to it) and call `record_kb_coverage` for each `criteria.targets` model, citing a source
     for every must-have. The gate blocks any target with no cited KB (check **C**).
   - **Independently verify each must-have** by delegating to the `musthave-verifier` sub-agent
     (`/musthave-verification`), which re-fetches primary sources and records a verdict per
     (target, must-have). The gate blocks until every pair is `verified`; a `contradicted` verdict
     (e.g. a feature claimed "standard" that's really an optional pack) must be resolved — fix the
     criteria/targets or, only on explicit user instruction, `waive_must_have` with a reason.
   - **Bucket-then-derive the prices** (see `/price-baselining`): segments are defined from the KB
     trims, comps are recorded with source refs + tags, and the band is derived — the gate blocks any
     segment without ≥3 sourced comps or with a too-wide (mixed-trim) spread.

   A hunt with no `must_have` (e.g. the user already knows the exact product) skips the KB/verification
   gates; price provenance (sourced comps) still applies to every hunt.
7. **Activate the hunt: `manage_hunt action:activate, hunt_id: X`.** This is the gate — it
   succeeds only if the criteria are valid for the vertical AND at least one market segment
   exists, then it flips the hunt to `active` and turns monitoring on. If it's rejected, the
   error lists exactly what's missing (a required criteria field and/or "0 market segments");
   fix that (criteria via `action:update`, segments via `/price-baselining`) and retry. **Do
   not finish the conversation with the hunt still in `draft`** — an un-activated hunt does
   nothing.
8. Confirm to the user: what's being watched, how often, what criteria.
9. This is a living document. Come back and update search terms, criteria, and strategy as you
   learn from monitoring and evaluation.

### Activate

1. `mcp__deal-hunter-db__manage_hunt` with action `activate`, `hunt_id`
2. This is the **gate**: it enables monitoring only if criteria are valid for the vertical AND
   ≥1 market segment exists. On rejection, read the listed reasons and fix them (criteria via
   `update`, segments via `/price-baselining`), then retry.
3. Confirm to the user once active.

### Update

1. Identify what changed and why
2. `mcp__deal-hunter-db__manage_hunt` with action `update`. Note: `update` **cannot turn
   monitoring on** — use `activate` for that. It can turn monitoring off (`monitoring: false`).
3. Assess impact on active watches and search terms
4. Confirm changes to user

### Pause / Resume

1. `mcp__deal-hunter-db__manage_hunt` with action `pause` or `resume`. `pause` stops monitoring;
   `resume` re-runs the activation gate before resuming (so a hunt whose segments/criteria were
   cleared won't silently resume broken).
2. Update the hunt file status
3. Confirm to user

### Close

1. Confirm with user first
2. `mcp__deal-hunter-db__manage_hunt` with action `close` (cascades watches, retains history)
3. Summarise: how long the hunt ran, what was learned
4. Append closing summary to the hunt file

## Monitoring

The `monitoring` flag controls whether the background watcher polls a hunt's search terms. The
watcher only polls hunts that are **`status: 'active'` AND `monitoring: 1`**.

- Monitoring is turned **on only by `activate`** (the gate) — never set it directly. A new hunt
  is always created as a `draft` with monitoring off, and stays that way until it baselines and
  activates.
- **`pause`** stops monitoring (status → `paused`, monitoring → off). **`resume`** re-runs the
  gate and turns monitoring back on.
- `update` can turn monitoring **off** (`monitoring: false`) to quiet an active hunt without
  pausing it, but cannot turn it on.

Ad-hoc searches are never monitored — they're just research tools. Only hunt search terms get polled by the watcher.

## Rules

- Always confirm with the user before closing a hunt
- When creating, explain clearly what will be monitored and how often
- Activate early — once you have a rough baseline (≥1 segment) and valid criteria, activate. A
  broad hunt learning from the market beats a perfect hunt that never leaves draft. Don't
  over-polish criteria before activating; refine them live afterwards.
- Keep search terms to the minimum needed — polling costs add up; the vertical's `sourcing_skill` explains the source's cost model
- Hunts are iterative — creating one is not a commitment to fixed criteria. Update search terms, criteria, and strategy freely as market data comes in
