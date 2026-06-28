// Phase 0 — AutoTrader Price-Tier GraphQL Discovery
// Speculative field requests against /at-gateway to find priceIndicatorRating
// on the SearchListing type. AT returns helpful schema errors, so we use
// deliberate bad-field queries to probe what's available.
//
// Also validates 6s+jitter rate-limit envelope (5 requests at that pace).
//
// Usage: node probe-price-tier.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, 'samples');
await mkdir(SAMPLES, { recursive: true });

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Content-Type': 'application/json',
  Origin: 'https://www.autotrader.co.uk',
  Referer:
    'https://www.autotrader.co.uk/car-search?postcode=LE11AB&make=AUDI&model=A4',
  'Sec-Ch-Ua':
    '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'x-sauron-app-name': 'sauron-search-results-app',
  'x-sauron-app-version': 'unknown',
};

const BASE_VARIABLES = {
  filters: [
    { filter: 'make', selected: ['Audi'] },
    { filter: 'model', selected: ['A4'] },
    { filter: 'max_price', selected: ['15000'] },
    { filter: 'postcode', selected: ['LE11AB'] },
    { filter: 'price_search_type', selected: ['total'] },
    { filter: 'home_delivery_adverts', selected: ['include'] },
  ],
  channel: 'cars',
  page: 1,
  sortBy: 'relevance',
  listingType: ['NATURAL_LISTING'],
  searchId: '00000000-0000-4000-8000-000000000000',
  featureFlags: [],
};

// Jitter: ±30% of base interval
function jitter(baseMs) {
  return baseMs * (0.7 + Math.random() * 0.6);
}

async function graphqlPost(label, query, variables = BASE_VARIABLES) {
  const payload = [{ operationName: 'PriceTierProbe', variables, query }];
  const url = 'https://www.autotrader.co.uk/at-gateway';
  console.log(`\n[${label}] POST ${url}`);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: COMMON_HEADERS,
    body: JSON.stringify(payload),
  });
  const elapsed = Date.now() - t0;
  const text = await res.text();
  const cfMitigated = res.headers.get('cf-mitigated');
  const cfRay = res.headers.get('cf-ray');

  const headerLines = [...res.headers.entries()]
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  await writeFile(
    join(SAMPLES, `${label}.headers.txt`),
    `Status: ${res.status}\nElapsed: ${elapsed}ms\ncf-mitigated: ${cfMitigated}\ncf-ray: ${cfRay}\n\n${headerLines}`,
  );
  await writeFile(join(SAMPLES, `${label}.body.txt`), text);

  console.log(`  -> ${res.status} (${text.length} bytes, ${elapsed}ms)`);
  console.log(`  cf-mitigated: ${cfMitigated || 'none'}`);
  if (text.length < 3000) console.log(`  body: ${text.slice(0, 2000)}`);

  return { status: res.status, text, cfMitigated };
}

// ─── Probe 1: priceIndicatorRating directly on SearchListing ─────────────────
const QUERY_PRICE_INDICATOR = `query PriceTierProbe(
  $filters: [FilterInput!]!,
  $channel: Channel!,
  $page: Int,
  $sortBy: SearchResultsSort,
  $listingType: [ListingType!],
  $searchId: String!,
  $featureFlags: [FeatureFlag]
) {
  searchResults(input: {
    facets: [],
    filters: $filters,
    channel: $channel,
    page: $page,
    sortBy: $sortBy,
    listingType: $listingType,
    searchId: $searchId,
    featureFlags: $featureFlags
  }) {
    listings {
      ... on SearchListing {
        advertId
        price
        priceIndicatorRating
        priceIndicatorRatingLabel
      }
    }
    page { number count }
  }
}`;

// ─── Probe 2: priceIndicator as object (in case it's a nested type) ───────────
const QUERY_PRICE_INDICATOR_OBJ = `query PriceTierProbe(
  $filters: [FilterInput!]!,
  $channel: Channel!,
  $page: Int,
  $sortBy: SearchResultsSort,
  $listingType: [ListingType!],
  $searchId: String!,
  $featureFlags: [FeatureFlag]
) {
  searchResults(input: {
    facets: [],
    filters: $filters,
    channel: $channel,
    page: $page,
    sortBy: $sortBy,
    listingType: $listingType,
    searchId: $searchId,
    featureFlags: $featureFlags
  }) {
    listings {
      ... on SearchListing {
        advertId
        price
        priceIndicator {
          rating
          label
        }
      }
    }
    page { number count }
  }
}`;

// ─── Probe 3: alternative field name candidates ───────────────────────────────
const QUERY_ALT_NAMES = `query PriceTierProbe(
  $filters: [FilterInput!]!,
  $channel: Channel!,
  $page: Int,
  $sortBy: SearchResultsSort,
  $listingType: [ListingType!],
  $searchId: String!,
  $featureFlags: [FeatureFlag]
) {
  searchResults(input: {
    facets: [],
    filters: $filters,
    channel: $channel,
    page: $page,
    sortBy: $sortBy,
    listingType: $listingType,
    searchId: $searchId,
    featureFlags: $featureFlags
  }) {
    listings {
      ... on SearchListing {
        advertId
        price
        priceRating
        dealRating
        valuation
        priceLabel
      }
    }
    page { number count }
  }
}`;

// ─── Probe 4: introspection ──────────────────────────────────────────────────
const QUERY_INTROSPECTION = `{ __schema { types { name fields { name } } } }`;

// ─── Probe 5: introspection on SearchListing specifically ────────────────────
const QUERY_INTROSPECT_SEARCH_LISTING = `{
  __type(name: "SearchListing") {
    name
    fields {
      name
      type { name kind ofType { name kind } }
    }
  }
}`;

async function main() {
  const results = [];

  // ── Step 1: priceIndicatorRating scalar fields ──
  console.log('\n═══ Probe 1: priceIndicatorRating + priceIndicatorRatingLabel scalar ═══');
  const r1 = await graphqlPost('01-price-indicator-scalar', QUERY_PRICE_INDICATOR);
  results.push({ probe: 1, label: 'priceIndicatorRating scalar', ...r1 });

  const delay1 = jitter(6000);
  console.log(`\nWaiting ${Math.round(delay1)}ms...`);
  await sleep(delay1);

  // ── Step 2: priceIndicator as object ──
  console.log('\n═══ Probe 2: priceIndicator as nested object ═══');
  const r2 = await graphqlPost('02-price-indicator-object', QUERY_PRICE_INDICATOR_OBJ);
  results.push({ probe: 2, label: 'priceIndicator nested object', ...r2 });

  const delay2 = jitter(6000);
  console.log(`\nWaiting ${Math.round(delay2)}ms...`);
  await sleep(delay2);

  // ── Step 3: alternate field names ──
  console.log('\n═══ Probe 3: alternate field names (priceRating, dealRating, valuation, priceLabel) ═══');
  const r3 = await graphqlPost('03-alt-field-names', QUERY_ALT_NAMES);
  results.push({ probe: 3, label: 'alt field names', ...r3 });

  const delay3 = jitter(6000);
  console.log(`\nWaiting ${Math.round(delay3)}ms...`);
  await sleep(delay3);

  // ── Step 4: introspection on SearchListing type ──
  console.log('\n═══ Probe 4: introspect SearchListing type ═══');
  const INTROSPECT_PAYLOAD = [{
    operationName: null,
    variables: {},
    query: QUERY_INTROSPECT_SEARCH_LISTING,
  }];
  const url = 'https://www.autotrader.co.uk/at-gateway';
  console.log(`  POST ${url}`);
  const res4 = await fetch(url, {
    method: 'POST',
    headers: COMMON_HEADERS,
    body: JSON.stringify(INTROSPECT_PAYLOAD),
  });
  const text4 = await res4.text();
  const cfMit4 = res4.headers.get('cf-mitigated');
  await writeFile(join(SAMPLES, '04-introspect-search-listing.body.txt'), text4);
  await writeFile(
    join(SAMPLES, '04-introspect-search-listing.headers.txt'),
    [...res4.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'),
  );
  console.log(`  -> ${res4.status} (${text4.length} bytes), cf-mitigated: ${cfMit4 || 'none'}`);
  if (text4.length < 5000) console.log(`  body: ${text4}`);
  results.push({ probe: 4, label: 'introspect SearchListing', status: res4.status, cfMitigated: cfMit4, text: text4 });

  const delay4 = jitter(6000);
  console.log(`\nWaiting ${Math.round(delay4)}ms...`);
  await sleep(delay4);

  // ── Step 5: rate-limit validation — 5 more requests at 6s±30% ──
  console.log('\n═══ Rate-limit envelope validation (5 sequential requests) ═══');
  const BASE = `query PriceTierProbe(
  $filters: [FilterInput!]!,
  $channel: Channel!,
  $page: Int,
  $sortBy: SearchResultsSort,
  $listingType: [ListingType!],
  $searchId: String!,
  $featureFlags: [FeatureFlag]
) {
  searchResults(input: {
    facets: [], filters: $filters, channel: $channel, page: $page,
    sortBy: $sortBy, listingType: $listingType, searchId: $searchId,
    featureFlags: $featureFlags
  }) {
    listings { ... on SearchListing { advertId price } }
    page { number count }
  }
}`;

  const rateResults = [];
  for (let i = 1; i <= 5; i++) {
    const r = await graphqlPost(`05-rate-limit-${i}`, BASE);
    rateResults.push({
      seq: i,
      status: r.status,
      cfMitigated: r.cfMitigated || 'none',
      bytes: r.text.length,
    });
    if (i < 5) {
      const d = jitter(6000);
      console.log(`  Waiting ${Math.round(d)}ms before next...`);
      await sleep(d);
    }
  }

  // ── Summary ──
  console.log('\n\n═══ SUMMARY ═══');
  for (const r of results) {
    const parsed = (() => { try { return JSON.parse(r.text); } catch { return null; } })();
    const errors = parsed?.[0]?.errors;
    const data = parsed?.[0]?.data;
    const hasData = data?.searchResults?.listings?.length > 0;
    const sample = data?.searchResults?.listings?.[0];
    console.log(`\nProbe ${r.probe}: ${r.label}`);
    console.log(`  Status: ${r.status}, cf-mitigated: ${r.cfMitigated || 'none'}`);
    if (errors) {
      console.log(`  Errors (${errors.length}):`);
      for (const e of errors.slice(0, 5)) console.log(`    - ${e.message}`);
    }
    if (hasData) {
      console.log(`  Listings returned: ${data.searchResults.listings.length}`);
      console.log(`  Sample fields on first listing: ${JSON.stringify(Object.keys(sample || {}))}`);
      if (sample?.priceIndicatorRating !== undefined) {
        console.log(`  *** priceIndicatorRating: ${sample.priceIndicatorRating}`);
        console.log(`  *** priceIndicatorRatingLabel: ${sample.priceIndicatorRatingLabel}`);
      }
    }
  }

  console.log('\nRate-limit results:');
  for (const r of rateResults) {
    console.log(`  Request ${r.seq}: status=${r.status}, cf-mitigated=${r.cfMitigated}, bytes=${r.bytes}`);
  }

  await writeFile(
    join(SAMPLES, 'summary.json'),
    JSON.stringify({ probes: results.map(r => ({ ...r, text: r.text?.slice(0, 500) })), rateLimit: rateResults }, null, 2),
  );

  console.log('\nDone. Files written to samples/');
}

main().catch(e => { console.error(e); process.exit(1); });
