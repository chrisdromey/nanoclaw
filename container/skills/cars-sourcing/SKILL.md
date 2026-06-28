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
- `mcp__autotrader-search__autotrader_detail` — full spec/feature detail for one listing. Use
  it on a few representatives when you need spec context to explain price differences between
  trims.

There is no sold data for used cars on AutoTrader. Do not use the eBay tools (`sold-data`,
`ebay-search`, `ebay-api`) for cars.

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

## Interpreting AutoTrader pricing

- AutoTrader prices are **asking** prices, not sold. Record baseline comps with
  `source_type: 'active'` and note that they are asking prices.
- AutoTrader's own per-listing `price_tier` (GREAT/GOOD/FAIR/HIGH) is the per-car deal signal
  the evaluator leans on. Your job when sourcing is the cross-trim context: which trims sit
  where, and why (mileage effects, trim premiums, supply).
