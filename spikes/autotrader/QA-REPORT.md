# Phase 4 Adversarial QA Report

**Date:** 2026-06-28
**Reviewer:** Opus 4.7 (Phase 4 gate)

## Summary

- **Issues found: 18** (high: 7, medium: 7, low: 4)
- **Issues fixed by me: 0** (this gate finds; the fix pass implements)
- **Areas cleared with evidence: 4** (A regression hunting; rate-limit jitter; basic source dispatch isolation; YAML loader inherit/error handling)
- **Hard-gate decision: FAIL** — 7 high-severity issues. Most pressing are the broken AT rate-limit mutex (F-1 critical), the dashboard's raw-fetch bypass of AT rate-limit + kill switch (F-2 critical), and the scheduler never calling `fetchDetail()` for AT new listings (B-1 critical).

The implementation is mostly sound at the structural level (registry, types, per-source error isolation, dispatch). However the AT integration has **integration-level holes** that are invisible from typecheck and unit tests but break the most important runtime guarantees: rate-limit honesty, kill-switch coverage, and AT field population.

---

## Issues found

### Issue 1: AT rate-limit mutex does NOT serialise concurrent calls — fires bursts after first interval

- **Severity:** high
- **File:** `watcher/src/sources/autotrader/rate-limit.ts:110-170`
- **What:** `acquireLock()` is `while (inflight) { await inflight; }`. Multiple parallel callers all await the same `inflight` promise; when it resolves they ALL exit the loop in the same microtask burst, then all overwrite `inflight = ticket` and run their fetch concurrently. There is no true mutex.
- **Why it breaks:** I ran the live mutex test (`/tmp/test-mutex.mjs`) against the compiled adapter with 5 concurrent `rateLimitedFetch()` calls, a 50ms mock fetch, and base interval = 6s. Result: call 1 fires immediately, call 2 fires 5814ms later (the first jitter wait), then **calls 3/4/5 fire 601ms, 715ms, and 496ms apart** — well below the 4.2s lower bound of the jittered min-interval. Three sub-second requests in a row is exactly what Cloudflare/AT bot-management is configured to flag. The dashboard "Refresh All Watching" path makes this trivially reachable: hit it with 10 watched AT offers and you'll fire ~9 requests in 5–6 seconds.
- **Repro:**
  ```
  cd /opt/nanoclaw/watcher && npx tsc
  node /tmp/test-mutex.mjs
  ```
  (script captured in chat; can be recreated from this report)
- **Suggested fix:** Replace the broken mutex with a proper chained promise: `inflight = inflight.then(() => doFetch())`. Each caller awaits the previous chain head and appends. Add a unit test that fires 5 parallel calls and asserts strictly monotonic call timestamps spaced ≥ 0.7 × BASE_INTERVAL_MS apart.
- **Phase 2 stream owner:** B (AutoTrader adapter)

### Issue 2: Dashboard AT status check bypasses rate-limit AND kill switch

- **Severity:** high
- **File:** `dashboard/server/sources/autotrader.ts:19-62`
- **What:** `checkOfferStatus` uses raw `fetch()` directly. It does NOT go through `rateLimitedFetch()`, does NOT respect the persisted backoff state, and does NOT check `AUTOTRADER_DISABLED=1`. The kill switch in `watcher/src/sources/autotrader/rate-limit.ts:24` only blocks the watcher process; the dashboard server is a separate process and will continue to hammer AT even when the kill switch is engaged.
- **Why it breaks:** Two failure modes:
  1. **Refresh storms.** `POST /hunts/:id/refresh-watching` (routes/hunts.ts:399) iterates ALL watching offers sequentially with `await checkOfferStatusBySource(...)`. For 20 watching AT cars, this is 20 unthrottled GETs in ~5–10s. Sequential, but well above AT's 6s floor and likely to trip `cf-mitigated`.
  2. **Kill-switch defeat.** If AT is angry and the operator sets `AUTOTRADER_DISABLED=1` on the watcher service, every dashboard refresh-click still fires a live request.
  Additionally the dashboard adapter is wired through the same `sources/index.ts` switch as eBay, so anything calling `checkOfferStatusBySource('autotrader', ...)` is uncovered.
- **Repro:** Create 3 watching AT offers; click "Refresh Watching" on the hunt page; observe network panel — three GETs hit AT with no spacing.
- **Suggested fix:** The dashboard should either (a) import and reuse `rateLimitedFetch` from the watcher's compiled `dist/` (shared module), or (b) share a JSON state file with the watcher and re-implement the same guard. Option (a) is correct: factor `rate-limit.ts` to a shared package, persist state in a known path, and import from both processes. Also honour `AUTOTRADER_DISABLED` in the dashboard adapter.
- **Phase 2 stream owner:** D (dashboard) + B (rate-limit shape)

### Issue 3: Scheduler NEVER calls `fetchDetail()` for new AT listings — price_tier/mileage/fuel are silently empty

- **Severity:** high
- **File:** `watcher/src/scheduler.ts:237-281` (tick search loop); `watcher/src/sources/autotrader/index.ts:55-65` (adapter exposes fetchDetail but unused)
- **What:** The scheduler's tick() calls only `adapter.search(nativeParams)` and writes the resulting `NormalisedListing[]` via `applyNormalisedResults()`. For AT this populates only the search-level fields: title, price, vehicleLocation, sellerType, make/model/year. The mileage, fuel, transmission, body_type, **and especially `price_tier`** all come from `fetchDetail()`, which is never invoked.
- **Why it breaks:**
  - The notification formatter (`verticals/cars/formatter.ts`) gates the `(AT: …)` segment on `price_tier`; that field is always null at notification time, so **the primary deal signal — the AT price tier — is never in the notification line**.
  - The dashboard's `CarAttributesBlock` shows "—" for mileage/fuel/transmission/body forever.
  - The `attributes_required` list in `config/verticals.yml` for the `cars` block is documented but not enforced anywhere — the system happily writes listings with none of those fields populated.
  The rollout doc admits this in "Known caveats" as "The scheduler calls `fetchDetail()` for top-N new listings per tick (configurable)" — but the implementation does not include this logic. It's missing entirely.
- **Repro:** Set up a cars hunt and let it tick; query `SELECT json_extract(attributes, '$.price_tier') FROM offers WHERE source='autotrader';` — all NULL.
- **Suggested fix:** Inside `tick()` after `applyNormalisedResults()`, for any `NormalisedListing` that came back from a `capabilities.needsDetailFetch` source AND is `isNew`, call `adapter.fetchDetail(sourceId)` (respecting the per-source rate-limit and budget). Use the result to UPDATE the offer row's attributes JSON. Cap at N=10 per tick. Account each detail fetch in `apiCalls`.
- **Phase 2 stream owner:** A (scheduler) + B (adapter)

### Issue 4: `verticals.yml` path bug in watcher startup — vertical validation silently disabled in production

- **Severity:** high
- **File:** `watcher/src/index.ts:18-21`
- **What:** `VERTICALS_CONFIG_PATH = resolve(fileURLToPath(import.meta.url), '../../../../config/verticals.yml')`. `resolve()` interprets the first arg as a directory, so with `fileURLToPath(import.meta.url) = /opt/nanoclaw/watcher/dist/index.js`, the result is `/opt/config/verticals.yml`. The file doesn't exist there. The `try/catch` swallows ENOENT and logs a WARN, then the function returns without validating any hunt's `vertical`.
  Confirmed with `node -e "const {resolve}=require('node:path'); const {fileURLToPath}=require('node:url'); console.log(resolve(fileURLToPath('file:///opt/nanoclaw/watcher/dist/index.js'), '../../../../config/verticals.yml'))"` → `/opt/config/verticals.yml`.
- **Why it breaks:** The whole purpose of `validateActiveHuntVerticals` is to catch typos and stale verticals before they bite. Currently any active hunt with a misspelled `vertical` column passes startup, then later breaks notifications (when `getVertical()` throws and the notifier falls back to 'listing-evaluation' — masking the bug further). The 1936 legacy offers with `vertical=NULL` are independent of this; this concerns hunt verticals.
- **Repro:** `cd /opt/nanoclaw && ls /opt/config/verticals.yml` → ENOENT. Restart watcher and look at startup logs for "Could not load verticals.yml — skipping vertical validation".
- **Suggested fix:** `import { dirname } from 'node:path';` and change to `resolve(dirname(fileURLToPath(import.meta.url)), '../../config/verticals.yml')`. **Important — also harden the watcher's other loader** at `watcher/src/verticals.ts:14` (this one IS correct, uses `dirname`); the asymmetry between the two should be resolved by deleting `watcher/src/index.ts`'s ad-hoc YAML read and reusing `getVerticals()` from `verticals.ts`.
- **Phase 2 stream owner:** A (watcher dispatch + integration)

### Issue 5: Detail-page tests skipped silently — fixture path is one directory too high

- **Severity:** high
- **File:** `watcher/src/sources/autotrader/detail.test.ts:20`
- **What:** `FIXTURE_PATH = path.resolve(__dirname, '../../../../../spikes/autotrader/03-price-tier/samples/06-detail-page.html')`. With `__dirname = /opt/nanoclaw/watcher/src/sources/autotrader/`, going up 5 levels lands at `/opt/`, not `/opt/nanoclaw/`. The correct relative is 4 dots: `../../../../spikes/...`.
- **Why it breaks:** The most important regression test — extracting `priceIndicator`, `priceIndicatorLabel`, mileage, fuel, transmission, etc. from the captured spike #3 HTML — is **silently skipped** in every test run. The test output shows `↓ src/sources/autotrader/detail.test.ts > extractDetailData (from captured spike #3 HTML) > fixture not found at /opt/spikes/autotrader/03-price-tier/samples/06-detail-page.html`. The fixture actually exists at `/opt/nanoclaw/spikes/autotrader/03-price-tier/samples/06-detail-page.html` (274684 bytes, contains `__staticRouterHydrationData`).
  This means the canary script is the ONLY thing exercising the detail-page parser, and it's only meaningful when AT is reachable. CI runs cannot catch a regression.
- **Repro:** `cd /opt/nanoclaw/watcher && npx vitest run src/sources/autotrader/detail.test.ts 2>&1 | grep -i fixture`.
- **Suggested fix:** Change `../../../../../` to `../../../../` (drop one `../`). Add an `it.fails`-style fallback when fixture is genuinely absent in CI (vs. silently skipping). Run the test, confirm the 5+ extraction assertions pass.
- **Phase 2 stream owner:** B (AutoTrader adapter)

### Issue 6: `price_deviation` (watcher) vs `price_deviation_gbp` (dashboard) — field-name mismatch

- **Severity:** high
- **File:** `watcher/src/sources/autotrader/detail.ts:208,336` writes `attributes.price_deviation`; `dashboard/src/components/source-specific/CarAttributesBlock.tsx:54` reads `attributes.price_deviation_gbp`.
- **What:** Two sources of truth on the attribute key. The dashboard test (`dashboard/src/__tests__/source-specific-components.test.tsx:66`) uses `price_deviation_gbp: -1732`, so the test passes — but production data from the AT adapter writes `price_deviation`. The dashboard "X below market" annotation will never render.
- **Why it breaks:** The most user-visible cars feature (the deviation badge under "Price tier") is dead in production. The watcher formatter `verticals/cars/formatter.ts` ignores `price_deviation` entirely — so the formatter doesn't show it either. The deviation signal is computed and discarded.
- **Repro:** After the scheduler's fetchDetail is wired (Issue 3), query an AT offer's attributes and observe `price_deviation: -1732` in the row but no "below market" rendering on `/offers/:id`.
- **Suggested fix:** Pick one canonical key. Recommend `price_deviation_gbp` everywhere (more specific). Update `watcher/src/sources/autotrader/detail.ts` (two sites) and `verticals/cars/formatter.ts` (add the segment to notifications). Then the test fixture is already correct.
- **Phase 2 stream owner:** B (adapter) + D (dashboard alignment)

### Issue 7: Cars attributes `seller_type` / `location_text` are documented but never written

- **Severity:** high
- **File:** `config/verticals.yml:29-38` (declares `attributes_required: [..., seller_type, location_text, ...]`); `watcher/src/sources/autotrader/search.ts:101-139` (writes `vehicleLocation`, top-level `sellerType`); `verticals/cars/formatter.ts:67-68` (reads `location_text`, falls back to `vehicleLocation`); `dashboard/src/components/source-specific/CarAttributesBlock.tsx:48-49` (reads `seller_type`, `location_text`).
- **What:** The vertical config promises certain attribute keys are populated. None of the AT writes use those exact keys:
  - `sellerType` lives at top-level `NormalisedListing.sellerType` (a typed enum), not inside `attributes`. Dashboard expects `attributes.seller_type` (string). Result: dashboard shows blank.
  - `vehicleLocation` exists in attributes; `location_text` does not. Dashboard expects `location_text`. Result: blank.
- **Why it breaks:** The CarAttributesBlock's "Seller" and "Location" rows never render for AT listings. The formatter test passes because it falls back to `vehicleLocation`, but the dashboard has no such fallback.
- **Suggested fix:** Either rename writes (watcher) or unify on a single canonical name. Recommend the watcher writes BOTH (transitional) or the dashboard reads the canonical `vehicleLocation` / top-level `sellerType`. Document the schema in one place: a `verticals/cars/schema.ts` exporting the canonical attribute key list.
- **Phase 2 stream owner:** B (adapter), D (dashboard)

### Issue 8: Concurrent dashboard refresh requests on same offer fire duplicate AT detail fetches

- **Severity:** medium
- **File:** `dashboard/server/routes/offers.ts:176-189`
- **What:** Two `POST /offers/:id/refresh` requests for the same offer create two `refresh_id`s, store two promises in `pendingRefreshJobs`, and fire two parallel calls to `checkOfferStatusBySource()`. There is no per-offer deduplication.
- **Why it breaks:** A double-click on the Refresh button = 2 AT requests. Combined with Issue F-1 (broken mutex) and Issue F-2 (no rate-limit on dashboard adapter), this is a cheap way to trigger Cloudflare backoff during normal use.
- **Suggested fix:** Add a `Map<offerId, refreshId>` to deduplicate active refreshes; if a refresh is in flight for that offer, return the existing `refresh_id` with status 202.
- **Phase 2 stream owner:** D (dashboard)

### Issue 9: AT response with missing `data.searchResults` produces "Unknown error" — not loudly enough

- **Severity:** medium
- **File:** `watcher/src/sources/autotrader/search.ts:190-194`
- **What:** When the GraphQL gateway returns 200 but the field selection failed or the body shape changed, the adapter logs `gqlErrors` if present and otherwise a literal "Unknown error". The error is appended to `outcome.errors` but the tick loop only `logger.warn`s (scheduler.ts:251-253) and continues; consecutive-failures only fires on thrown errors, not on outcome.errors.
- **Why it breaks:** If AT does a frontend rewrite that, for example, renames `searchResults` to `searchResultsV2`, every tick will silently produce zero listings forever. consecutive_failures never increments, so the source is never auto-paused. The only signal is in the WARN log, which nobody is monitoring.
- **Suggested fix:** Treat "search succeeded but produced 0 listings AND outcome.errors is non-empty" as a failure for failure-counter accounting. Or expose a separate `search_health_failures` counter. Wire the canary script into a daily alert.
- **Phase 2 stream owner:** A (scheduler) / B (adapter)

### Issue 10: ServiceSettingsTab shows "eBay Categories" header for non-eBay hunts

- **Severity:** medium
- **File:** `dashboard/src/components/hunts/SettingsTab.tsx:181`
- **What:** A literal `<h3>eBay Categories</h3>` is rendered for every hunt regardless of vertical/source. For a `cars` hunt this exposes an eBay-specific configuration input that has no meaning.
- **Why it breaks:** UX regression. Editing it on a cars hunt writes `category_ids` into the DB but the AT adapter ignores it. User confusion guaranteed.
- **Suggested fix:** Gate the whole "Categories" section on `hunt.sources.includes('ebay') || hunt.vertical === 'computers'`. Long term: drive the settings form from `vertical.criteria_schema`.
- **Phase 2 stream owner:** D (dashboard)

### Issue 11: Vertical-filter buttons are not real `<button>` semantics — fine, but lacking aria

- **Severity:** medium
- **File:** `dashboard/src/components/layout/MainLayout.tsx:36-49`
- **What:** The vertical filter is three `<button>` elements without `aria-pressed` or `role="group"`. Screen readers cannot announce the current selection.
- **Why it breaks:** Accessibility regression compared to the pre-extraction OfferDetail bits which had no such filter at all (so technically a new feature missing a11y, not a regression in the strict sense).
- **Suggested fix:** Add `role="radiogroup"` to the wrapper and `aria-pressed={currentVertical === opt.value}` (or `role="radio"` + `aria-checked`) to each button. Add a `<label>` or visually-hidden text describing the control.
- **Phase 2 stream owner:** D (dashboard)

### Issue 12: `OfferDetail.tsx:117` polls async refresh with `apiPost` (POST), but route is GET

- **Severity:** medium
- **File:** `dashboard/src/pages/OfferDetail.tsx:117` calls `apiPost(`/offers/${offerId}/refresh/${result.refresh_id}`)`; backend route is `offerRoutes.get('/offers/:id/refresh/:refreshId', ...)` (routes/offers.ts:216).
- **What:** Verb mismatch. Polling a refresh status with POST.
- **Why it breaks:** Depending on Hono's routing, POST to a GET-only route returns 404 or 405. Polling fails, user sees "Failed to check listing status" toast, but the underlying job did succeed. Confusing.
- **Suggested fix:** Change to `apiGet`. Add a test that exercises the AT path end-to-end.
- **Phase 2 stream owner:** D (dashboard)

### Issue 13: 1936 legacy offers have `vertical=NULL` — dashboard reads are forgiving but flow assumes `vertical` to be set

- **Severity:** medium
- **File:** verified via `sqlite3 /opt/nanoclaw/groups/telegram_main/deal-hunter.db "SELECT vertical, source, COUNT(*) FROM offers GROUP BY vertical, source;"` → `|ebay|1936` (NULL) + `computers|ebay|239`
- **What:** Legacy eBay offers were intentionally left with `vertical=NULL` per Phase 1 plan. `OfferDetail.tsx:284` checks `offer.vertical === 'cars'` to render `<CarAttributesBlock>` — NULL is fine here. But `offer.vertical === 'computers'` checks (none exist in OfferDetail; `OffersTab.tsx:48` does `isComputers = !hunt.vertical || hunt.vertical === 'computers'` — uses **hunt** vertical, not offer — so legacy offers display correctly via the hunt context).
- **Why it breaks:** Mostly OK because Stream D consistently uses `hunt.vertical` for tab-level decisions and `offer.vertical` only for offer-specific blocks. BUT: any future code that reads `offer.vertical` without `??'computers'` fallback will silently fail for legacy rows. The watcher's `upsertNormalisedListing` writes the current vertical on every update, so over time the NULLs get backfilled — but only for offers that are re-seen in searches.
- **Suggested fix:** One-time migration: `UPDATE offers SET vertical='computers' WHERE vertical IS NULL;`. Lands in ensureSchema or a one-shot script. Add a code lint that disallows `offer.vertical === 'X'` without fallback.
- **Phase 2 stream owner:** A (foundation)

### Issue 14: AT canary script imports from compiled paths — fails on a fresh worktree

- **Severity:** medium
- **File:** `/opt/nanoclaw/scripts/at-canary.mjs:39-40`
- **What:** Imports from `/opt/nanoclaw/watcher/dist/sources/autotrader/index.js` and `/opt/nanoclaw/verticals/dist/cars/translators/autotrader.js`. Both require a prior `npx tsc` run in their respective directories. The script has no precondition check; first run after a fresh checkout fails with ERR_MODULE_NOT_FOUND, exits 1, looks like a real AT failure.
- **Why it breaks:** Operator runs canary, sees "FAIL", panics. Real issue is "you need to `tsc` first." Same trap as the `multi-vertical-rollout.md` `puppeteer-core` typecheck note.
- **Suggested fix:** At the top of canary, check `fs.existsSync(import.meta.url-paths)` and exit with a clear "Run `cd watcher && npx tsc && cd verticals && npx tsc` first" message. Or use tsx and import from source.
- **Phase 2 stream owner:** B (adapter, canary)

### Issue 15: `rateLimitedFetch` malformed-JSON state file: silently starts fresh, no log

- **Severity:** low
- **File:** `watcher/src/sources/autotrader/rate-limit.ts:46-60`
- **What:** `loadState()` catches all errors and "starts fresh". If `data/rate-limit-state.json` has invalid JSON (corrupted half-write after kernel panic, say), the watcher silently discards persisted backoff state and proceeds. An active backoff would be lost.
- **Why it breaks:** Low severity because the next 429 will re-engage backoff. But it defeats the persistence property the doc claims. Operator can't trust that restart respects backoff.
- **Suggested fix:** Log a WARN with the bad-state file path and the JSON parse error. Don't write-overwrite the file until the next successful state mutation.
- **Phase 2 stream owner:** B

### Issue 16: `cars` formatter's `shortPostcode` never matches AT's real location strings

- **Severity:** low
- **File:** `verticals/cars/formatter.ts:35-42`
- **What:** Regex `\b([A-Z]{1,2}\d{1,2})\b` against typical AT `vehicleLocation: "Leicester (3 miles)"` — "Leicester" doesn't match (no leading digit), so no postcode segment is rendered. The target format in the plan (`"... · LE3 · ..."`) is unreachable from the data AT actually returns.
- **Why it breaks:** Notification line is less informative than promised.
- **Suggested fix:** Either keep the city name verbatim ("Leicester") instead of trying to extract a postcode, or extract the city name regex (`^([^(]+)`) trimmed — that's what AT actually gives.
- **Phase 2 stream owner:** B (formatter)

### Issue 17: `notification_formatter: cars` is configured but the notifier never invokes it

- **Severity:** low
- **File:** `watcher/src/notifier.ts` (no reference to `formatCarsNotification` anywhere); `config/verticals.yml:28` declares `notification_formatter: cars`.
- **What:** The cars formatter exists at `verticals/cars/formatter.ts` and has comprehensive tests, but the watcher's notifier ignores `vertical.notification_formatter`. The notifier just builds a generic prompt and asks the evaluator skill to format. So the configured per-vertical formatter is unused.
- **Why it breaks:** The "target output" from the plan (`"2018 Audi A4 2.0 TDI · 67k mi · £14,995 (AT: Great price) · LE3 · trade · [link]"`) is what the formatter produces, but nothing in the runtime path runs it. The Telegram notification's body comes from whatever the evaluator agent writes, not from the formatter.
- **Suggested fix:** Either (a) wire the new-offer notification to use the per-vertical formatter for each listing, or (b) accept that formatting is the evaluator's job and delete the formatter / move it inside the cars-evaluator skill. The current state is debt either way.
- **Phase 2 stream owner:** A (notifier) + C (skills)

### Issue 18: Inline `ebay-only` translator inside scheduler is a hidden coupling

- **Severity:** low
- **File:** `watcher/src/scheduler.ts:237-246`
- **What:** The TODO comment says "translators will be loaded from verticals/<vertical>/translators/<source>.ts" but the actual code is `if (sourceId === 'ebay') { ebayParamsFromHunt(...) } else { /* generic */ }`. For cars, the AT GraphQL translator (`verticals/cars/translators/autotrader.ts`) is never invoked from the watcher path — only from the agent-runner MCP. So a `cars`/`autotrader` hunt that the watcher polls will produce a malformed search request: the adapter expects `{ filters: [...] }` but receives `{ terms, categoryIds }`.
- **Why it breaks:** The first time someone enables a real watcher-driven AT hunt, the AT adapter will throw on the missing `filters` field. (Phase 3's "audi-a4-smoke" hunt worked because it was driven from the agent-runner, not the scheduler tick.) The hunt-to-cars wiring through the watcher is fundamentally not exercised by existing tests.
- **Suggested fix:** Either (a) move the inline translator out of the scheduler and load `verticals/<vertical>/translators/<source>.{ts,js}` dynamically, or (b) parse `hunt.criteria` for cars hunts and call `translateCarsCriteriaToAutotrader()` inline. Add a unit test: `tick()` for a `cars`/`autotrader` hunt produces the right AT params.
- **Phase 2 stream owner:** A (scheduler)

---

## Areas explicitly cleared (with evidence)

### A. Regression hunting — eBay legacy tick path
- Read `scheduler.ts:tick()` line by line. Verified: parses `hunt.sources` via `parseSourcesFromRow()` defaulting to `["ebay"]`; dispatches to `getAdapter('ebay')`; `searchEbay()` is called via `EbayAdapter.search()`; `applyNormalisedResults()` writes prices via `recordPrice()` and associates with hunt.
- Verified `recordSearch` is called inside the transaction with `source='ebay'` (db.ts:540).
- Verified `change-detector.ts` reads `getLatestPrice()` from the `prices` table — same path that worked before, so eBay watch-poll change detection is unaffected.
- Ran `npx vitest run` in `watcher/` — 79 passed, 1 skipped (Issue F-5 is the skipped one). The scheduler dispatch tests cover eBay-only, eBay+AT-mixed (with per-source isolation), failure counting, auto-pause, budget enforcement.
- Queried production DB: 6 hunts, all `vertical='computers' sources=["ebay"]`, no breakage of legacy hunt status.
- **Verdict:** clean. Legacy eBay flow is preserved.

### B. Source dispatch failure modes (sources=[] / sources=[unknown])
- Read `scheduler.ts:210-282`. For each source in `hunt.sources`, `hasAdapter()` is checked at line 218; if absent, `logger.error` and `continue`. For `sources=[]`, the inner loop simply never runs and the hunt is skipped cleanly. Per-source try/catch isolates failures.
- Tested via `scheduler.test.ts:212-241` "runs eBay even when AutoTrader throws" — passes.
- **Verdict:** clean structurally. (But see Issue 9: outcome.errors with empty listings is not punished.)

### C. Vertical registry inherit chain + loader error handling
- `src/verticals/loader.ts:64-92` and `watcher/src/verticals.ts:57-92` both: detect `inherit === key` and throw; validate `inherit` target exists; require `_default` block; require `evaluator_skill` after resolution.
- `src/verticals/loader.test.ts` exercises malformed YAML, missing `_default`, circular inherit, missing `evaluator_skill`, and the cars block. All pass.
- Loader cache is module-level; the watcher does not restart on config changes, so editing `verticals.yml` requires a watcher restart. Acceptable; documented in rollout doc.
- The watcher's `verticals.ts` SHIM duplicates `src/verticals/loader.ts` — same structure, separate cache. Both correctly resolve `inherit: _default`. The duplication is debt but not a bug.
- **Verdict:** clean. (Pair this with Issue 4: the SHIM is right, but watcher's startup validation in `index.ts` uses ad-hoc YAML reading via a buggy path — see issue 4.)

### D. AT rate-limit envelope (jitter and backoff persistence — but NOT the mutex, see Issue 1)
- Read `rate-limit.ts:76-79`: jitter is `0.7 + Math.random() * 0.6` = correct ±30% window around base. The 6s base × ±30% = 4.2–7.8s.
- Read `enterBackoff()`: doubles from 60s up to 1h cap, persists to disk via `saveState()`.
- `loadState()` is called once at module import — survives restart.
- Backoff tests in `rate-limit.test.ts` cover 429, 503, `cf-mitigated` header — all passing.
- The kill switch (`AUTOTRADER_DISABLED=1`) throws synchronously at the top of `rateLimitedFetch` — covered by test.
- **Verdict:** envelope OK, kill-switch OK, backoff persistence OK. **BUT** the mutex is broken (Issue 1) and the dashboard bypasses everything (Issue 2). These are dispatcher-level issues, not envelope-level.

---

## Schema migration safety (spot-checked, not a full clear)

- `ensureSchema()` is additive-only — checks `PRAGMA table_info` before each `ALTER TABLE ADD COLUMN`. Idempotent.
- Verified live DB schema via `.schema hunts` and `.schema offers`: `vertical TEXT NOT NULL DEFAULT 'computers'`, `sources TEXT NOT NULL DEFAULT '["ebay"]'`, `poll_interval_minutes INTEGER`, `vertical TEXT`, `attributes TEXT DEFAULT '{}'`. All present and correct.
- `attributes='{}'` JSON parsing: defensive via `parseAttributes()` in `watcher/src/db.ts:78-88`. Dashboard route uses `parseJsonField()` (offers.ts:6-9). Both have safe fallbacks. Verified no place reads `JSON.parse(offer.attributes)` directly without try/catch (grep'd).
- Mark this area as **mostly clean** with the caveat in Issue 13 (legacy NULL verticals).

---

## CLAUDE.md correctness (Issue J)

The "Deal Hunter" section in `/opt/nanoclaw/CLAUDE.md:77-94` predates Phase 1–3 and now misdescribes the system. Specifically:

- Line 79: "Automated eBay UK deal-finding system with three components" — should be "multi-vertical, multi-source deal-finding system".
- Line 83: "Watcher | … | Polls eBay, triggers agent evaluations" — should be "Polls configured sources (eBay, AutoTrader, …)".
- Line 85: Agent MCP description is fine.
- **Missing**: no mention of `config/verticals.yml`, no mention of the source adapter pattern, no instructions for adding a T1 vertical.

**Suggested concrete edits:**
```diff
-Automated eBay UK deal-finding system with three components:
+Automated multi-vertical, multi-source deal-finding system. Currently supports
+`computers` (eBay) and `cars` (AutoTrader). Adding a T1 vertical (eBay-sourced) is a one-block edit
+to `config/verticals.yml`. New sources require a `SourceAdapter` implementation.

 | Component | Service | Purpose |
 |-----------|---------|---------|
-| Watcher | `deal-hunter-watcher.service` | Polls eBay, triggers agent evaluations |
+| Watcher | `deal-hunter-watcher.service` | Polls all configured sources, triggers agent evaluations |
 | Dashboard | `deal-hunter-dashboard.service` | Web UI for hunts, offers, activity |
 | Agent MCP | `container/agent-runner/src/deal-hunter-mcp.ts` | DB tools for the container agent |

+**Verticals:** declared in `config/verticals.yml`. The watcher's `verticals.ts` and the
+orchestrator's `src/verticals/loader.ts` both parse this file. Adding a T1 vertical is documented
+in `docs/delhunter/multi-vertical-rollout.md`.
+
+**Source adapters:** live in `watcher/src/sources/<name>/`. Each implements the `SourceAdapter`
+interface (`watcher/src/sources/types.ts`). The eBay adapter is in `sources/ebay/`; AutoTrader in
+`sources/autotrader/`. The dashboard has parallel adapters in `dashboard/server/sources/`.
+
 **Database:** `groups/telegram_main/deal-hunter.db` (SQLite). Schema is managed by the watcher's `ensureSchema()` in `watcher/src/db.ts` — runs at watcher startup.
```

Plus the "Hunt files" line should mention that per-vertical hunts may not be eBay-related.

Severity: medium — documentation drift is a real onboarding tax for future Claude sessions.

---

## Cross-cutting: container build / local typecheck

- `container/agent-runner/`'s `puppeteer-core` typecheck error on the host is **pre-existing**, confirmed by the rollout doc's note. Not a Phase 1–3 regression.
- The container's own Dockerfile installs dependencies fresh — runtime is fine.
- Severity: deferred, not blocking.

---

## RENAME-AUDIT

See `/opt/nanoclaw/spikes/autotrader/RENAME-AUDIT.md` for the full file:line list with classifications.

Top-priority items from the audit:
1. `dashboard/src/components/hunts/SettingsTab.tsx:181` — "eBay Categories" header shown for non-eBay hunts (Issue 10)
2. `watcher/src/scheduler.ts:115,237-246` — inline eBay-only translator switch with stale TODO (Issue 18)
3. `CLAUDE.md:79,83` — eBay-only system description (Issue J)
4. `container/skills/hunt-management/SKILL.md` and `HUNT-PHILOSOPHY.md` — eBay-only philosophical framing in a vertical-agnostic skill

---

## Recommendations for the fix pass

**Highest priority (high-severity, block merge):**
1. Fix the rate-limit mutex (Issue 1) — this is the most consequential silent failure. Code is small; the test plan is clear.
2. Wire the dashboard AT adapter through `rateLimitedFetch` and honour `AUTOTRADER_DISABLED` (Issue 2). Factor `rate-limit.ts` into a shared location.
3. Make the scheduler call `fetchDetail()` for new AT listings (Issue 3). Without this, the cars feature literally doesn't deliver its primary signal.
4. Fix the verticals.yml path in watcher/src/index.ts (Issue 4) — one-line fix.
5. Fix the detail.test.ts fixture path (Issue 5) — one-character fix, then verify the price_tier extraction tests actually exercise.
6. Reconcile `price_deviation` vs `price_deviation_gbp` (Issue 6) — choose one, update three sites.
7. Reconcile `seller_type` / `location_text` attribute keys (Issue 7) — touches 3 modules.

**Medium priority (medium-severity, fix before next phase but not necessarily before merge):**
- Issues 8 (dedupe refresh), 9 (loud GraphQL shape failures), 10 (SettingsTab), 11 (a11y), 12 (verb mismatch), 13 (legacy NULL verticals).

**Low priority (cleanup, do during next maintenance window):**
- Issues 14 (canary preflight check), 15 (rate-limit state JSON logging), 16 (formatter location), 17 (notification_formatter wiring), 18 (translator dispatch refactor).
- Tech-debt rename items from `RENAME-AUDIT.md` flagged `needs-fix-soft`.

**Phase 4 outcome: FAIL.** Re-run after Issues 1–7 are addressed.
