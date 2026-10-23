---
name: cars-sourcing
description: >
  How to find and price-research used cars on AutoTrader: gathering comparable
  listings, segmenting by model and trim, and interpreting AutoTrader's asking
  prices and per-listing price tier. Use for any hunt whose source is AutoTrader
  when doing market reconnaissance or building a baseline.
---

# Cars sourcing

The playbook for searching and price-researching used cars on AutoTrader. It covers the
tools, how to segment by trim, and how to read AutoTrader's pricing. It does not cover
recording segments or baseline prices to the database — `/price-baselining` owns that and
applies to every source.

Cars are bought by *feature*, and features live at different trims, packs and model years.
Which trims/years carry a buyer's must-haves is reference knowledge built and maintained by
`/car-spec-research` and stored per model. Read the model's knowledge base before sourcing so
you know which trims matter to the brief; if a candidate model has none, build it via
`/car-spec-research` first.

## Search tools

- `mcp__autotrader-search__autotrader_search` — comparable listings for a make/model with
  the hunt's year/mileage/price/fuel/transmission and postcode. Listing titles and subtitles
  carry the derivative (trim) string, so you can group results by trim.
  - **Model names are exact AutoTrader enum strings, not the obvious name.** Most makes use the
    short name (`A4`, `3 Series`, `Focus`), but some are make-prefixed — e.g. Polestar's model
    is `Polestar 2` (and `Polestar 3`), **not** `2`. A wrong model string returns **zero** results
    silently (it looks identical to "none in budget"), so don't conclude a car is unavailable from
    an empty model search. If a make+model search returns 0, re-run it **make-only** and read the
    exact model string off the returned listings, then retry with that value. The tool also flags
    this for you: an empty model search that has make-only listings comes back with a
    `model_mismatch_warning`. Use the confirmed exact string when you set `criteria.targets.*.model`.
- `mcp__autotrader-search__autotrader_detail` — full spec/feature detail for one listing. Use
  it on a few representatives when you need spec context to explain price differences between
  trims.

There is no sold data for used cars on AutoTrader. Do not use the eBay tools (`sold-data`,
`ebay-search`, `ebay-api`) for cars.

## What the search can filter vs what the evaluator judges

AutoTrader (and therefore the hunt's monitoring search) can only filter on **make, model, year,
price, mileage, fuel, transmission, postcode**. It **cannot** filter on features, trims, packs,
or "must not be X" rules — those are read off each returned listing by the evaluator. So the
monitoring search is a **wide net**: it pulls every car of the right make/model/budget and the
evaluator triages spec afterward. When you shape a hunt, this is the split to respect — the
searchable constraints go in `criteria.shared`/`criteria.targets`; feature/trim/reject intent
goes in `criteria.intent` for the evaluator. Don't try to narrow the net with things the search
can't express (e.g. "must have adaptive cruise"); that belongs in `intent`, and over-narrowing
the search just hides good cars whose listings are vaguely worded.

## Segmenting by model + trim

An S Line commands a different price from an SE, so each trim is its own segment. For each
trim that matters to the brief:

1. Gather comparables with `mcp__autotrader-search__autotrader_search` (same make/model; the
   hunt's year/mileage/price/fuel/transmission; the hunt postcode).
2. Group the results by trim using the derivative string in the title/subtitle.
3. The spread of current asking prices within a trim gives that segment's low/mid/high.

Hand these per-trim segments (name like "{Model} {Trim}", e.g. "Leaf N-Connecta"; tags
including model + trim tokens, e.g. `["leaf","n-connecta"]`; the price spread; and a
confidence reflecting how many comps you found) to `/price-baselining`, which records them.

Watch for segment pairs that differ only by a token AutoTrader omits on the default
variant — drivetrain is the common case: AWD cars say "AWD" in the subtitle but RWD/FWD
cars usually carry no drivetrain token at all, so tags alone can't separate "GT-Line RWD"
from "GT-Line AWD" on an RWD listing. When you create such a pair, set the
`filter_patterns` argument of `create_market_segment` (require the token on the labelled
segment, exclude it on the default one — the tool description has the exact shape).

## Interpreting AutoTrader pricing

- AutoTrader prices are **asking** prices, not sold. Record baseline comps with
  `source_type: 'active'` and note that they are asking prices.
- AutoTrader's own per-listing `price_tier` (GREAT/GOOD/FAIR/HIGH) is the per-car deal signal
  the evaluator leans on. Your job when sourcing is the cross-trim context: which trims sit
  where, and why (mileage effects, trim premiums, supply).
