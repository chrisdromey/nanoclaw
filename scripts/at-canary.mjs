#!/usr/bin/env node
/**
 * AutoTrader canary smoke test.
 *
 * Verifies the AT adapter is functioning with a known, stable search query.
 * Exits 0 on success, non-zero on failure with a clear error message.
 *
 * PREREQUISITE: Both the watcher and verticals packages must be compiled before
 * running this script. If you get ERR_MODULE_NOT_FOUND, run:
 *   cd /opt/nanoclaw/watcher && npx tsc
 *   cd /opt/nanoclaw/verticals && npx tsc
 *
 * Usage:
 *   node /opt/nanoclaw/scripts/at-canary.mjs
 *
 * To enable as a daily systemd timer:
 *   1. Create /etc/systemd/system/at-canary.service:
 *        [Unit]
 *        Description=AutoTrader Canary Smoke Test
 *        [Service]
 *        Type=oneshot
 *        ExecStart=/usr/bin/node /opt/nanoclaw/scripts/at-canary.mjs
 *        WorkingDirectory=/opt/nanoclaw
 *        Environment=HOME=/root
 *        StandardOutput=append:/opt/nanoclaw/logs/at-canary.log
 *        StandardError=append:/opt/nanoclaw/logs/at-canary.log
 *
 *   2. Create /etc/systemd/system/at-canary.timer:
 *        [Unit]
 *        Description=Daily AutoTrader canary
 *        [Timer]
 *        OnCalendar=daily
 *        Persistent=true
 *        [Install]
 *        WantedBy=timers.target
 *
 *   3. systemctl daemon-reload
 *      systemctl enable --now at-canary.timer
 *
 * Rate limit note: This script makes 2 HTTP requests (1 search + 1 detail).
 * The adapter's built-in 6s ± 30% jitter rate limit is respected automatically.
 */

import { existsSync } from 'node:fs';

// ── Preflight: verify compiled outputs exist ───────────────────────────────────
const WATCHER_ADAPTER_PATH = '/opt/nanoclaw/watcher/dist/sources/autotrader/index.js';
const VERTICALS_TRANSLATOR_PATH = '/opt/nanoclaw/verticals/dist/cars/translators/autotrader.js';

const missingPaths = [WATCHER_ADAPTER_PATH, VERTICALS_TRANSLATOR_PATH].filter(
  (p) => !existsSync(p),
);

if (missingPaths.length > 0) {
  console.error(
    `[at-canary] ERROR: Build outputs not found at:\n` +
    missingPaths.map((p) => `  ${p}`).join('\n') + '\n' +
    `Run 'cd /opt/nanoclaw/watcher && npx tsc && cd /opt/nanoclaw/verticals && npx tsc' first.`,
  );
  process.exit(2);
}
// ──────────────────────────────────────────────────────────────────────────────

import { autotraderAdapter } from '/opt/nanoclaw/watcher/dist/sources/autotrader/index.js';
import { translateCarsCriteriaToAutotrader } from '/opt/nanoclaw/verticals/dist/cars/translators/autotrader.js';

const REQUIRED_ATTRIBUTE_FIELDS = ['mileage_num', 'fuel', 'transmission', 'body_type'];
const VALID_PRICE_TIERS = ['GREAT', 'GOOD', 'LOW', 'HIGH', 'NOANALYSIS'];

function fail(msg) {
  console.error(`[at-canary] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[at-canary] OK: ${msg}`);
}

console.log(`[at-canary] Starting AutoTrader canary smoke test — ${new Date().toISOString()}`);

// Step 1: Translate known criteria
const criteria = {
  make: 'Audi',
  model: 'A4',
  max_price: 20000,
  postcode: 'LE11AB',
};

let params;
try {
  params = translateCarsCriteriaToAutotrader(criteria);
} catch (e) {
  fail(`Translator threw: ${e.message}`);
}
ok('Translator produced params without error');

// Step 2: Search
const outcome = await autotraderAdapter.search(params);

// Check for rate-limit / block signals
const rateLimitError = outcome.errors.find(e =>
  e.error.includes('429') || e.error.includes('503') || e.error.includes('cf-mitigated') || e.error.includes('disabled')
);
if (rateLimitError) {
  console.error(`[at-canary] WARN: Rate limit / block detected: ${rateLimitError.error}`);
  // Exit 2 to distinguish rate-limit from functional failure
  process.exit(2);
}

if (outcome.errors.length > 0) {
  fail(`Search returned errors: ${JSON.stringify(outcome.errors)}`);
}

if (outcome.listings.length < 1) {
  fail(`Search returned 0 listings (expected >= 1 for Audi A4 at LE11AB)`);
}
ok(`Search returned ${outcome.listings.length} listings`);

const firstListing = outcome.listings[0];

// Verify NormalisedListing shape
const requiredListingFields = ['source', 'sourceId', 'title', 'url', 'currency', 'attributes'];
for (const field of requiredListingFields) {
  if (firstListing[field] === undefined) {
    fail(`First listing missing required field: ${field}`);
  }
}
ok(`First listing has required NormalisedListing fields`);

// Step 3: Fetch detail
const detail = await autotraderAdapter.fetchDetail(firstListing.sourceId);

if (detail.error) {
  const isRateLimit = detail.error.includes('429') || detail.error.includes('503') || detail.error.includes('cf-mitigated');
  if (isRateLimit) {
    console.error(`[at-canary] WARN: Rate limit in fetchDetail: ${detail.error}`);
    process.exit(2);
  }
  // Non-rate-limit error in detail is a soft fail — log and continue
  console.warn(`[at-canary] WARN: fetchDetail returned error (may be transient): ${detail.error}`);
}

if (!detail.listing) {
  fail(`fetchDetail returned null listing for sourceId=${firstListing.sourceId}`);
}
ok(`fetchDetail returned listing for sourceId=${firstListing.sourceId}`);

const detailAttrs = detail.listing.attributes;

// Step 4: Assert >= 4 attribute fields populated
const populatedFields = REQUIRED_ATTRIBUTE_FIELDS.filter(f => detailAttrs[f] != null);
if (populatedFields.length < 4) {
  fail(
    `fetchDetail attributes: only ${populatedFields.length}/4 required fields populated. ` +
    `Got: ${REQUIRED_ATTRIBUTE_FIELDS.map(f => `${f}=${detailAttrs[f] ?? 'null'}`).join(', ')}. ` +
    `This may indicate AT HTML structure changed.`
  );
}
ok(`fetchDetail has ${populatedFields.length}/4 required attribute fields (${populatedFields.join(', ')})`);

// Step 5: Assert price_tier is a known enum value
const priceTier = detailAttrs['price_tier'];
if (priceTier != null && !VALID_PRICE_TIERS.includes(String(priceTier))) {
  fail(`Unexpected price_tier value: ${priceTier}. Expected one of: ${VALID_PRICE_TIERS.join(', ')}`);
}
if (priceTier != null) {
  ok(`price_tier=${priceTier} (valid enum value)`);
} else {
  console.log(`[at-canary] WARN: price_tier is null — AT may not be returning price analysis for this listing`);
}

console.log(`[at-canary] PASS — AutoTrader adapter is healthy. ${new Date().toISOString()}`);
process.exit(0);
