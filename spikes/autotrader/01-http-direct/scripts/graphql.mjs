// Probe the AutoTrader public GraphQL gateway at /at-gateway.
// We saw an unauthenticated 200 response on a no-op query in the prior spike;
// here we try the real SearchResultsListingsGridQuery with corrected enum
// values (lowercase 'cars', 'relevance', NATURAL_LISTING).
//
// Usage: node graphql.mjs

import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', 'samples');

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

const QUERY = `query SearchResultsListingsGridQuery(
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

const variables = {
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

const payload = [
  {
    operationName: 'SearchResultsListingsGridQuery',
    variables,
    query: QUERY.replace(/\s+/g, ' ').trim(),
  },
];

async function attempt(label, url, body, extraHeaders = {}) {
  console.log(`\n[${label}] POST ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const headers = [...res.headers.entries()]
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  await writeFile(
    join(SAMPLES, `${label}.headers.txt`),
    `Status: ${res.status}\nFinal URL: ${res.url}\nBytes: ${text.length}\n\n${headers}`,
  );
  await writeFile(join(SAMPLES, `${label}.body.txt`), text);
  console.log(`  -> ${res.status} (${text.length} bytes)`);
  if (text.length < 1500) console.log('  body:', text);
  return { status: res.status, text };
}

async function main() {
  // 1. /at-gateway — primary GraphQL endpoint per the bundle
  await attempt('graphql-at-gateway', 'https://www.autotrader.co.uk/at-gateway', payload);
  await sleep(4000);

  // 2. /at-graphql — alternative path also referenced
  await attempt('graphql-at-graphql', 'https://www.autotrader.co.uk/at-graphql', payload);
  await sleep(4000);

  // 3. /at-gateway with no Sec-Fetch / Origin (loose bot test)
  await attempt(
    'graphql-at-gateway-loose',
    'https://www.autotrader.co.uk/at-gateway',
    payload,
    {
      Origin: '',
      Referer: '',
      'Sec-Fetch-Site': 'none',
    },
  );
}

main().catch((e) => {
  console.error('GraphQL probe failed:', e);
  process.exit(1);
});
