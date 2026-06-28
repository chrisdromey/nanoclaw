/**
 * AutoTrader GraphQL search — ports spike #1's graphql.mjs to TypeScript.
 *
 * Sends a SearchResultsListingsGridQuery to /at-gateway and normalises
 * the response to NormalisedListing[].
 *
 * NOTE: price tier is NOT available on the SearchListing type (Phase 0 confirmed).
 * It requires a detail-page fetch — see detail.ts.
 */

import { rateLimitedFetch, AutoTraderDisabledError } from './rate-limit.js';
import type { AutotraderSearchParams, ATSearchResponse, ATSearchListing, ATPageInfo } from './types.js';
import type { NormalisedListing, SearchOutcome } from '../types.js';

const AT_GATEWAY = 'https://www.autotrader.co.uk/at-gateway';

// Default thumbnail resize string — replace {resize} placeholder
const THUMBNAIL_RESIZE = 'w480h360';

const COMMON_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Content-Type': 'application/json',
  'Origin': 'https://www.autotrader.co.uk',
  'Referer': 'https://www.autotrader.co.uk/car-search',
  'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'x-sauron-app-name': 'sauron-search-results-app',
  'x-sauron-app-version': 'unknown',
};

// GraphQL query — unchanged from spike #1; price tier not available on SearchListing
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
}`.replace(/\s+/g, ' ').trim();

/** Parse "£14,995" → 14995, or null if unparseable. */
export function parsePriceString(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw.replace(/[£,\s]/g, ''));
  return isNaN(n) ? null : n;
}

/** Substitute {resize} in AT image URLs with a sensible default. */
export function resolveImageUrl(url: string, resize = THUMBNAIL_RESIZE): string {
  return url.replace('{resize}', resize);
}

/** Map a raw ATSearchListing to a NormalisedListing. */
/** Conversion factor: 1 km = 0.621371 miles. */
const KM_TO_MILES = 0.621371;

export function normaliseSearchListing(listing: ATSearchListing, pageInfo?: ATPageInfo): NormalisedListing {
  const advertId = listing.advertId;
  const ctx = listing.trackingContext?.advertContext;

  // Fix 6: AT usually returns distance in miles (distance_unit null/"miles"), but if it
  // ever reports km, store distance_miles correctly converted rather than mislabelling.
  const rawDistance = listing.trackingContext?.distance?.distance ?? null;
  const distanceUnit = listing.trackingContext?.distance?.distance_unit ?? null;
  const distanceMiles =
    rawDistance == null
      ? null
      : distanceUnit && distanceUnit.toLowerCase() === 'km'
        ? Math.round(rawDistance * KM_TO_MILES)
        : rawDistance;

  const thumbnail = listing.images?.[0]
    ? resolveImageUrl(listing.images[0])
    : undefined;

  return {
    source: 'autotrader',
    sourceId: advertId,
    title: listing.title,
    url: `https://www.autotrader.co.uk/car-details/${advertId}`,
    priceGbp: parsePriceString(listing.price),
    currency: 'GBP',
    thumbnailUrl: thumbnail,
    sellerType: listing.sellerType ?? null,
    condition: null,
    buyingFormat: null,
    auctionEndTime: null,
    bidCount: null,
    attributes: {
      subTitle: listing.subTitle ?? null,
      attentionGrabber: listing.attentionGrabber ?? null,
      // Canonical dashboard/formatter keys (Issue 7):
      location_text: listing.vehicleLocation ?? null,   // e.g. "Leicester (3 miles)"
      seller_type: listing.sellerType                   // mirrors top-level sellerType for dashboard
        ? listing.sellerType.toLowerCase()              // 'trade' | 'private'
        : null,
      // Keep vehicleLocation for formatter fallback compatibility
      vehicleLocation: listing.vehicleLocation ?? null,
      distance_miles: distanceMiles,   // normalised to miles (see Fix 6 / distance_unit)
      distance_unit: distanceUnit,     // raw unit AT reported (null usually means miles)
      make: ctx?.make ?? null,
      model: ctx?.model ?? null,
      year: ctx?.year ?? null,
      image_count: listing.numberOfImages ?? null,
      ...(pageInfo ? {
        page_number: pageInfo.number,
        page_count: pageInfo.count,
        results_count: pageInfo.results?.count ?? null,
      } : {}),
    },
  };
}

/** Execute one AT search request; returns raw outcome. */
export async function searchAutotrader(params: AutotraderSearchParams): Promise<SearchOutcome> {
  const page = params.page ?? 1;
  const sortBy = params.sortBy ?? 'relevance';

  const payload = [
    {
      operationName: 'SearchResultsListingsGridQuery',
      variables: {
        filters: params.filters,
        channel: 'cars',
        page,
        sortBy,
        listingType: ['NATURAL_LISTING'],
        searchId: '00000000-0000-4000-8000-000000000000',
        featureFlags: [],
      },
      query: SEARCH_QUERY,
    },
  ];

  let res: Response;
  try {
    res = await rateLimitedFetch(AT_GATEWAY, {
      method: 'POST',
      headers: COMMON_HEADERS,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // The kill switch throws before any fetch — let it propagate so the adapter
    // (index.ts) reports apiCalls:0 + scope:'disabled' rather than over-counting.
    if (err instanceof AutoTraderDisabledError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return { listings: [], apiCalls: 1, errors: [{ scope: 'search', error: msg }] };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      listings: [],
      apiCalls: 1,
      errors: [{ scope: 'search', error: `HTTP ${res.status}: ${body.slice(0, 200)}` }],
    };
  }

  let json: ATSearchResponse[];
  try {
    json = (await res.json()) as ATSearchResponse[];
  } catch {
    return { listings: [], apiCalls: 1, errors: [{ scope: 'parse', error: 'Response is not JSON' }] };
  }

  const data = json[0]?.data?.searchResults;
  if (!data) {
    const gqlErrors = json[0]?.errors?.map((e) => e.message).join('; ') ?? 'Unknown error';
    return { listings: [], apiCalls: 1, errors: [{ scope: 'graphql', error: gqlErrors }] };
  }

  // pageInfo may be absent/partial; guard before dereferencing (Fix 4).
  const pageInfo = (data.page ?? undefined) as ATPageInfo | undefined;
  const rawListings = (data.listings ?? []) as ATSearchListing[];

  // The GraphQL `listings` union can include non-SearchListing members that
  // deserialise as `{}` (no advertId). Drop those before mapping so we never emit
  // listings with undefined sourceId/title (Fix 4).
  const listings = rawListings
    .filter((l) => l && typeof l.advertId === 'string' && l.advertId.length > 0)
    .map((l) => normaliseSearchListing(l, pageInfo));

  return {
    listings,
    apiCalls: 1,
    sourceMeta: {
      page: {
        number: pageInfo?.number ?? page,
        count: pageInfo?.count ?? null,
        results: { count: pageInfo?.results?.count ?? 0 },
      },
    },
    errors: [],
  };
}

export { COMMON_HEADERS, THUMBNAIL_RESIZE };
