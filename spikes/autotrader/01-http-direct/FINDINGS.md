# HTTP-Direct AutoTrader Spike — Findings

## TL;DR

HTTP-direct works **better than expected**. AutoTrader's own SPA hits an unauthenticated internal GraphQL endpoint at `https://www.autotrader.co.uk/at-gateway`. From a UK residential IP, a plain JSON POST with a realistic User-Agent returns full structured search results (20 listings/page, with price, year, distance, seller type, fpaLink, images) — no Cloudflare challenge, no cookies, no Origin/Referer required. Detail pages are also fully server-side rendered, so price/mileage/year/fuel/transmission/body/location/colour are extractable from plain HTML. **Viable as the primary access method for low-volume polling.** Two caveats: (a) `robots.txt` explicitly disallows `/car-search` and `/car-details*`, which is a compliance call; (b) we depend on an undocumented internal endpoint that can change.

## What we tried

UK residential IP, Node 22 `fetch`, 4–5 s pauses.

| # | Method | URL | Headers | Outcome |
|---|--------|-----|---------|---------|
| 1 | GET | `/car-search?make=AUDI&model=A4&price-to=15000&postcode=LE11AB&radius=50&...` | None / Node default | 200, 87 KB SPA shell only |
| 2 | GET | Same as #1 | Full Chrome 131 UA + `en-GB` + Sec-Ch-Ua | 200, 87 KB **same SPA shell** — empty Apollo state, no listings in DOM |
| 3 | GET | `/cars/used/audi/a4?postcode=LE11AB&price-to=15000&radius=50&...` | Full Chrome 131 UA | 200, 340 KB — populated Apollo state, but **only 3 SSR'd listings** (top carousel); query-string filters silently ignored |
| 4 | GET | `/car-details/202605282783235` | Full Chrome 131 UA | 200, 274 KB — fully SSR'd detail page, all fields in DOM |
| 5 | POST | `/at-gateway` (GraphQL `SearchResultsListingsGridQuery`) | Realistic UA + Origin + Referer + Sec-Fetch + `x-sauron-app-name` | **200, 22.5 KB JSON, 20 listings, page 1 of 45 (881 total results)** |
| 6 | POST | `/at-gateway` (same payload) | No Origin, no Referer | **200, 22.5 KB** — still works |
| 7 | POST | `/at-graphql` (same payload) | Same as #5 | 400 — different endpoint or routing rule |
| 8 | GET | `at1.p.autotrader.co.uk` (from earlier session) | Various | 403 Cloudflare hard-block ("Sorry, you have been blocked") |

## What worked

### Primary: `POST https://www.autotrader.co.uk/at-gateway`

Same GraphQL endpoint AutoTrader's own SPA uses (path identifiable from the search-results bundle: `"/at-gateway"` literal). Schema-validating (earlier attempt with wrong enum casing got back per-variable validation errors — see `samples/search-graphql-error.json`).

- Accepts Apollo-batched POST: `[{operationName, variables, query}]`.
- Returns `application/json` with `[ { data: { searchResults: { listings, page, trackingContext } } } ]`.
- 200 with no auth cookie, no CSRF, even with Origin/Referer stripped.
- Sets `__cf_bm` cookie but doesn't require it on the next request.

Verified listing payload (file `samples/graphql-at-gateway.body.txt`):

```json
{
  "advertId": "202605282783235",
  "title": "Audi A4",
  "subTitle": "2.0 TFSI S line S Tronic Euro 6 (s/s) 4dr",
  "attentionGrabber": "LOW MILEAGE  + AUTOMATIC!",
  "price": "£10,989",
  "vehicleLocation": "Leicester (3 miles)",
  "sellerType": "TRADE",
  "images": ["https://m.atcdn.co.uk/a/media/{resize}/79fe7bc9....jpg", "..."],
  "numberOfImages": 64,
  "fpaLink": "/car-details/202605282783235?...",
  "dealerLink": "/dealers/leicestershire/leicester/...",
  "trackingContext": {
    "advertContext": { "id": "202605282783235", "make": "Audi", "model": "A4", "year": 2015, "condition": "used", "price": 10989, "vehicleCategory": "car" },
    "distance": { "distance": 3, "distance_unit": null }
  }
}
```

`page: { number: 1, count: 45, results: { count: 881 } }` — 881 matches across 45 pages of 20.

**Filter syntax that works** (case-sensitive — enum casing matters):

```js
variables: {
  filters: [
    { filter: 'make',                 selected: ['Audi'] },
    { filter: 'model',                selected: ['A4'] },
    { filter: 'max_price',            selected: ['15000'] },
    { filter: 'postcode',             selected: ['LE11AB'] },
    { filter: 'price_search_type',    selected: ['total'] },
    { filter: 'home_delivery_adverts', selected: ['include'] },
  ],
  channel: 'cars',                  // lowercase
  page: 1,
  sortBy: 'relevance',              // lowercase
  listingType: ['NATURAL_LISTING'], // uppercase
  searchId: '00000000-0000-4000-8000-000000000000',
  featureFlags: [],
}
```

Results came back distance-sorted 0–87 mi from LE11AB without an explicit `radius` filter — postcode alone is sufficient for proximity ordering. (The gateway rejected `filter: "radius"` as an invalid enum.)

### Secondary: detail pages SSR'd

`GET /car-details/<advertId>` returns 200 with full DOM. Fresh fetch of `202605282783235` confirmed:

| Field | Source | Reliability |
|-------|--------|-------------|
| Title (year + colour + make + model + price + location) | `<title>` and `<meta name="og:title">` | Very high |
| Price | `<title>` + multiple `£10,989` in DOM | Very high |
| Mileage (`55,010 miles`) | First `\d+,\d+ miles` after spec block | High — page also has "similar cars" mileages further down; constrain to spec block |
| Year + reg plate (`2015 (65 reg)`) | DOM text | High |
| Fuel (`Petrol`) | `>(Petrol\|Diesel\|Hybrid\|Electric)<` | High |
| Transmission (`Automatic`) | `>(Manual\|Automatic)<` | High |
| Body type (`Saloon`) | `>(Saloon\|Hatchback\|Estate\|SUV\|Coupe\|Convertible\|MPV)<` | High |
| Colour (`White`) | From `<title>` | High |
| Hero image | `<meta property="og:image">` | Very high |
| Dealer name | `<meta name="description">` "… from DEALER -" | High for TRADE |

`window['AT_APOLLO_STATE']` on detail pages is **empty `{}`** — but the SSR'd DOM has everything, so no client-side hydration is needed for our extraction.

### Tertiary: SEO category URL — partial usefulness only

`/cars/used/audi/a4` returns 340 KB with a populated `AT_APOLLO_STATE`, but:

- Only the top "Reserve online" carousel (3 cards) is SSR'd as `<article class="atds-advert-card">` with structured data. Cleanly regex-extractable (see `samples/seo-search-audi-a4-filtered.listings.json`).
- Other 9 `/car-details/<id>` links on the page are bare hyperlinks.
- Query-string filters (`postcode`, `price-to`, `radius`, `maximum-mileage`, `fuel-type`) are **silently ignored** — Apollo state shows `postcode: ""` and no price filters applied. The page is the unfiltered category landing.

**Verdict:** useless for filtered search. Use GraphQL.

## What didn't

| Attempt | Status | Snippet |
|---------|--------|---------|
| `GET /car-search?...` (any headers) | 200 SPA shell | `window['AT_APOLLO_STATE'] = {};` — listings fetched client-side |
| `POST /at-gateway` with `channel: "CARS"` | 200 + errors | `Value "CARS" does not exist in "Channel" enum. Did you mean "cars", "farm", or "vans"?` |
| `POST /at-gateway` with `sortBy: "RELEVANCE"` | 200 + errors | `Value "RELEVANCE" does not exist in "SearchResultsSort" enum.` |
| `POST /at-gateway` with `filter: "radius"` | 200 + errors | `Value "radius" does not exist in "FilterName" enum.` |
| `POST /at-graphql` (same valid payload) | 400 | Empty body — endpoint differs |
| `GET at1.p.autotrader.co.uk/...` | 403 Cloudflare hard-block | Different subdomain, stricter policy |

No CAPTCHAs or interactive challenges across the whole spike.

## Data extraction

### GraphQL search response — fields

`advertId`, `make`, `model`, `year`, `price`, `vehicleLocation`, distance from postcode, `sellerType` (TRADE/PRIVATE), `dealerLink`, `fpaLink`, `images[]`, `numberOfImages`, `subTitle` (trim), `attentionGrabber`, `hasDigitalRetailing`, `preReg`, `position`. **Not returned in this query: mileage, fuel, transmission, body type, AT price tier ("Great price"/"Good price")** — those need the detail-page fetch, or possibly a richer GraphQL field selection (untested).

### Detail-page extraction reliability

| Field | How | Reliability |
|-------|-----|-------------|
| price | `<title>` regex `£([\d,]+)` | Very high |
| year + reg | `\b(20\d{2})\s*\(\d{2}\s*reg\)` | High |
| mileage | first `([\d,]+)\s+miles` (constrain to spec block) | Medium |
| fuel / transmission / body | enumerable `>(X)<` patterns | High |
| colour | parse `<title>` "YYYY <Colour> Make Model" | High |
| image / dealer | meta tags | Very high |
| **sold / removed** | **untested** — likely 404 or banner; verify on first run | **Unknown** |

## Risks / unknowns

1. **robots.txt explicitly disallows** `/car-search`, `/car-details*`, and any URL with `?postcode=`, `?radius=`, `?sort=` (see `samples/robots.txt`). `/at-gateway` is not named in robots, but the policy intent is clear. AutoTrader's commercial T&Cs likely also prohibit automated scraping. **This is a compliance decision for the user.**
2. **Undocumented internal API**. `/at-gateway` schema names will probably evolve. Mitigation: log first error and fall back to detail-page HTML scrape.
3. **Cloudflare bot-management** active (`__cf_bm` set, `cf-mitigated` absent). We're under threshold from a residential UK IP. Scaling up or moving to datacentre IP will likely change this. The fact that `at1.p.autotrader.co.uk` is hard-blocked from this same IP proves protection is per-host configurable.
4. **No mileage/fuel/transmission in search response** — must fetch detail page per candidate. Acceptable for low-volume use; multiplicative if scaled.
5. **AT price-tier ("Great price"/"Good price")** wasn't in the GraphQL fields we requested. Spike #2 saw it rendered on cards — it likely exists in the GraphQL schema under a field we didn't ask for. Worth a follow-up to enumerate the schema.
6. **Sold-state extraction untested.** First production use should verify what AutoTrader returns for a removed listing.
7. **Deep pagination untested.** We got `page.count: 45`; didn't try `page: 30`. Likely fine for "find newly-listed cheap one" (page 1 sorted by date-listed).
8. **Postcode privacy.** UK postcodes go up in every request, logged on AutoTrader's side keyed to our IP.

## Recommendation

**Use HTTP-direct as the primary access method**, pending sign-off on the robots/TOS question. Architecture:

- **Search**: `POST https://www.autotrader.co.uk/at-gateway` with `SearchResultsListingsGridQuery` and hunt filters. Parse `data[0].data.searchResults.listings`. Paginate only if needed (low-volume hunts within 50 mi typically fit in one page).
- **Watch / enrich**: `GET /car-details/<advertId>` for full spec or change tracking. Regex-extract from SSR'd DOM. Detect "sold" via status code + banner (verify on first use).
- **Throttle**: 5 s+ between requests per hunt. At ~3 hunts and ~30 watched listings rechecked every few hours, well under 1 req/min.
- **Headers**: realistic Chrome 131 UA + `Accept-Language: en-GB`. Origin/Referer optional. Don't use Node-default UA.
- **Resilience**: log any non-200 or `cf-mitigated` header — early warning that protection tightened.
- **Skip headless-browser route** unless detection tightens later. Puppeteer overhead is not worth it for this volume.

**On robots.txt**: explicitly forbids `/car-search` and `/car-details*` for all UAs. `/at-gateway` is not named. Whether to treat that as "fair game because not listed" or "obviously in the policy's spirit" is the user's call. Practical-minded approach for narrow, low-volume automation against a known item set: defensible; aggressive enforcement is unlikely from a residential IP at sub-1-req/min. Belt-and-braces: ask permission from AutoTrader or use their commercial data API.

## Pointer

- **Working code**: `scripts/` (`probe.mjs`, `graphql.mjs`, `probe-detail.mjs`, `extract-apollo.mjs`, `extract-listings.mjs`).
- **Raw evidence** (23 files): `samples/`. Headline files: `graphql-at-gateway.body.txt` (20 listings, structured), `detail-202605282783235.html` (SSR'd detail page), `seo-search-audi-a4-filtered.html` + `.apollo.json` (SEO landing experiment), `robots.txt`.
