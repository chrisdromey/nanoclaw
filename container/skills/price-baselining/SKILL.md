---
name: price-baselining
description: >
  Research market pricing for a product category using eBay sold listings.
  Use when starting a new hunt, when the user asks about pricing or market
  conditions, or to refresh a stale baseline. Gates the Sold Data Tool.
---

# /price-baselining — Market Price Research

## When to use

- A new hunt needs its first price baseline
- During early monitoring when the first listings come in and you need to calibrate your value sense
- The user asks what something sells for or whether a price is good
- An existing baseline is stale (>14 days old)

Price baselining can run alongside monitoring — you don't need to complete baselining before enabling the watcher. Start with a rough baseline from your initial market searches during requirements discovery, then deepen it as you see more listings.

**Every hunt needs baselining — no exceptions.** Even if you think you know the market (e.g. "Ryzen 5700X is about £130"), your training data is stale and the market moves. More importantly, the dashboard needs market segments and baseline prices to visualise the hunt — without them, the prices page is empty. A hunt without structured baseline data is broken.

## Orientation

1. Read the hunt file (`references/hunts/{hunt}.md`) — does a Price Research section exist? How old?
2. Check `references/product-knowledge/{product}.md` if it exists
3. If baseline exists and is <14 days old, ask the user before re-researching

## Workflow

### 1. Sold prices search

Call `mcp__sold-data__get_sold_prices` with search terms from the hunt. Start broad — you want to see the full landscape. Use multiple search term variations if the product is known by different names.

### 2. Active listings search

Call `mcp__ebay-search__search_ebay` with the same search terms. This searches across all buying formats (auction, buy-it-now, best-offer) in parallel and returns a deduplicated set. Use the categories and conditions filters to narrow if results are very noisy.

**Note the eBay categories** on relevant results — the `categories` field shows where each item is listed (e.g. "PC Desktops & All-in-Ones" = category 179). You'll need this when enabling monitoring on the hunt — setting `category_ids` filters the watcher's searches to only these categories, avoiding accessories and parts noise.

**Do not use `mcp__ebay-api__search` for discovery** — it only returns Buy It Now listings by default, silently excluding auctions and best-offer-only listings. Always use `mcp__ebay-search__search_ebay` instead.

### 3. Scan and filter

Look through the returned titles and prices yourself. eBay search results are noisy — expect accessories, different models, parts, and irrelevant items mixed in with genuine results. Identify what's actually the target product and what variants exist.

**Do not compute stats over unfiltered results.** They will be misleading.

### 4. Inspect representative listings

Pick 10-15 listings across the sold and active results — cover the variants and price points you've identified. For each, call `mcp__ebay-api__getItem` with the `item_id` to get the full item specifics and description. The Browse API works for both active and sold/ended items.

Use the detail to understand what drives price differences between listings.

### 5. Synthesise and write up

Write your findings to the hunt file's `## Price Research` section as prose. Include:

- Date and search terms used
- What you found, organised by whatever groupings make sense for this product
- What "good value" looks like and what's overpriced
- Any market observations or gotchas you noticed

Write with nuance and caveats — this is reference material for future evaluation sessions, not a data table. Append new sections on refresh, don't overwrite previous research.

If you learned factual product information, also update `references/product-knowledge/{product}.md`.

### 6. Record structured data

After writing prose, record the structured data to the database so the dashboard can visualise it.

**a) Create market segments** — for each variant/grouping you identified, call `create_market_segment`:
- `hunt_id` — the hunt you're researching
- `name` — short descriptive name (e.g. "M90q Gen 1 i5 w/ PCIe", "Budget tier under £150"). Use the **same name** when re-researching to update rather than duplicate.
- `tags` — JSON array of attribute tags that characterise this segment (specs, features, conditions, e.g. `["i5-10500T", "16GB", "DDR4", "SFF"]`)
- `price_low` / `price_mid` / `price_high` — your assessed price tiers based on sold data. Low = good deal territory, mid = fair/typical, high = overpriced.
- `sample_size` — how many data points informed your assessment
- `confidence` — HIGH (20+ consistent data points), MEDIUM (10-20 or some variance), LOW (<10 or highly variable)
- `notes` — any caveats about this segment (e.g. "prices rising due to supply shortage", "watch for missing riser bracket")

**b) Record baseline prices** — for the listings you inspected, call `record_baseline_price`:
- `hunt_id` and `segment_name` (auto-resolves to segment_id)
- `items` array — batch your data points. Each needs: `source_type` (sold/active/auction_completed), `title`, `price`, and optionally `shipping`, `total_landed_gbp`, `condition`, `sold_date`, `source_url`, `source_item_id`, `tags`

Record both sold listings (forms the baseline) and noteworthy active listings (shows current market).

## Rules

- Never quote a single "baseline price" — give ranges with context
- Always note the research date
- Distinguish sold prices (what this tool returns) from asking prices (current listings)
- Account for condition differences
- If the tool returns no results or errors, say so — don't guess
- Always record structured data after prose write-up — the dashboard needs it. A hunt without market segments is a broken hunt.
- Use consistent segment names across research sessions for the same hunt
- Never skip baselining because you think you already know the prices. Your knowledge is stale; eBay sold data is ground truth. Even a "simple" single-product hunt needs segments and baseline prices recorded.
