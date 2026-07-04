---
name: listing-evaluation
description: >
  Evaluates computer-hardware listings (eBay sold-comp methodology, condition grading,
  auction-end-time urgency). The evaluator for the `computers` vertical.
  Use when the watcher finds new offers, when the user shares a listing
  link, when reassessing a watched offer after a price or status change,
  or when asked whether a specific deal is good value.
---

# /listing-evaluation — Evaluate Offers

## Delegation

Evaluation ALWAYS runs in the `deal-evaluator` sub-agent — scheduled/watcher runs and interactive chat alike. The orchestrator (main session) does not have the batch-triage tools (`get_hunt_summary`, `list_offers`, `record_evaluation`, `batch_dismiss`, `update_offer`), so delegation is the only path; it also keeps the long-lived main context lean, which is the point — inline triage was the biggest token sink on record.

1. Gather context: hunt ID, what to evaluate (new offers / specific listing / broad check), and the batch size if the notification announced one ("X of Y pending — triage only these X")
2. Delegate to `deal-evaluator` with that context (one Task per hunt; parallel Tasks for multiple hunts)
3. Relay the returned summary to the user, then call `log_hunt_run`

The ONLY time you follow the evaluation procedure below yourself is when you ARE the `deal-evaluator` sub-agent (this skill was preloaded via `skills`). For a trivial single-offer question in chat, `get_offer` / `get_offer_history` are available to the orchestrator — use those instead of spawning an evaluator.

## When to use

- Watcher found new offers (event-driven invocation)
- Price changed on a watched offer (event-driven invocation)
- Auction countdown threshold crossed on a watched offer (24h, 12h, or 6h)
- The user shares a listing link and asks "is this any good?"
- Daily review finds status changes worth investigating

## Orientation

1. `mcp__deal-hunter-db__get_hunt_summary` — get hunt criteria, market segments (with price tiers and tags), watched offers, and health warnings. The `market_segments` field is your authoritative source for price tiers — use price_low/mid/high to assess value.
2. Read the hunt file (`references/hunts/{hunt}.md`) — market context, strategy notes, qualitative observations (not price tiers — those come from segments above)
3. Read `references/preferences.md` — general buying preferences
4. Check past evaluations and user feedback for similar items
5. Read `references/research/{hunt-name}/` if it exists — deep dive research files may have spec details or compatibility notes relevant to evaluation

## Finding offers

Use `mcp__ebay-search__search_ebay` to find active listings. This searches across all buying formats (auction, buy-it-now, best-offer) in parallel and deduplicates the results. The response is triage-weight — titles, prices, condition, seller, categories — enough to decide which listings deserve a closer look.

**Do not use `mcp__ebay-api__search` for discovery** — it only returns Buy It Now listings by default, silently excluding auctions and best-offer-only listings.

For full item details (specs, description, seller history), call `mcp__ebay-api__getItem` with the `item_id` from the search results.

## Workflow

### Triage first

Work like a person scanning search results — you don't click every listing. Use `mcp__deal-hunter-db__list_offers` to fetch slim triage rows (title, price, condition, status) and read through them. You can often tell from the title alone whether something is worth a closer look. Use `batch_dismiss` to clear the obvious mismatches in one call, then use `get_offer` to dive deeper on what's left.

### Then evaluate

For each remaining offer:

1. **Check if previously evaluated** — `mcp__deal-hunter-db__get_offer` for full details + last evaluation. Use `get_offer_history` if you need price trends. If nothing changed, skip.
2. **Calculate true landed cost** — item + shipping. Non-UK sellers: add duty + 20% VAT.
3. **Evaluate against criteria and baseline** — does it meet requirements? How does the price compare to what you know from the hunt file's price research?
4. **Assess urgency** — auction ending soon is urgent, stable BIN is not.
5. **Decide** — ALERT (good match at good value), WATCH (interesting but not quite right), or SKIP (overpriced, poor match).
6. **Record** — `mcp__deal-hunter-db__record_evaluation`, and `record_alert` if alerting.
7. **If WATCH** — enable offer monitoring by calling `mcp__deal-hunter-db__update_offer` with `watching: true` and `watch_conditions` JSON. The background watcher polls watched offers every 2 hours and triggers an urgent agent invocation when conditions are met. Example conditions:
   - `{"alert_if_price_below_gbp": 150}` — price drops below threshold
   - `{"max_price": 200}` — price at or below maximum
   - The watcher alerts at graduated thresholds when a watched auction has 24h, 12h, or 6h remaining. Offer removals/endings are picked up in the daily review via `status_changes`.

## Alert format

Keep it concise and actionable — the user may be reading on mobile:
- What it is and key specs
- Total landed cost with breakdown
- Why you flagged it — how it compares to the baseline
- Any trade-offs or caveats
- Urgency context if applicable
- Link

## Learning from evaluations

Every listing you evaluate is market intelligence. As you evaluate, notice:

- Products appearing frequently that aren't in the hunt's search terms — consider adding them
- Price patterns that differ from your baseline — update your mental model and the hunt file
- Specs or features you didn't expect — might warrant research or criteria adjustment
- Whole categories or brands you're seeing that weren't on the radar
- Products the user keeps rejecting — understand why and tighten criteria to filter them out
- Cheaper or simpler products that meet the actual need — the hunt criteria may be over-specced. If you keep skipping products that would solve the user's problem at lower cost because they don't match a stated spec, question whether that spec is justified.

When patterns emerge, act on them: add search terms, adjust criteria, update the hunt file's strategy notes, trigger /research for unfamiliar products. Don't just evaluate listings in isolation — use them to make the hunt smarter over time.

Run-level logging (what you evaluated, counts, observations about this batch) goes to `log_hunt_run`, not the hunt file. The hunt file is for durable reference material (strategy notes, notable findings) that you update in-place.

## Rules

- Always show true landed cost, not just listing price
- Always explain why — never just dump a link
- Never alert on the same offer twice (check evaluations first)
- For auctions, note bid count — 0 bidders is very different from 12
- If unsure about a spec detail, say so
- If you encounter a product you have no knowledge about, don't guess — check `references/product-knowledge/` and `references/research/`. If nothing exists, note the gap and consider triggering /research during the next daily review.
