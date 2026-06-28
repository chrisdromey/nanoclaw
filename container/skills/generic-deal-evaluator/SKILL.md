---
name: generic-deal-evaluator
description: Evaluates deal offers across any vertical using sold-comp baselines and price-tier signals where available. Use as the default evaluator for hunts whose vertical doesn't specify a bespoke skill.
allowed-tools: mcp__deal-hunter-db__*, mcp__sold-data__*
---

# /generic-deal-evaluator — Default Deal Evaluator

Vertical-agnostic offer evaluation. Use for T1 and T2 verticals (cookers, AC units, cameras, general categories) where no bespoke evaluator skill exists.

## Delegation

When this skill is triggered from an interactive chat session (user message, not a scheduled task), delegate to the `generic-deal-evaluator` sub-agent instead of doing the work inline. This keeps the chat context lean.

1. Gather context: hunt ID, what to evaluate (new offers / specific listing / broad check)
2. Delegate to `generic-deal-evaluator` with that context
3. Relay the returned summary to the user

Do NOT delegate when:
- You ARE the `generic-deal-evaluator` sub-agent (this skill was preloaded via `skills`)
- This is a scheduled/watcher invocation (`[SCHEDULED TASK]` or `[WATCHER]` prefix in prompt)
- Trivial lookup (single field check, no search needed)

## When invoked

- Watcher found new offers for a hunt whose vertical uses this skill
- User asks to evaluate a listing with no vertical-specific evaluator
- Scheduled daily review for T1/T2 hunts

## Orientation

Before evaluating offers, gather context:

1. `mcp__deal-hunter-db__get_hunt_summary` — hunt criteria, market segments (price tiers), watched offers, health warnings
2. Read `references/hunts/{hunt}.md` — strategy notes and qualitative observations
3. Read `references/preferences.md` if it exists — general buying preferences

## Step 1 — Triage

Use `mcp__deal-hunter-db__list_offers` to fetch slim rows (title, price, status). Scan titles — you can often rule out clear mismatches without further API calls.

Use `mcp__deal-hunter-db__batch_dismiss` to clear obvious mismatches in a single call. Aim to reduce to 5–10 candidates before going deeper.

## Step 2 — Evaluate candidates

For each remaining offer:

1. `mcp__deal-hunter-db__get_offer` — full details and last evaluation. If nothing changed since last evaluation, skip.
2. `mcp__deal-hunter-db__get_hunt_summary` — cross-check `market_segments` price tiers (price_low / price_mid / price_high) for the category. This is your authoritative price baseline.
3. `mcp__sold-data__get_sold_prices` — pull recent sold comps by keyword for additional price anchoring. Use the hunt's search terms or a representative title. Weight the median more than outliers.
4. Calculate true landed cost — item price plus shipping. For non-UK sellers, add duty and 20% VAT.
5. Assess against criteria: does it meet stated requirements? How does price compare to comps and segment tiers?
6. Assess urgency — time-sensitive listings (auction endings, limited-stock notes) weight more heavily.

## Step 3 — Decide and record

For each offer, decide:

- **ALERT** — clear deal: price meaningfully below comp median, meets criteria, no significant caveats
- **WATCH** — price-watching candidate: interesting spec/price but not a clear deal yet; enable monitoring
- **SKIP** — overpriced, wrong spec, or below minimum quality threshold

Record every decision: `mcp__deal-hunter-db__record_evaluation`.

For ALERT: also call `mcp__deal-hunter-db__record_alert`.

For WATCH: call `mcp__deal-hunter-db__update_offer` with `watching: true` and `watch_conditions` JSON, e.g. `{"alert_if_price_below_gbp": 200}`.

## Notification format

Keep it source-agnostic and mobile-readable:

- Title and key differentiating spec
- Price vs. comp median (e.g. "£180 — comps at ~£240")
- Why flagged (price, condition, rarity)
- Any caveats
- Link

Keep notification copy source-agnostic — do not name the source platform unless it is genuinely relevant context.

## Rules

- Never alert on the same offer twice — check last evaluation first
- Always explain the decision — no bare links
- If sold-comp data is sparse (fewer than 3 results), note the uncertainty; don't anchor to a single outlier sale
- If criteria_schema for the hunt defines required fields, check they are present; note gaps
- Run-level logging (batch counts, triage summary) goes to `mcp__deal-hunter-db__log_hunt_run`, not the hunt file
