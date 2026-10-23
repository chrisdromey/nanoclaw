---
name: car-listing-evaluation
description: Evaluates car listings from AutoTrader and similar sources, using the AT price-tier as the primary deal signal and mileage/year/spec comparables for confirmation.
allowed-tools: mcp__deal-hunter-db__*, mcp__autotrader-search__*
---

# /car-listing-evaluation — Cars Vertical Evaluator

T3 (bespoke) evaluator for the `cars` vertical. Uses the AutoTrader price-tier signal as the primary deal indicator, with spec-comparable search for confirmation.

## The search is a coarse net — you do the real filtering

The watcher's search is a **wide net, not a precise match.** It can only filter on what
AutoTrader has filters for: **make, model, year, price, mileage, fuel, transmission, postcode**
(the hunt's `criteria.shared` + `criteria.targets`). Every other requirement in the brief —
**must-have features, trim/pack minimums, reject rules, per-model notes** — lives in
`criteria.intent` and was **NOT** applied by the search. Assume the offers you're handed include
plenty of cars that clear budget and model but fail the brief on spec. Triaging them against
`intent` is *your* job; the search deliberately over-returned so you wouldn't miss a good car
hiding behind a vague listing. Do not treat a returned listing as "already a match".

## Delegation

Evaluation ALWAYS runs in the `cars-evaluator` sub-agent — scheduled/watcher runs and interactive chat alike. The orchestrator (main session) does not have the batch-triage tools (`get_hunt_summary`, `list_offers`, `record_evaluation`, `batch_dismiss`, `update_offer`) or `autotrader-search`, so delegation is the only path; it also keeps the long-lived main context lean, which is the point — inline triage was the biggest token sink on record.

1. Gather context: hunt ID, what to evaluate (new offers / specific listing / broad check), and the batch size if the notification announced one ("X of Y pending — triage only these X")
2. Delegate to `cars-evaluator` with that context (one Task per hunt; parallel Tasks for multiple hunts)
3. Relay the returned summary to the user, then call `log_hunt_run`

If the model has no trim/feature knowledge base and the brief is feature-led, the KB is built by the `market-researcher` sub-agent (via the `car-spec-research` skill) — flag the gap and route there before evaluating, rather than guessing trim/feature facts.

The ONLY time you follow the evaluation procedure below yourself is when you ARE the `cars-evaluator` sub-agent (this skill was preloaded via `skills`). For a trivial single-offer question in chat, `get_offer` / `get_offer_history` are available to the orchestrator — use those instead of spawning an evaluator.

## When invoked

- Watcher found new offers for a `cars` hunt
- Price changed on a watched car listing
- User asks to evaluate a specific car listing

## Orientation

1. `mcp__deal-hunter-db__get_hunt_summary` — hunt criteria, market segments, watched offers.
   Cars criteria has three zones: `shared` (hunt-wide searchable: postcode/budget/mileage/fuel),
   `targets` (per-model searchable: make/model/year, keyed by search term), and **`intent`** —
   the evaluator-only requirements (`must_have`, `nice_to_have`, `reject`, `notes_by_model`,
   `purpose`). **Read `intent` first** — it is the spec the search could not enforce and the
   yardstick for every ALERT/WATCH/SKIP. (Older hunts may store a flat criteria object instead;
   fall back to the hunt markdown for must-haves there.)
2. Read `references/hunts/{hunt}.md` — strategy notes, the brief's must-have features, known good examples, rejection patterns
3. Read the model's trim knowledge base, `references/product-knowledge/cars/{make}-{model}.md`, if it exists — the trim ladder, feature-by-trim matrix, and the "verify on a listing" cues. This is your reference for mapping a listing to its trim and confirming features. If a candidate model has no KB and the brief turns on features, flag it — `/car-spec-research` should build one rather than you guessing.
4. Read `references/preferences.md` if it exists — buyer preferences (e.g. private-only, service-history requirements, colour avoidance)

## Progressive disclosure — how to spend context

Work in two passes so you never pull everything into context at once:
1. **Triage cheaply** from the slim search rows (`list_offers`) — bin the obvious misfits on the free text alone.
2. **Open the survivors** with `autotrader_detail` to get the deal signal + equipment, then decide.

Most listings should be resolved in pass 1 — only the genuinely promising ones cost you a detail fetch and the context that comes with it.

## Step 1 — Triage from the search row (no detail fetch)

`mcp__deal-hunter-db__list_offers` returns slim rows built for fast triage. For cars the signal is in the free text — read it like a person scanning a results page:
- `title` — usually just make + model (e.g. "Audi A4")
- `sub_title` — engine, **trim**, gearbox, body (e.g. "2.0 TFSI S line S Tronic … 4dr")
- `attention_grabber` — the seller's free-text highlights, often naming exact extras (e.g. "2OWNERS+PARKAID+CRUISE+SAT-NAV", "Virtual Cockpit|Heated Seats")
- `price`, `year`, `distance_miles`

The free text is messy and inconsistent — that's fine, use your judgement (this is exactly what you're good at). `mcp__deal-hunter-db__batch_dismiss` the obvious misfits: anything matching `intent.reject`, wrong trim/variant for the brief, wrong body style, too old, over budget, too far with no collection plan. Apply `intent.notes_by_model[<this term>]` here too — it carries the per-model trim/pack guidance for exactly the model this row is. Don't open a detail page to reject something you can already tell is wrong from the row.

`price_tier` is usually absent at this stage (it lives on the detail page) — it is NOT the triage signal here; you'll get it in Step 2. Keep every listing that plausibly fits the brief and could be a good buy.

## Step 2 — Open the survivors (`autotrader_detail`)

For each survivor, call `mcp__autotrader-search__autotrader_detail` (advert id or url). One fetch returns everything you need to decide, and it's **cached** — re-opening the same listing on a later run won't re-hit AutoTrader (pass `fresh: true` only when you need an up-to-the-minute price/state, e.g. re-checking a watched listing):
- `priceTier` / `priceTierLabel` — AutoTrader's deal rating; your primary price signal
- `mileage`, `year`, `fuel`, `transmission`, `bodyType`, `seats`, `owners`
- `features` — categorized equipment, each Standard/Optional (used in Step 2b)
- `specs` — boot space, dimensions, BHP, MPG; `description` — seller free text

(If a previous run already persisted this onto the offer, `get_offer` may hold it in `attributes` — glance there first to skip a redundant fetch.)

Assess the price signal:

| Tier | Meaning | Lean |
|------|---------|------|
| `GREAT` | Great price | strong alert candidate |
| `LOW` | Lower price | alert candidate — check why (mileage? history?) |
| `GOOD` | Good price | worth it if the spec/features are right |
| `FAIR` | Fair price | skip unless exceptional spec |
| `HIGH` | High price | skip unless a very specific need |
| `null` / `NOANALYSIS` | no AT rating | lean on the comp search (Step 3) |

Red flags that pull a deal back to WATCH or SKIP:
- Mileage high for age (rough guide >~15k/year — scale to the car, not a hard cutoff)
- TRADE seller with no service history mentioned
- Very far for a private purchase with no collection plan
- `GREAT` price but high mileage — the price may just reflect the mileage, not a deal

## Step 2b — Verify the brief's must-have features

Cars are bought by feature, not trim name. When the hunt brief lists must-have features (e.g. adaptive cruise, lane-keep, ISOFIX), confirm THIS specific car has them — a great price on the wrong spec is not a deal.

The evidence is the `features` list from the `autotrader_detail` call you already made in Step 2 — the car's equipment, grouped by category (e.g. "Drivers Assistance") with each item tagged **Standard** or **Optional** (plus the `description` and `specs` from the same response). If for some reason you skipped Step 2 for this offer, fetch it now with `mcp__autotrader-search__autotrader_detail`.

For each must-have feature:

1. Search the car's `features` (and the `description`/`specs`) for it. Feature names vary by manufacturer — **match on meaning, not exact string**: e.g. "adaptive cruise" ≈ "Adaptive Cruise Control" ≈ "ProPilot" ≈ "Smart Cruise Control"; "lane assist" ≈ "Lane Departure Warning"/"Lane Keep Assist". The model KB's "verify on a listing" notes tell you what each model calls it.
2. Resolve a verdict:
   - **Present** (listed as Standard, or Optional-and-listed) → satisfied → record verdict `verified`.
   - **Absent from the equipment list** → AutoTrader lists fitted optional extras, so absence is meaningful. On a car where the KB says this feature is at best optional, treat absence as NOT fitted → record verdict `contradicted`. SKIP if it's a hard must-have (unless the user has relaxed it).
   - **Can't tell** (no features data even after `autotrader_detail`, or genuinely ambiguous) → do not assume → record verdict `unverified`. WATCH with a note to confirm, or ALERT with an explicit caveat (e.g. "ACC not shown in AT's feature list — confirm with the seller").
3. Cross-check against the trim: map the derivative string (title/subTitle, e.g. "2.0 TDI S Line") to the KB trim ladder. If the equipment list contradicts the expected trim, trust the equipment list (individual cars carry factory options above their trim) but note the discrepancy.
4. **Record the verdicts** as `requirement_checks` on the `record_evaluation` call in Step 4 — one entry per must-have: `{requirement, verdict, evidence}`. Quote the `must_have` strings **verbatim** (same exact-string rule as `record_claim_verification` — a paraphrase satisfies nothing), and put the specific equipment-list entry (or its meaningful absence) in `evidence`. Checks against `nice_to_have` entries are welcome too — they're recorded but never enforced.

Honest uncertainty beats a confident guess — flagging "couldn't confirm" IS the value. If the model has no KB, say so and recommend `/car-spec-research`; don't improvise trim/feature facts from memory.

## Step 3 — Comparable search (for NOANALYSIS or when confirming a GREAT/LOW find)

Use `mcp__autotrader-search__autotrader_search` to find comparable listings:

- Same make and model
- Year range: offer year ± 2
- Mileage range: offer mileage ± 15,000
- Same fuel type and transmission if specified in criteria

Compare the offer's price against the comp set median. A deal is:
- meaningfully below the comp median — scale to the car's value rather than a flat number (a £500 saving is significant on a £4k car and noise on an £18k one; as a rough guide ~5%+ or £1,000+ on a typical car), OR
- price_tier GREAT or LOW with reasonable mileage (no major red flags)

Treat the mileage and distance figures in Step 2 the same way — they're rough defaults, not hard cutoffs. Use judgment for the specific car and the user's stated tolerances.

If comp search returns fewer than 3 results, note the thin market — don't anchor to one outlier.

## Step 4 — Decide and record

For each offer:

- **ALERT** — clear deal: GREAT/LOW tier with no red flags, OR comp median confirms £1k+ saving
- **WATCH** — promising but needs monitoring: e.g. GOOD tier, right spec, might drop; or NOANALYSIS but price seems right
- **SKIP** — overpriced, wrong spec, too far, high mileage for price

Record: `mcp__deal-hunter-db__record_evaluation` for every decision, passing the Step 2b verdicts as `requirement_checks`. On a feature-led hunt, **ALERT requires a check for every `must_have` entry** and is refused if any is `contradicted` — a failed hard requirement is a skip, not an alert. `unverified` is allowed on an alert, but the caveat must appear in the alert message.

For ALERT: also call `mcp__deal-hunter-db__record_alert`.

For WATCH: call `mcp__deal-hunter-db__update_offer` with `watching: true` and `watch_conditions`. Canonical keys (anything else is ignored by the watcher): `alert_if_price_below_gbp` (number), `max_price` (number). E.g.:
```json
{"alert_if_price_below_gbp": 12000}
```
`verify_required` (the unverified must-haves) is auto-populated on the offer by `record_evaluation` when you watch with unverified checks — don't hand-write it, and don't stash free-text notes in `watch_conditions` (notes belong in `reasoning`).

## Notification format

**You compose the alert message string yourself** and pass it as the `message_sent` argument to `record_alert` — that tool stores exactly the text you give it (it has no formatter; the host-side cars formatter only runs on the watcher's own notification path, not on agent-recorded alerts). Don't leave a stub expecting something downstream to render it.

Compose a single headline line in this shape, filling the fields from the offer:

```
{year} {make} {model} {trim} · {mileage_short} · £{price} (AT: {tier_label}) · {location_short} · {seller_type} · {link}
```

Example: `2018 Audi A4 2.0 TDI SE · 67k mi · £14,995 (AT: Great price) · LE3 · trade · [link]`

If `price_tier` is null (NOANALYSIS), drop the `(AT: …)` segment rather than printing a blank tier.

After the headline, add 1–2 sentences of human context (keep it mobile-readable):
- Why flagged (e.g. "comp median £16.2k, this is £1.2k under")
- Any caveat worth knowing (e.g. "private seller, 4 previous owners")

## Rules

- Never alert on the same offer twice — check `get_offer` for existing evaluations
- The price-tier is a signal, not gospel — always sanity-check with at least one other data point (comp search or mileage assessment)
- Private sellers may have negotiation headroom; trade dealers less so — note this when alerting
- Run-level logging (how many triaged, how many alerted, notable patterns) goes to `mcp__deal-hunter-db__log_hunt_run`, not the hunt file
- If the hunt file specifies known rejection patterns (e.g. "no automatics above 100k miles"), apply them during triage
