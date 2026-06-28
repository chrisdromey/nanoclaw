# Puppeteer + Stealth AutoTrader Spike — Findings

## TL;DR

**Works cleanly.** `puppeteer-extra` + stealth + UK residential IP reaches autotrader.co.uk, gets through the Sourcepoint cookie consent (iframe-based), and renders search/detail/page-2 with no Imperva interstitial, no CAPTCHA, no 403, no challenge of any kind. End-to-end run: ~20s wall-clock including polite sleeps. All key listing fields extract reliably. **Recommended as the primary access method at Deal Hunter's volume.**

## Setup

| Component | Version |
|---|---|
| Node | 22.22.1 |
| `puppeteer-core` | 23.11.1 |
| `puppeteer-extra` | 3.3.6 |
| `puppeteer-extra-plugin-stealth` | 2.11.2 |
| Chromium | Chrome for Testing 131.0.6778.204 from `~/.cache/puppeteer/...` |
| Host | Ubuntu Noble, UK residential IP |

**Gotchas:** no system Chromium on host; reused puppeteer's cached binary. Needed one-time `apt install libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libasound2t64 libpangocairo-1.0-0 libpango-1.0-0 fonts-liberation`. After that, Chrome launches in ~400ms headlessly. Local `package.json` keeps deps isolated from the main repo.

## What worked

- Search URL `https://www.autotrader.co.uk/car-search?postcode=LE11AB&make=AUDI&model=A4&price-to=15000` returned a fully styled page; `page.title()` was `"New & Used Cars for Sale - Autotrader UK"`.
- WAF/challenge scanner (looking for "Pardon our interruption", Incapsula, PerimeterX, px-captcha, Cloudflare challenge, access denied, "are you a human") returned **empty signals on every page load**.
- Cookie consent: Sourcepoint CMP lives in a frame whose URL contains `cmpv2.autotrader.co.uk/index.html?message_id=…`. Enumerate `page.frames()`, click "Accept All" inside that frame. **First-try reproducible.**
- Search page: 23 cards extracted on page 1 via `a[href*="/car-details/"]`. Per card: id, URL, title, variant, price, mileage, year/reg. See `samples/01-search-results.json`.
- Detail page: 10 spec fields, dealer name, type, rating, city, distance, full description, 8 image URLs. See `samples/02-detail.json`.
- Pagination: `&page=2` returned 22 different listings. `ids_differ_from_page1: true`.
- Screenshots at `screenshots/{01-search,02-detail,03-search-page2}.png` — all show clean rendered AutoTrader UI.
- **AT price tier visible on search card.** "Great price", "Good price", "Lower price" labels appear in card raw text — this is the free deal signal we want.

## What didn't / friction

- **No embedded JSON payload.** No `__NEXT_DATA__`, no JSON-LD. AutoTrader is a pure SPA — hydration via internal XHRs only (`apm.autotrader.co.uk`, `cmpv2.autotrader.co.uk` — both internal, no public-looking listing JSON endpoint observed). **There is no shortcut to a JSON feed — we must scrape the rendered DOM.**
- **CSS class names are hashed** (`sc-tqnfbs-5 kDYJWK dGrInR`) — will change on every frontend deploy. The script avoids class-name dependence; uses structural patterns (sibling `<p>` pairs, leaf-text regex). Still recommend a canary smoke test in production.
- **Search-card lazy loading** — first cards show "Loading..." for the photo carousel; this leaked into card text on the first run. Fixed by scrolling + sleeping before extraction. Price/year/mileage were always correct.
- **Detail-page `postcode` heuristic is unreliable** — picks up the first UK-shape postcode in `body.innerText`, often a stray token from the description (got `M1 7BL` for a "Derby"-located listing). **Use `cityText` + `distanceText` instead** — both are accurate ("Derby", "27 miles away").
- **Image gallery undercounts** — only first 8 captured vs. the "1/44" indicator. Rest are lazy-loaded. Not a problem for Deal Hunter (we don't need every image).

## Data extraction

### Search-results card

| Field | Source | Reliability |
|---|---|---|
| `id` | URL match `/car-details/(\d+)` | **High** — 15-digit numeric, stable, suitable as DB `source_id` |
| `url` | anchor `href` | **High** — but carries tracking junk (`searchId`, `journey`, `backLinkQueryParams`); normalise to `https://www.autotrader.co.uk/car-details/<id>` for DB |
| `title` ("Audi A4") | first non-badge text line | High |
| `price` ("£14,500") | leaf matching `/^£[\d,]+$/` | High |
| `mileage_text`, `year_text` | regex on leaf lines | High |
| `price_text` (variant + price, e.g. "2.0 TFSI 35 S line Euro 6 (s/s) 4dr, £14,500") | combined card line | High; useful for variant ID |
| AT price tier ("Great price", "Good price", "Lower price") | text scan in card | **High — primary deal signal** |
| `fuel`, `transmission`, `distance` | line scan | **Low — not rendered on the card.** Full spec is detail-page-only. |

### Detail page

| Field | Source | Reliability |
|---|---|---|
| `title` (e.g. "2019 Audi A4") | `<h1>` | **High** |
| `price` | leaf `<*>` text matching `/^£[\d,]+$/` | **High** |
| `spec.{mileage,fuel,body,engine,transmission,doors,seats,colour,registration,year}` | paired sibling `<p>` blocks in "Key specs" panel (label-text → next-sibling) | **High** — class-name-independent |
| `sellerName` ("Hilton Garage Ltd") | element with text matching `/^From\s+.+/` | High for trade; private-seller path untested in this run |
| `sellerType` | `bodyText` contains "private seller" → private; presence of `a[href*="/dealers/"]` → trade | High for trade |
| `dealerRating` | first `[1-5]\.\d` in body | Medium — could collide on private listings; scope to seller block in production |
| `cityText`, `distanceText` ("Derby", "27 miles away") | sibling of "N miles away" element | **High** |
| `postcode` | `bodyText.match(/postcode-shape/)` | **Low — DO NOT USE.** Stray-token false positives. |
| `description` | `[class*="description"]` | High |
| Images | `<img>` matching `m.atcdn.co.uk` | URLs reliable; count undercounts due to lazy-load |
| `__NEXT_DATA__`, JSON-LD | `<script>` tags | **None.** Pure SPA. |

### Stable identifiers

- Listing IDs (e.g. `202604291986125`) — 15-digit numeric, look like `<YYYYMMDD><sequence>`, appear consistently in URL and persist across pages. **Safe as `source_id`.**
- Image URLs on `m.atcdn.co.uk` use hash filenames; stable as long as the listing exists.

## Performance

| Step | ms |
|---|---|
| Chrome launch | 400 |
| Search goto | 370 |
| Search extraction | 5 |
| Detail goto (`networkidle2`) | 1581 |
| Detail extraction | 5 |
| Page 2 goto | 244 |
| Total wall-clock incl. ~12s polite sleeps | ~20s |

Stripped of artificial pauses, a search + 3 detail fetches would complete in **<10s**.

## Risks

- **Bot detection at our volume: low.** Stealth + UK residential IP cleared everything; only "anti-bot adjacent" traffic was the Sourcepoint CMP iframe (consent, not blocking). No PerimeterX, Imperva, or Cloudflare challenge observed.
- **At 10x volume** (~100 detail loads/cycle, multiple cycles/day) we'd start looking suspicious. Mitigations: session/`userDataDir` reuse, 5–15s randomised delays, UA rotation (copy from `container/agent-runner/src/sold-data-mcp.ts`), spread fetches across the hour.
- **Frontend rewrites.** AutoTrader runs `sauron-search-results-app` with `serviceVersion: 3963` — implies frequent deploys. Our extractors avoid hashed class names; depend only on URL shape, sibling `<p>` pairs, and the "From <Name>" text pattern. Add a canary smoke test that fails if `spec` returns < 4 fields.
- **Stealth handles** `navigator.webdriver`, image dims, plugin/codec spoofing, WebGL strings, etc. It does NOT solve behavioural fingerprinting (mouse, timing). No sign AutoTrader checks those.
- **No cached session in current setup** — each run pays cookie-consent cost. Persist `userDataDir` in production to skip CMP after first run (saves ~3s per cycle and reduces noise).

## Recommendation

**Adopt Puppeteer + stealth as the primary access method.** Lightweight (one Node process, ~150 MB Chrome), complete and clean data extraction, zero signs of detection at Deal Hunter volume.

Concrete next steps for production:
1. Wrap into `autotrader-search-mcp` and `autotrader-detail-mcp` analogous to existing `ebay-search-mcp.ts` / `sold-data-mcp.ts`.
2. Reuse the eBay MCPs' UA-rotation + challenge-detection pattern as defensive logging.
3. Persist `userDataDir` per hunt to skip CMP on each poll.
4. Smoke test: `extractDetailPage` must return ≥4 `spec.*` fields, else alert.
5. **Do not** invest in finding a JSON endpoint — there isn't one.
6. Use the 15-digit listing ID as `source_id`. Store URLs normalised to `https://www.autotrader.co.uk/car-details/<id>`.
