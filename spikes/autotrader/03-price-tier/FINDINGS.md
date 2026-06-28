# AutoTrader Price-Tier Discovery — Findings

## TL;DR

The price-tier signal is **NOT available on the `SearchListing` type** returned by the `/at-gateway` GraphQL search endpoint. AT uses two separate type systems: the search endpoint exposes `SearchListing` (no price-tier field), while the `Advert` type (used by SEO and detail pages) carries `priceIndicatorRating`/`priceIndicatorRatingLabel`. **Decision: HTTP-with-detail-enrichment** — fetch `/car-details/<advertId>` for each candidate and extract price tier from the SSR'd `window.__staticRouterHydrationData` JSON blob.

---

## Investigation log

### 1. Apollo state inspection (spike #1 SEO page)

`seo-search-audi-a4-filtered.apollo.json` contains results from a different GraphQL operation using the `Advert` type. That type carries:

- `priceIndicatorRating` — enum: `"GREAT"`, `"GOOD"`, `"NOANALYSIS"` (and `"LOW"`, `"HIGH"`)
- `priceIndicatorRatingLabel` — human string: `"Great price"`, `"Good price"`, `""`

Confirmed with data, e.g. `{ priceIndicatorRating: "GREAT", priceIndicatorRatingLabel: "Great price", price: 4999 }`. This told us the field exists in AT's schema but on a different type than the search endpoint exposes.

### 2. Speculative field requests against `/at-gateway` `SearchListing`

All speculative field requests returned `400 GRAPHQL_VALIDATION_FAILED`. Key error messages:

| Field attempted | Error |
|-----------------|-------|
| `priceIndicatorRating` | `Cannot query field "priceIndicatorRating" on type "SearchListing".` |
| `priceIndicatorRatingLabel` | `Cannot query field "priceIndicatorRatingLabel" on type "SearchListing".` |
| `priceIndicator` | `Cannot query field "priceIndicator" on type "SearchListing".` |
| `priceRating` | `Cannot query field "priceRating" on type "SearchListing".` |
| `dealRating` | `Cannot query field "dealRating" on type "SearchListing". Did you mean "dealerLink"?` |
| `valuation` | `Cannot query field "valuation" on type "SearchListing".` |
| `priceLabel` | `Cannot query field "priceLabel" on type "SearchListing". Did you mean "price"?` |

AT's error messages suggest alternatives when the guess is close — the absence of any suggestion for `priceIndicatorRating` confirms the field genuinely does not exist on `SearchListing`.

### 3. Introspection

Disabled in production:
> "GraphQL introspection is not allowed by Apollo Server, but the query contained `__schema` or `__type`."

### 4. Detail-page extraction

Fetched `GET /car-details/202605282783235` (a "Lower price" listing). The SSR'd page contains `window.__staticRouterHydrationData = JSON.parse("...")` (AT has migrated the FPA to React Router with server-side loader data — no longer Apollo state). After double JSON.parse, the full advert model is at:

```
loaderData["car-details"].aggregatorAdvert.heading.priceIndicator       → "LOW"
loaderData["car-details"].aggregatorAdvert.heading.priceIndicatorLabel  → "Lower price"
loaderData["car-details"].aggregatorAdvert.trackingContext.priceIndicatorContext → {
  rating: "low",
  ratingLabel: "Lower price",
  deviation: -1732   // £ below market average (bonus signal)
}
```

Observed enum values (from Apollo state + detail page combined):
`"GREAT"` / `"GOOD"` / `"LOW"` / `"HIGH"` / `"NOANALYSIS"`

---

## Recommendation

**HTTP-with-detail-enrichment.** No Puppeteer needed.

Architecture:
1. **Search**: `POST /at-gateway` with existing `SearchResultsListingsGridQuery` — get 20 listings with `advertId`, `price`, `title`, `vehicleLocation`, `sellerType`, `fpaLink`, etc.
2. **Filter in-process**: apply price / distance / seller-type cuts to select top-N candidates.
3. **Enrich**: `GET /car-details/<advertId>` per candidate — extract price tier + mileage + fuel + transmission + deviation from `window.__staticRouterHydrationData`.
4. **Rate-limit**: 6s±30% jitter across all requests (search + detail pages share the budget).

For typical hunts (5–10 candidates), this adds 5–10 extra GETs per poll cycle. At ~3 hunts and ≤10 candidates each polling once per hour, well within 1 req/min.

---

## Field/selector spec

### GraphQL search query — no change

The search query is unchanged. `SearchListing` does not carry price tier; do not add those fields.

### Detail-page extraction (Node.js)

```js
// Regex to pull window.__staticRouterHydrationData off any /car-details/<id> page
function extractDetailData(html) {
  const m = html.match(
    /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("([\s\S]*?)"\);/
  );
  if (!m) return null;
  const data = JSON.parse(JSON.parse('"' + m[1] + '"'));

  const advert   = data?.loaderData?.['car-details']?.aggregatorAdvert;
  const heading  = advert?.heading;
  const trackCtx = advert?.trackingContext;

  return {
    // Price tier — primary deal signal
    priceIndicator:      heading?.priceIndicator,        // "LOW"|"GREAT"|"GOOD"|"HIGH"|"NOANALYSIS"
    priceIndicatorLabel: heading?.priceIndicatorLabel,   // "Lower price"|"Great price"|etc.
    deviation:           trackCtx?.priceIndicatorContext?.deviation, // £ below (<0) or above (>0) avg

    // Spec fields not in search response
    mileage: heading?.headingPills?.find(p => /miles/.test(p.label))?.label, // "55,010 miles"

    // Price details
    priceFormatted: heading?.priceBreakdown?.price?.priceFormatted, // "£10,989"
    priceNumeric:   heading?.priceBreakdown?.price?.price,          // 10989
    priceDeviation: heading?.priceBreakdown?.price?.deviation,      // "£1,732 below market average"
  };
}
```

**Fallback** if `__staticRouterHydrationData` is absent (e.g. page structure changes):

```js
// Price tier enum from SVG gauge title
const svgTitle = html.match(
  /data-testid="price-indicator-gauge"[\s\S]{0,2000}?<title>([\w]+)<\/title>/
)?.[1]; // "LOW" | "GREAT" | "GOOD" | "HIGH"
```

The CSS classes on the rendered badge (`sc-1n64n0d-9 gjLVgM`) are hashed and should NOT be used as selectors.

---

## Rate-limit observations

5 sequential requests at 6s base ±30% jitter (actual intervals: 4920ms, 5322ms, 7584ms, 5939ms):

| Request | Status | cf-mitigated | Notes |
|---------|--------|--------------|-------|
| 1 | 200 | none | — |
| 2 | 200 | none | — |
| 3 | 200 | none | — |
| 4 | 200 | none | — |
| 5 | 200 | none | — |

Zero throttling, zero `cf-mitigated` headers across all 10 total requests in this spike (4 probes + 1 detail page + 5 rate-limit). The 6s±30% envelope is **confirmed safe**. Even the minimum actual interval (4.9s) caused no issues, consistent with spike #1's 4–5s baseline.

**Recommended backoff**: none needed at this volume. Log any 429 or `cf-mitigated: detected` response and increase to 15s+jitter on first occurrence.

---

## Evidence

Files in `/opt/nanoclaw/spikes/autotrader/03-price-tier/`:

| File | Description |
|------|-------------|
| `probe-price-tier.mjs` | Main probe: speculative fields + rate-limit validation |
| `probe-detail-page.mjs` | Detail page extractor and pattern analysis |
| `samples/01-price-indicator-scalar.body.txt` | 400: priceIndicatorRating not on SearchListing |
| `samples/02-price-indicator-object.body.txt` | 400: priceIndicator nested object not on SearchListing |
| `samples/03-alt-field-names.body.txt` | 400: priceRating/dealRating/valuation/priceLabel not on SearchListing |
| `samples/04-introspect-search-listing.body.txt` | Introspection disabled error |
| `samples/05-rate-limit-{1-5}.body.txt` | 5x 200 at 6s±30% jitter — no throttling |
| `samples/06-detail-page.html` | SSR detail page for advertId 202605282783235 |
| `samples/summary.json` | Machine-readable probe summary |

Relevant from spike #1:
- `../01-http-direct/samples/seo-search-audi-a4-filtered.apollo.json` — Apollo state confirming `priceIndicatorRating`/`priceIndicatorRatingLabel` on `Advert` type
