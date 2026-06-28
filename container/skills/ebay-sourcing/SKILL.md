---
name: ebay-sourcing
description: >
  How to find and price-research goods on eBay: which search tools to use and
  what each returns, how to design search terms within the API budget, how to
  discover the right category filter, and how to gather sold/active comparables
  for a price baseline. Use for any hunt whose source is eBay (computers and
  other generic categories) when doing market reconnaissance or building a
  baseline.
---

# eBay sourcing

The playbook for searching and price-researching eBay. It covers the tools, search-term
design, and how to gather comparables. It does not cover recording segments or baseline
prices to the database — `/price-baselining` owns that and applies to every source.

## Search tools

- `mcp__ebay-search__search_ebay` — the search tool to use. It searches all buying formats
  (auction, buy-it-now, best-offer) in parallel and returns a deduplicated set. Use the
  category and condition filters to narrow noisy results.
- `mcp__sold-data__get_sold_prices` — recent sold prices for a search term. This is what
  actually sold, not asking prices.
- `mcp__ebay-api__getItem` — full item specifics and description for one listing (works for
  active and sold/ended items). Use it to understand what drives price differences.
- **Do not use `mcp__ebay-api__search` for discovery** — it returns Buy It Now listings only
  by default, silently excluding auctions and best-offer-only listings.

## Market reconnaissance

When scoping a new requirement, search eBay early with broad terms reflecting the need —
this is reconnaissance, not a formal hunt. Show the user real listings: the product types
common in their budget, the price range, the brands/models that dominate, anything
surprising. Real market data beats stored product knowledge, which goes stale; let the
user's reaction to actual listings drive refinement.

## Search-term design

Each search term costs 3 eBay API calls per poll (one per buying format). Terms run
repeatedly at the hunt's cadence against a daily budget of 5000 calls across all hunts.
Keep terms to the minimum needed:

- eBay search is fuzzy — "lenovo m90q" already returns Gen 1, Gen 2, and Gen 3. You don't
  need a separate term per variant of the same product.
- Overlapping terms waste budget and return mostly the same listings (the DB dedupes, but
  the API calls are still spent).
- Test a term with `mcp__ebay-search__search_ebay` before committing it to a hunt.

## Category filtering

Always set `category_ids` on an eBay hunt so the watcher's searches are filtered to relevant
categories. Without it, "lenovo m90q" also returns rack mounts, VESA brackets, heatsinks,
and accessories. Discover the right category during baselining: look at the `categories`
field on relevant search results (e.g. "PC Desktops & All-in-Ones" = category `179`).

## Gathering comparables for a baseline

1. **Sold prices** — `mcp__sold-data__get_sold_prices` with the hunt's terms. Start broad to
   see the full landscape; use term variations if the product has several names.
2. **Active listings** — `mcp__ebay-search__search_ebay` with the same terms. Note the
   `categories` on relevant results (you need them for `category_ids`).
3. **Scan and filter yourself** — results are noisy (accessories, different models, parts).
   Identify the genuine target product and its variants. Do not compute stats over
   unfiltered results; they mislead.
4. **Inspect representatives** — pick 10-15 listings across sold and active results covering
   the variants and price points, and `mcp__ebay-api__getItem` each to understand what drives
   the price differences (condition, bundled accessories, seller location).

Hand the variants/groupings and the price spread you find to `/price-baselining`, which
records them as segments and baseline prices.

## Notes

- Distinguish sold prices (what `get_sold_prices` returns) from asking prices (active
  listings). Account for condition differences.
- If a tool returns no results or errors, say so — don't guess.
