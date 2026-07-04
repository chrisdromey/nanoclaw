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

You don't need a *complete* baseline before activating — but you do need **at least one segment**, because activation is gated on it. Start with a rough baseline (even a single broad segment) from your initial market searches during requirements discovery so the hunt can activate, then deepen it as you see more listings.

**Every hunt needs baselining — no exceptions.** A hunt is created as a `draft` and **cannot be
activated (monitored) until at least one market segment exists**: the `manage_hunt action:activate`
gate refuses a hunt with zero segments. Even if you think you know the market, your training data is
stale and the market moves. The dashboard also needs market segments and baseline prices to
visualise the hunt — without them, the prices page is empty. A hunt with no segments stays stuck in
`draft` and never monitors.

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

> **v2 hunts (every hunt created now): prices are DERIVED, never typed.** The price band comes from
> the comps you record, not from your own number. The order is **bucket → record comps → derive**.
> A price you type into a segment is ignored; the band is computed by `recompute_segment_prices` from
> the comps in that segment. (Legacy v1 hunts still accept typed tiers — but prefer the flow below.)

**a) Bucket first.** A price only means something *within a comparable bucket* — not all Polestar 2s
(or all 5900Xs) are the same; trim/pack/spec/condition drive the price. For a **feature-led** hunt,
**read the knowledge base first** and define one segment per trim/variant the KB describes, so your
buckets come from the spec research, not guesswork. Call `create_market_segment`:
- `hunt_id`, and `name` — short, including the product/model **and trim** (e.g. "Leaf N-Connecta",
  "Polestar 2 Long Range (2021-22)"). Preferably start the name with the KB-covered target key.
  Reuse the **same name** when re-researching to update rather than duplicate.
- `tags` — JSON array used to match offers: include the model name **and** trim/attribute tags. The
  tags **MUST include the exact `criteria.targets` key verbatim** (e.g. `"Kia EV6"`, not just
  `"EV6"`) — the activation gate anchors each segment to a researched target through its tags. Check
  `all_hunt_segments` in the response and reuse existing tags exactly.
- `notes` — qualitative caveats (don't put feature *claims* here; those belong in the KB).
- (Don't bother with `price_low/mid/high`/`sample_size`/`confidence` — derived for v2.)

**b) Record real comps into the right bucket** — call `record_baseline_price` with the actual
listings you used:
- `hunt_id` and `segment_name` (resolves to segment_id) — put each comp in the bucket it belongs to.
- `items` array — each needs `source_type` (sold/active/auction_completed), `title`, `price`, and
  **`source_url` + `source_item_id` + `tags` (the comp's observed trim/spec)**. For v2 these three are
  **required in practice**: the gate only counts comps that carry a source reference and a tag — that
  is what proves the comp is a real, deliberately-bucketed listing and not a number from memory.
  Record ≥3 such comps per segment (more is better). Add `total_landed_gbp` where shipping/fees apply.
  For **cars** comps also pass `attributes: {"mileage_num": <miles>, "year": <year>}` — mileage makes
  the comp usable in the depreciation-trend fit.

**c) Derive the band** — call `recompute_segment_prices` (`hunt_id`, optional `segment_id`). It
computes p25/median/p75 of the sourced comps and sets the segment's low/mid/high, sample size and
confidence. It also returns the **within-segment spread**: if it warns the spread is too wide, your
bucket is **mixing trims/packs** — split it into tighter segments and re-record. Re-run after adding
comps.

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
- **v2 hunts: never type a price band — derive it.** Record sourced, tagged comps and run `recompute_segment_prices`. A segment with fewer than 3 sourced+tagged comps will block activation.
- **A wide within-segment spread is a bucketing error, not a wide market.** If `recompute_segment_prices` flags it, split the segment by trim/pack — don't lower your standards to one big bucket.
