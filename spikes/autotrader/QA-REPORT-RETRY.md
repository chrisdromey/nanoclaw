# Phase 4 Adversarial QA — Retry Report

**Date:** 2026-06-28
**Reviewer:** Opus 4.7 (Phase 4 gate, retry pass)
**Worktree state:** post fix-pass A/B/D

## Summary

- **Hard-gate decision: PASS**
- **High-severity issues now resolved: 7/7**
- **Medium/low issues resolved: 11/11** verified
- **New issues found in retry: 0** behaviour bugs; 1 trivial doc-drift (skill MD references `price_deviation` without `_gbp` suffix)
- **Test counts:**
  - watcher: **96 / 96 passed**
  - verticals: **36 / 36 passed**
  - dashboard: **23 / 23 passed**
  - root: 281 / 285 passed; 4 failures are **pre-existing**, unrelated to this work (`container-runner.test.ts` mock missing `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` exports; `tool-bloat-report.test.ts` is a local untracked dev test). Confirmed by re-running the failing test file — same failure pattern exists independently of the multi-vertical work.
- **Typecheck:** all four roots exit 0 (watcher, verticals, dashboard, root)
- **Canary: PASS** — `/opt/nanoclaw/scripts/at-canary.mjs` exit 0; live AT call returned 20 listings, fetchDetail returned `price_tier=GOOD`, all 4 required attribute fields populated
- **Live mutex probe: PASS** — `/tmp/mutex-probe.mjs` fired 5 concurrent `rateLimitedFetch()` against a mocked fetch; spacings were **5388, 5605, 6225, 5771 ms**, all comfortably above the 4200 ms (= 0.7 × 6000 ms) floor. Total elapsed 22989 ms across 5 serialised calls. The pre-fix burst (≤700ms inter-call) is gone.

## Per-issue verification

### Issue 1 — Rate-limit mutex (HIGH)
- File: `watcher/src/sources/autotrader/rate-limit.ts:152-178`
- The promise-chain mutex is implemented: `let inflightChain: Promise<void> = Promise.resolve();` then `acquireSlot()` does `const myTurn = inflightChain.then(() => waitForJitteredInterval()); inflightChain = myTurn.catch(() => {}); return myTurn;`. The chain swallows errors via `.catch(() => {})` so one rejection cannot break subsequent callers.
- Test file: `watcher/src/sources/autotrader/rate-limit.test.ts:180-255` — new `describe('mutex serialisation — 5 parallel rateLimitedFetch calls')` block asserts FIFO ordering (`expect(seqOrder).toEqual([1, 2, 3, 4, 5])`) and at-most-1 inflight (`expect(Math.max(...maxConcurrent)).toBe(1)`). Test passes.
- **Live empirical probe:** `/tmp/mutex-probe.mjs` (added by reviewer) imports from `watcher/dist/sources/autotrader/rate-limit.js`, fires 5 concurrent calls with mocked fetch, measures actual fetch() invocation timestamps. Observed spacings 5388/5605/6225/5771 ms — all >= 4200 ms floor.
- **Status: RESOLVED**

### Issue 2 — Dashboard rate-limit + kill switch (HIGH)
- File: `dashboard/server/sources/autotrader.ts:28` imports `rateLimitedFetch, isAutoTraderDisabled` from `/opt/nanoclaw/watcher/dist/sources/autotrader/rate-limit.js` (Option A: shared compiled module).
- `checkOfferStatus` (line 42-90): the kill-switch check is at the very top (line 44 `if (isAutoTraderDisabled()) throw new Error(...)`); the actual HTTP call goes through `rateLimitedFetch` at line 52 (cast as `typeof fetch`).
- Raw `fetch()` calls are GONE — `grep -n "await fetch\|fetch(" dashboard/server/sources/autotrader.ts` only matches the `rateLimitedFetch as typeof fetch` cast.
- `@ts-expect-error` at line 26 is documented and references the multi-vertical-rollout doc; dashboard typecheck passes (exit 0).
- **Status: RESOLVED**

### Issue 3 — Scheduler fetchDetail (HIGH)
- File: `watcher/src/scheduler.ts:268-301`. After `applyNormalisedResults` returns `{ newCount, newSourceIds }`, the loop (line 276) checks `adapter.capabilities.needsDetailFetch && adapter.fetchDetail && newSourceIds.length > 0`, then slices `newSourceIds` at `MAX_DETAIL_FETCHES_PER_TICK` (default 10, line 120-123), calls `adapter.fetchDetail(listingSourceId)`, and merges via `mergeOfferAttributes`.
- `MAX_DETAIL_FETCHES_PER_TICK` is env-overridable via `MAX_DETAIL_FETCHES_PER_TICK`.
- Test: `watcher/src/scheduler.test.ts:341-393` "calls fetchDetail for each new AT listing and merges attributes" — asserts fetchDetail called 3 times, attributes merged into DB row. Passes.
- Test: `watcher/src/scheduler.test.ts:395-433` "caps fetchDetail at MAX_DETAIL_FETCHES_PER_TICK (default 10)" — asserts cap honoured with 15 new listings. Passes.
- Detail-fetch API calls are accounted against `getSourceCalls(sourceId)` budget at line 290 (`addSourceCalls(state, sourceId, detail.apiCalls)`).
- **Status: RESOLVED**

### Issue 4 — verticals.yml path (HIGH)
- File: `watcher/src/index.ts:13,15-32`. The ad-hoc `resolve(fileURLToPath, '../../../../config/...')` is gone; the file now imports `getVerticals` from `./verticals.js` and uses that.
- File: `watcher/src/verticals.ts:12-14`. `__dirname = dirname(fileURLToPath(import.meta.url))` then `DEFAULT_VERTICALS_PATH = resolve(__dirname, '../../config/verticals.yml')`. With `watcher/dist/verticals.js`, that resolves to `/opt/nanoclaw/config/verticals.yml` — confirmed file exists (`ls /opt/nanoclaw/config/verticals.yml`).
- **Status: RESOLVED**

### Issue 5 — Detail.test.ts fixture path (HIGH)
- File: `watcher/src/sources/autotrader/detail.test.ts:18-21`. `FIXTURE_PATH = path.resolve(__dirname, '../../../../spikes/autotrader/03-price-tier/samples/06-detail-page.html')` — **4 levels** (correct), not 5.
- Test run: `npx vitest run src/sources/autotrader/detail.test.ts` → 23 tests passed (12 fixture-driven extractions + edge cases + sold-detect + merge). The "extracts priceIndicator as LOW", "extracts mileageText containing 55,010", etc. assertions execute (not skipped).
- CI branch added (line 35-43): in CI, missing fixture is now a hard FAIL instead of silent skip.
- **Status: RESOLVED**

### Issue 6 — `price_deviation_gbp` canonical naming (HIGH)
- Write sites: `watcher/src/sources/autotrader/detail.ts:221` (in `mergeDetailAttributes`) and `:353` (in `getListingState`). Both write `price_deviation_gbp: detail.deviation`.
- Read sites: `dashboard/src/components/source-specific/CarAttributesBlock.tsx:56` reads `price_deviation_gbp`; `verticals/cars/formatter.ts:77` reads `price_deviation_gbp` and renders the segment at line 117-123 (`£500 below market` / `above market`).
- Tests: `watcher/src/sources/autotrader/detail.test.ts:211` asserts `merged.attributes['price_deviation_gbp']).toBe(-500)`; `verticals/cars/formatter.test.ts` has 4 tests covering the deviation rendering (lines 99-145).
- Only stale reference to old `price_deviation` (no `_gbp`) found in `container/skills/car-listing-evaluation/SKILL.md:51` — doc, not code; deferrable.
- **Status: RESOLVED**

### Issue 7 — `seller_type` / `location_text` (HIGH)
- File: `watcher/src/sources/autotrader/search.ts:127-132`. `normaliseSearchListing` writes BOTH `location_text` (= `vehicleLocation`) and `seller_type` (= lowercased `sellerType`) into attributes. Also retains `vehicleLocation` for formatter fallback.
- Dashboard: `CarAttributesBlock.tsx:48-51`. Reads `seller_type`, then for `location_text` it strips the parenthetical distance: `rawLocationText.replace(/\s*\(.*?\)\s*$/, '').trim()`. So `"Leicester (3 miles)"` → `"Leicester"` for display.
- Capitalisation: at line 74 the seller is capitalised via `.charAt(0).toUpperCase() + slice(1).toLowerCase()` → "Trade" / "Private".
- Detail-page enrichment additionally overwrites `location_text` with the more granular "Town, Postcode" when present (`detail.ts:232-235`).
- **Status: RESOLVED**

### Issue 8 — Refresh dedupe (MEDIUM)
- File: `dashboard/server/routes/offers.ts:14` defines `activeRefreshByOffer: Map<number, {refreshId, promise}>`. Line 189-193: returns the existing refresh_id if a job is in flight. Line 203, 207: clears Map entry when job settles.
- Test: `dashboard/src/__tests__/source-specific-components.test.tsx:174-200` includes a smoke unit-test of the dedupe Map semantics (a local copy of the pattern).
- **Status: RESOLVED**

### Issue 9 — outcome.errors empty-listings escalation (MEDIUM)
- File: `watcher/src/scheduler.ts:255-266`. When `outcome.errors.length > 0` AND `outcome.listings.length === 0`, the code calls `recordSourceFailure(state, db, hunt.id, sourceId, terms)` and `continue`s, exactly as suggested.
- The path threads through the same `consecutive_failures` counter / auto-pause as thrown errors.
- **Status: RESOLVED**

### Issue 10 — SettingsTab eBay Categories gate (MEDIUM)
- File: `dashboard/src/components/hunts/SettingsTab.tsx:179-180,209`. The entire `<section>` is wrapped in `{(hunt.sources?.includes('ebay') || hunt.vertical === 'computers' || !hunt.vertical) && <section>...</section>}`. Cars hunts (vertical='cars', sources=['autotrader']) will NOT render this section.
- **Status: RESOLVED**

### Issue 11 — VerticalFilter ARIA (MEDIUM)
- File: `dashboard/src/components/layout/MainLayout.tsx:35-37`. Wrapper has `role="group"` and `aria-label="Filter by vertical"`. Each button (line 44) has `aria-pressed={currentVertical === opt.value ? 'true' : 'false'}`.
- **Status: RESOLVED**

### Issue 12 — apiGet for refresh poll (MEDIUM)
- File: `dashboard/src/pages/OfferDetail.tsx:118`. `const poll = await apiGet<{ status: string }>(...)`. Matches the backend GET route at `dashboard/server/routes/offers.ts:241` (`offerRoutes.get('/offers/:id/refresh/:refreshId', ...)`).
- **Status: RESOLVED**

### Issue 13 — Legacy NULL vertical backfill (MEDIUM)
- File: `watcher/src/db.ts:294`. `db.exec("UPDATE offers SET vertical = 'computers' WHERE vertical IS NULL AND source = 'ebay'");` runs as part of `ensureSchema()`. Idempotent — only touches rows where vertical IS NULL.
- **Status: RESOLVED**

### Issue 14 — Canary preflight (MEDIUM)
- File: `scripts/at-canary.mjs:44-62`. Imports `existsSync`, checks both `watcher/dist/sources/autotrader/index.js` AND `verticals/dist/cars/translators/autotrader.js`. On missing path, prints a clear "Run `cd watcher && npx tsc && cd verticals && npx tsc` first" message and exits 2 (distinguished from runtime AT failure exit 1).
- **Status: RESOLVED**

### Issue 15 — Rate-limit JSON parse logging (LOW)
- File: `watcher/src/sources/autotrader/rate-limit.ts:78-90`. Read succeeds branch: tries `JSON.parse`; on failure, emits WARN to stderr including the file path AND the parse error, and notably does NOT overwrite the file (`starting fresh without overwriting`). Persisted backoff state is preserved for human inspection.
- **Status: RESOLVED**

### Issue 16 — Formatter location (LOW)
- File: `verticals/cars/formatter.ts:34-52`. `extractCity()` uses `/^([^(]+?)(?:\s*\(|$)/` regex which extracts everything before the first `(`. Test passes for "Leicester (3 miles)" → "Leicester" (formatter.test.ts has 20 passing tests including location cases).
- **Status: RESOLVED**

### Issue 17 — notification_formatter wiring (LOW)
- File: `watcher/src/notifier.ts:118` calls `getFormatter(formatterName)` after looking up `vConf.notification_formatter` (line 112-114).
- Registry: `watcher/src/formatters/index.ts:42-54` lazy-loads `verticals/dist/cars/formatter.js` and registers `formatCarsNotification` under name "cars" (matches `config/verticals.yml` `notification_formatter: cars`).
- Per-listing rendering: line 119-128 in notifier.ts iterates `h.newListings` and calls the formatter, with fallback to a generic line on throw.
- **Status: RESOLVED**

### Issue 18 — Translator dispatch registry (LOW)
- File: `watcher/src/translators/index.ts`. Exports `registerTranslator(vertical, source, fn)` keyed `${vertical}/${source}` and `getTranslator(vertical, source)`. Registers `computers/ebay` (line 46) and `cars/autotrader` (line 88).
- Scheduler at `scheduler.ts:241` calls `getTranslator(hunt.vertical, sourceId)`; if undefined, logs a warn and `continue`s — no more inline `sourceId === 'ebay'` switch.
- **Status: RESOLVED**

### Issue J — CLAUDE.md (DOC)
- File: `/opt/nanoclaw/CLAUDE.md:77-99`. New section reads: "Automated multi-vertical, multi-source deal-finding system. Currently supports `computers` (eBay) and `cars` (AutoTrader). Adding a T1 vertical (eBay-sourced) is a one-block edit to `config/verticals.yml`. New sources require a `SourceAdapter` implementation." Both watcher and Source adapters described with file paths. Hunt files section notes "not eBay-specific; cars hunts live here too".
- **Status: RESOLVED**

## RENAME-AUDIT delta (vs. previous audit)

Spot-checked the three top-priority items the previous audit flagged:

1. **`dashboard/src/components/hunts/SettingsTab.tsx:181` "eBay Categories"** — header still says "eBay Categories" (literal text unchanged) but the whole `<section>` is now gated by `hunt.sources?.includes('ebay') || hunt.vertical === 'computers' || !hunt.vertical`. Cars hunts never see it. **Resolved as Issue 10 — substantive gate, not a rename.**

2. **`watcher/src/scheduler.ts` inline translator switch** — gone. Replaced by `getTranslator(hunt.vertical, sourceId)` at line 241. **Resolved as Issue 18.**

3. **`container/skills/hunt-management/SKILL.md`** — still has "watcher automatically searches eBay" (line 63), "eBay search is fuzzy" (line 75), "Each search term costs 3 eBay API calls per poll" (line 73). These are computers-vertical instructional prose in a vertical-agnostic skill name. **NOT a behaviour bug.** Documentation drift — same severity as previously flagged (`needs-fix-soft`).

Other RENAME-AUDIT items I checked:
- `container/skills/requirements-discovery/SKILL.md` — still eBay-only prose. Not gated on this PR; doc drift.
- `container/agent-runner/src/deal-hunter-mcp.ts:69,273` — "eBay category IDs" descriptions; doc drift.
- `container/skills/car-listing-evaluation/SKILL.md:51` — references attribute as `price_deviation` (no `_gbp`). **Minor new finding** — single-word reference in skill prose; will not affect runtime; the canonical key is `price_deviation_gbp` everywhere in code. Suggest a one-line edit but does not gate merge.

These remaining items are documentation/prose drift and do not block merge — they're explicitly classified `needs-fix-soft` in the original RENAME-AUDIT.

## New issues found in retry

None that block merge.

Trivial doc-drift found during verification (not gating):
- `container/skills/car-listing-evaluation/SKILL.md:51`: refers to attribute as `price_deviation` rather than the canonical `price_deviation_gbp`. Suggest changing to `price_deviation_gbp` for consistency; harmless because the skill text is read by Claude, not by code.

## Recommendation

**PASS for merge.**

All 7 high-severity issues are genuinely resolved on disk, verified by reading the code (not the fix-pass summaries). The most consequential fix — Issue 1's rate-limit mutex — is empirically confirmed by both a passing unit test using fake timers (FIFO order, max-concurrent=1) AND a live mutex probe with real timers (`/tmp/mutex-probe.mjs`) measuring inter-call spacings of 5388 / 5605 / 6225 / 5771 ms — all comfortably above the 4200 ms floor.

The live AT canary returned a valid `price_tier=GOOD` against `2026059...` advertId with all 4 required attribute fields populated, proving the end-to-end Search → Translator → Adapter → fetchDetail → attribute-merge path works against the real AT GraphQL gateway.

All medium and low issues are also resolved with verifiable code changes and (where appropriate) tests.

The 4 root test failures are pre-existing (`container-runner.test.ts` config mock missing `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET`, `tool-bloat-report.test.ts` is unstaged local dev). Neither is regressed by Phase 1–3 work.

The remaining RENAME-AUDIT items are documentation/prose drift in container skills and one MCP tool description — none of them affect runtime behaviour. They can be cleaned up in a follow-up doc-only PR without blocking this merge.
