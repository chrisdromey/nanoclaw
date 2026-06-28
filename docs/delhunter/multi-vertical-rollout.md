# Deal Hunter — Multi-Vertical Rollout Notes

**Date:** 2026-06-28
**Phases completed:** 0–3 (Phase 4 Opus QA gate pending)

> **This is a historical changelog of the cars/AutoTrader rollout.** For how the pipeline works
> today and how to add a vertical or a source, see
> [deal-hunter-architecture.md](deal-hunter-architecture.md) — it supersedes the "How to add"
> sections below.

---

## What changed

### Schema (watcher/src/db.ts)
- `hunts` gained `vertical TEXT NOT NULL DEFAULT 'computers'`, `sources TEXT NOT NULL DEFAULT '["ebay"]'`, `poll_interval_minutes INTEGER`
- `offers` gained `vertical TEXT`, `attributes TEXT DEFAULT '{}'`
- Legacy eBay columns (`condition`, `buying_format`, `auction_end_time`, `bid_count`) remain nullable — used by eBay adapter, ignored by others
- `upsertOffer(ItemSummary)` replaced by `upsertNormalisedListing(db, NormalisedListing, vertical)`
- At startup `ensureSchema()` runs and logs: "Migrated legacy hunts to vertical='computers', sources=["ebay"]"

### Source adapters (watcher/src/sources/)
- `watcher/src/ebay/` moved to `watcher/src/sources/ebay/` — same code, wrapped as `EbayAdapter implements SourceAdapter`
- `watcher/src/sources/autotrader/` added — HTTP-direct GraphQL via `/at-gateway`, with HTML detail-page enrichment
- Source registry at `watcher/src/sources/index.ts` — `getAdapter(id)`, `listAdapters()`

### Scheduler (watcher/src/scheduler.ts)
- `tick()` now iterates `hunt.sources[]`, dispatches to the appropriate adapter per source
- Per-source error isolation: one source failing doesn't kill the whole tick
- Per-source `lastSearchTime` keyed as `${huntId}:${source}:${terms}`

### Vertical config (config/verticals.yml)
- `_default`, `computers`, `cars` blocks defined
- Read by `watcher/src/verticals.ts` and `src/verticals/loader.ts`

### Verticals package (verticals/)
- `verticals/cars/translators/autotrader.ts` — maps `CarsCriteria → AutotraderSearchParams`
- `verticals/cars/formatter.ts` — renders notification line (see format below)
- Must be compiled before use: `cd verticals && npx tsc`

### Container skills
- `container/skills/car-listing-evaluation/SKILL.md` — T3 evaluator for cars vertical
- `container/skills/generic-deal-evaluator/SKILL.md` — T1 fallback for simple verticals

### Agent runner (container/agent-runner/src/index.ts)
- `autotrader-search` MCP server registered
- `cars-evaluator` sub-agent added (skills: car-listing-evaluation, tools: autotrader-search MCP)
- `generic-deal-evaluator` sub-agent added (skills: generic-deal-evaluator, tools: sold-data MCP)
- Existing `deal-evaluator` relabelled to "computers vertical (eBay-sourced)"

### Dashboard (dashboard/)
- `dashboard/shared/types.ts`: `Hunt` gains `vertical`, `sources`, `poll_interval_minutes`; `Offer` gains `vertical`, `attributes`; eBay-specific fields made nullable
- `dashboard/server/sources/` — dispatcher for offer status refresh by source
- `dashboard/src/pages/OfferDetail.tsx` — `<CarAttributesBlock>`, `<EbayAuctionBlock>`, `<EbayConditionBadge>`, `<ViewOnSourceLink>` extracted
- Vertical filter dropdown in layout header

---

## How to add a T1 vertical (cookers, AC units)

T1 = generic category, eBay only, no bespoke code needed.

1. Add one block to `config/verticals.yml`:
   ```yaml
   cookers:
     inherit: _default
     evaluator_skill: generic-deal-evaluator
     sources: [ebay]
     default_poll_minutes: 120
   ```
2. Insert a hunt row:
   ```sql
   INSERT INTO hunts (name, status, criteria, search_terms, cadence_minutes, monitoring, vertical, sources)
   VALUES ('range-cooker-hunt', 'active',
     '{"keyword":"range cooker","max_price":500}',
     '[{"terms":"range cooker 90cm"}]',
     120, 1, 'cookers', '["ebay"]');
   ```
3. Restart watcher: `systemctl restart deal-hunter-watcher.service`

No code changes required.

---

## How to add a T3 vertical (real-estate-style)

T3 = bespoke source, bespoke evaluator, bespoke formatter.

1. **Translator** — `verticals/{name}/translators/{source}.ts` mapping criteria → source-native params
2. **Formatter** — `verticals/{name}/formatter.ts` rendering notification line
3. **Source adapter** (if new source) — `watcher/src/sources/{name}/` implementing `SourceAdapter`
4. **Evaluator skill** — `container/skills/{name}-evaluation/SKILL.md`
5. **Agent sub-agent** — register in `container/agent-runner/src/index.ts`
6. **Vertical config block** — `config/verticals.yml`
7. Rebuild: `cd verticals && npx tsc && cd watcher && npx tsc && cd .. && ./container/build.sh`
8. Clear caches: `rm -rf data/sessions/*/agent-runner-src/`
9. Restart both services

---

## Where the price-tier signal comes from (cars)

AutoTrader's price tier (`GREAT` / `GOOD` / `LOW` / `HIGH` / `NOANALYSIS`) is **not** available from the GraphQL search endpoint. It is extracted from the listing detail page HTML via `watcher/src/sources/autotrader/detail.ts`.

The extraction reads `<h4>` and sibling `<p>` tags in the page body, looking for known tier strings. This is fragile against AT frontend rewrites — hence the canary script.

The `price_tier_label` (display text like "Great price") is also extracted and stored in `attributes`. The formatter uses `price_tier_label` for the notification; `price_tier` (enum) is used by the evaluator skill for decisions.

---

## AT rate limit envelope and kill switch

- **Base interval:** 6 000 ms between requests
- **Jitter:** ±30% applied per request (4 200 – 7 800 ms actual)
- **Backoff:** exponential on HTTP 429/503 or `cf-mitigated` header — doubles each step up to 1h max; persisted to `data/rate-limit-state.json`
- **Kill switch:** set `AUTOTRADER_DISABLED=1` in the watcher service environment to disable all AT requests immediately without restarting
- On 429/503/cf-mitigated: Phase 3 hard rule — STOP, do not retry during smoke tests. The adapter handles production retries automatically.

---

## Canary script

**Location:** `/opt/nanoclaw/scripts/at-canary.mjs`

**What it tests:**
1. Translator produces params without error (Audi A4 at LE11AB)
2. AT search returns ≥ 1 listing
3. `fetchDetail()` returns a listing
4. Detail has ≥ 4 required attribute fields (mileage_num, fuel, transmission, body_type)
5. `price_tier` is a known enum value

**First test run:** passed (2026-06-28) — 20 listings, price_tier=GOOD, 4/4 detail attributes

**To enable as a daily timer:**
```bash
# Create service file at /etc/systemd/system/at-canary.service
# Create timer file at /etc/systemd/system/at-canary.timer
# See header comments in the script for the full unit file content
systemctl daemon-reload
systemctl enable --now at-canary.timer
```

Exit codes: 0 = pass, 1 = functional failure, 2 = rate-limit / Cloudflare block

---

## Known caveats

### verticals.yml path bug in watcher/src/index.ts
`VERTICALS_CONFIG_PATH` is computed using `resolve(fileURLToPath(import.meta.url), '../../../../...')` without `dirname()`. This resolves to `/opt/config/verticals.yml` (wrong) instead of `/opt/nanoclaw/config/verticals.yml` (correct). The watcher gracefully catches the ENOENT and logs a WARN, then skips validation. **Phase 4 QA should fix this** — add `import { dirname } from 'node:path'` and use `dirname(fileURLToPath(import.meta.url))`.

### AT refresh is async; eBay refresh is sync
When a user requests a status refresh for an autotrader offer from the dashboard, the route returns HTTP 202 and kicks off a background job. The UI polls a status endpoint. eBay refresh is synchronous (returns 200 with the new status). This asymmetry is intentional (AT detail-page fetch takes several seconds).

### mileage_display missing from search-level attributes
AutoTrader's GraphQL search response does not include mileage. Mileage is only available after `fetchDetail()`. The notification path calls `fetchDetail()` before formatting; the dashboard Offers tab shows mileage as empty until detail has been fetched and stored.

### price_tier only from detail page
The AT GraphQL endpoint does not return price tier in the search results. It's extracted from the detail-page HTML. This means each new listing requires one extra HTTP request. The scheduler calls `fetchDetail()` for top-N new listings per tick (configurable).

### Pre-existing puppeteer-core typecheck artifact
`container/agent-runner/` has a pre-existing TypeScript error for `puppeteer-core` module not found when running `tsc` locally on the host. This is because `node_modules` is not installed in that directory on the host. The container's own Dockerfile installs dependencies fresh during build. This error does NOT appear during `./container/build.sh`. Do not attempt to fix it with `npm install` in the host `container/agent-runner/` directory.

### container-runner.test.ts pre-existing failure
`src/container-runner.test.ts` fails with "No EBAY_CLIENT_ID export on config mock". This pre-dates Phase 2 — the `vi.mock('./config.js', ...)` in the test file does not include `EBAY_CLIENT_ID`. Not a Phase 2 regression.

### smoke hunt cleanup
The `audi-a4-smoke` hunt (created during Phase 3 smoke) and its 5 autotrader offers were deleted after smoke completed. The `m70q-nvme-ssd` hunt was temporarily set to `active` for regression testing, then reverted to `paused`.

---

## Dashboard URL

The dashboard runs on port 80 (HTTP). Check with:
```bash
systemctl status deal-hunter-dashboard.service --no-pager | grep "running on"
```

Cars hunts appear in the hunt list with a vertical filter. Offer detail pages show `<CarAttributesBlock>` (year, mileage, fuel, body, transmission) instead of eBay condition/auction blocks for `vertical=cars` offers.
