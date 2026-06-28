---
name: price-baselining
description: >
  Research market pricing for a hunt and record it as structured market segments
  and baseline prices in the database. Use when starting a new hunt, when the user
  asks about pricing or market conditions, or to refresh a stale baseline.
---

# /price-baselining — Market Price Research

This skill owns the **recording contract** — turning market research into market segments and
baseline prices in the database, the same way for every vertical. *How* you gather the
comparables is source-specific and lives in the vertical's `sourcing_skill` (from
`mcp__deal-hunter-db__get_vertical`); follow that to acquire the data, then record it here.

## Delegation

When this skill is triggered from an interactive chat session (user message, not a scheduled task), delegate to the `market-researcher` sub-agent instead of doing the work inline. This keeps the chat context lean.

1. Gather context: hunt ID/name, what to research, any specific products or terms
2. Delegate to `market-researcher` with that context
3. Relay the returned summary to the user

Do NOT delegate when:
- You ARE the `market-researcher` sub-agent (this skill was preloaded via `skills`)
- This is a scheduled/watcher invocation (`[SCHEDULED TASK]` or `[WATCHER]` prefix in prompt)

## When to use

- A new hunt needs its first price baseline
- During early monitoring when the first listings come in and you need to calibrate your value sense
- The user asks what something sells for or whether a price is good
- An existing baseline is stale (>14 days old)

Price baselining can run alongside monitoring — you don't need to complete baselining before enabling the watcher. Start with a rough baseline from your initial market searches during requirements discovery, then deepen it as you see more listings.

**Every hunt needs baselining — no exceptions.** Even if you think you know the market, your training data is stale and the market moves. More importantly, the dashboard needs market segments and baseline prices to visualise the hunt — without them, the prices page is empty. A hunt without structured baseline data is broken.

## Orientation

1. Read the hunt file (`references/hunts/{hunt}.md`) — does a Price Research section exist? How old?
2. `mcp__deal-hunter-db__get_vertical` for the hunt's vertical — its `sourcing_skill` (how to
   gather comps and what segmentation suits the source) and `knowledge_base_path` (reference
   material to read before segmenting).
3. If a baseline exists and is <14 days old, ask the user before re-researching.

## Acquire comparables

Follow the vertical's `sourcing_skill`. It tells you which tools to use, how to search, and
how to segment for that source — and hands back the variant/trim groupings and price spreads
you'll record below. Read any knowledge base the vertical declares before segmenting, so your
segment names and tags match the way the evaluator identifies offers.

## Record structured data to the database

This is the authoritative source for price tiers — the dashboard and evaluation agent both read from here. Do not duplicate price tier numbers in the hunt markdown file.

**a) Create market segments** — for each variant/grouping you identified, call `create_market_segment`:
- `hunt_id` — the hunt you're researching
- `name` — short descriptive name including the product/model (e.g. "Ryzen 9 5900X used", "Leaf N-Connecta"). The name is used for offer-to-segment matching alongside tags. Use the **same name** when re-researching to update rather than duplicate.
- `tags` — JSON array of tags used to match offers to this segment. Include **both** the product/model name (so offer titles match) **and** attribute tags for filtering/consistency. Check `all_hunt_segments` in the response to see existing tags and reuse them exactly — e.g. if other segments use `"ECC-confirmed"`, use that, not `"ECC"` or `"ECC-support"`.
- `price_low` / `price_mid` / `price_high` — your assessed price tiers. Low = good deal territory, mid = fair/typical, high = overpriced.
- `sample_size` — how many data points informed your assessment
- `confidence` — HIGH (20+ consistent data points), MEDIUM (10-20 or some variance), LOW (<10 or highly variable)
- `notes` — caveats about this segment (e.g. "prices rising due to supply shortage")

**b) Record baseline prices** — for the listings you used, call `record_baseline_price`:
- `hunt_id` and `segment_name` (auto-resolves to segment_id)
- `items` array — batch your data points. Each needs: `source_type` (sold/active/auction_completed), `title`, `price`, and optionally `shipping`, `total_landed_gbp`, `condition`, `sold_date`, `source_url`, `source_item_id`, `tags`. Record the data points that form the baseline plus any noteworthy current listings.

## Write context to the hunt file

Write market observations to the hunt file's `## Price Research` section — but **not** price tier numbers (those live in the DB segments). Focus on:

- Date and search terms used
- Market observations: supply trends, seasonal patterns, seller types, gotchas
- What drives price differences between listings
- Risks or caveats the evaluation agent should know about

Append new sections on refresh, don't overwrite previous research. If you learned factual product information, also update the vertical's knowledge base.

## Rules

- Never quote a single "baseline price" — give ranges with context
- Always note the research date
- Distinguish sold prices from asking prices; account for condition differences
- If a tool returns no results or errors, say so — don't guess
- **Price tiers live in DB segments only** — do not duplicate price_low/mid/high numbers in the hunt markdown file. The hunt file is for qualitative context.
- **Tag consistency is critical** — check `all_hunt_segments` in the `create_market_segment` response before creating new segments. Reuse existing tags exactly.
- Always include the product/model name in tags — tags drive offer-to-segment matching on the dashboard.
- Use consistent segment names across research sessions for the same hunt.
- Never skip baselining because you think you already know the prices. Your knowledge is stale; live market data is ground truth.
