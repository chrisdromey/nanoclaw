// Extended copy of spike #1's graphql.mjs — annotated with price-tier outcome.
//
// KEY FINDING (spike #3): priceIndicatorRating does NOT exist on SearchListing.
// AT exposes price tier only on the `Advert` type (SEO / detail pages).
//
// This file shows:
//   1. The unchanged search query (no price-tier fields possible)
//   2. A detail-page enrichment function that extracts price tier from
//      window.__staticRouterHydrationData on /car-details/<advertId>
//
// Usage: node graphql-with-detail-enrichment.mjs

import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, 'samples');

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

// ─── SEARCH QUERY (unchanged from spike #1) ───────────────────────────────────
// priceIndicatorRating is NOT on SearchListing — do not add it.
// Confirmed by speculative probe: AT returns GRAPHQL_VALIDATION_FAILED for
// priceIndicatorRating, priceIndicatorRatingLabel, priceIndicator, priceRating,
// dealRating, valuation, priceLabel — none exist on this type.
const SEARCH_QUERY = `query SearchResultsListingsGridQuery(
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
        type
        advertId
        title
        subTitle
        attentionGrabber
        price
        vehicleLocation
        locationType
        discount
        images
        numberOfImages
        rrp
        sellerType
        dealerLink
        fpaLink
        hasDigitalRetailing
        preReg
        position
        trackingContext {
          advertContext { id make model year condition price vehicleCategory }
          distance { distance distance_unit }
        }
      }
    }
    page { number count results { count } }
    trackingContext { searchId }
  }
}`;

// ─── DETAIL-PAGE ENRICHMENT ───────────────────────────────────────────────────
// Fetch /car-details/<advertId> and extract price tier from the SSR'd
// window.__staticRouterHydrationData JSON blob.
//
// Price tier enum values: "GREAT" | "GOOD" | "LOW" | "HIGH" | "NOANALYSIS"
// Labels:                 "Great price" | "Good price" | "Lower price" | "Higher price" | ""
//
// Also extracts: mileage, price breakdown, deviation (£ vs market average).

function extractDetailData(html) {
  // AT migrated FPA to React Router; data is in __staticRouterHydrationData,
  // not AT_APOLLO_STATE (which is empty on detail pages).
  const m = html.match(
    /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("([\s\S]*?)"\);/
  );
  if (!m) return null;

  let data;
  try {
    // Double JSON.parse: outer string is JSON-encoded, inner is the actual data
    data = JSON.parse(JSON.parse('"' + m[1] + '"'));
  } catch {
    return null;
  }

  const advert   = data?.loaderData?.['car-details']?.aggregatorAdvert;
  const heading  = advert?.heading;
  const trackCtx = advert?.trackingContext;

  return {
    // ── Price tier (primary deal signal) ──
    priceIndicator:      heading?.priceIndicator,        // "LOW" | "GREAT" | "GOOD" | "HIGH" | "NOANALYSIS"
    priceIndicatorLabel: heading?.priceIndicatorLabel,   // "Lower price" | "Great price" | etc.
    deviation:           trackCtx?.priceIndicatorContext?.deviation, // £ below (<0) or above (>0) market avg

    // ── Spec fields not in search response ──
    mileage: heading?.headingPills?.find(p => /miles/.test(p.label))?.label, // "55,010 miles"

    // ── Price details ──
    priceFormatted: heading?.priceBreakdown?.price?.priceFormatted, // "£10,989"
    priceNumeric:   heading?.priceBreakdown?.price?.price,          // 10989
    priceDeviation: heading?.priceBreakdown?.price?.deviation,      // "£1,732 below market average"
  };
}

// Fallback if __staticRouterHydrationData is absent (page structure change):
function extractDetailDataFallback(html) {
  // Price tier enum from the SVG gauge <title> element
  const svgTitle = html.match(
    /data-testid="price-indicator-gauge"[\s\S]{0,2000}?<title>([\w]+)<\/title>/
  )?.[1]; // "LOW" | "GREAT" | "GOOD" | "HIGH"
  // Note: CSS classes like "sc-1n64n0d-9 gjLVgM" are hashed — do NOT use as selectors.
  return { priceIndicator: svgTitle ?? null };
}

// ─── JITTER ──────────────────────────────────────────────────────────────────
// Rate-limit envelope: 6s base ±30% jitter — confirmed safe across 10 requests
// with no cf-mitigated headers from UK residential IP (spike #3 evidence).
function jitter(baseMs = 6000) {
  return Math.round(baseMs * (0.7 + Math.random() * 0.6));
}

// ─── DEMO RUN ─────────────────────────────────────────────────────────────────
async function main() {
  // 1. Search
  const payload = [
    {
      operationName: 'SearchResultsListingsGridQuery',
      variables: {
        filters: [
          { filter: 'make',                  selected: ['Audi'] },
          { filter: 'model',                 selected: ['A4'] },
          { filter: 'max_price',             selected: ['15000'] },
          { filter: 'postcode',              selected: ['LE11AB'] },
          { filter: 'price_search_type',     selected: ['total'] },
          { filter: 'home_delivery_adverts', selected: ['include'] },
        ],
        channel: 'cars',
        page: 1,
        sortBy: 'relevance',
        listingType: ['NATURAL_LISTING'],
        searchId: '00000000-0000-4000-8000-000000000000',
        featureFlags: [],
      },
      query: SEARCH_QUERY.replace(/\s+/g, ' ').trim(),
    },
  ];

  console.log('Step 1: search...');
  const searchRes = await fetch('https://www.autotrader.co.uk/at-gateway', {
    method: 'POST',
    headers: COMMON_HEADERS,
    body: JSON.stringify(payload),
  });
  const searchJson = await searchRes.json();
  const listings = searchJson[0]?.data?.searchResults?.listings ?? [];
  console.log(`  -> ${listings.length} listings`);

  // 2. Pick top-3 candidates (in production: filter by price/distance first)
  const candidates = listings.slice(0, 3);

  // 3. Enrich each with detail-page price tier
  const enriched = [];
  for (const listing of candidates) {
    const delay = jitter();
    console.log(`\nWaiting ${delay}ms...`);
    await sleep(delay);

    const detailUrl = `https://www.autotrader.co.uk/car-details/${listing.advertId}`;
    console.log(`Fetching ${detailUrl}`);
    const detailRes = await fetch(detailUrl, {
      headers: {
        ...COMMON_HEADERS,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': undefined,
        Origin: undefined,
        'Sec-Fetch-Mode': 'navigate',
        'x-sauron-app-name': undefined,
        'x-sauron-app-version': undefined,
      },
    });
    const html = await detailRes.text();
    const detail = extractDetailData(html) ?? extractDetailDataFallback(html);

    enriched.push({ ...listing, detail });
    console.log(
      `  -> ${listing.advertId} | ${listing.price} | tier=${detail?.priceIndicator} | label="${detail?.priceIndicatorLabel}" | deviation=${detail?.deviation} | mileage=${detail?.mileage}`
    );
  }

  await writeFile(join(SAMPLES, 'enriched-results.json'), JSON.stringify(enriched, null, 2));
  console.log('\nDone. Saved samples/enriched-results.json');
}

main().catch(e => { console.error(e); process.exit(1); });
