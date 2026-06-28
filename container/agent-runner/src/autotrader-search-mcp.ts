/**
 * AutoTrader Search Tool (MCP)
 *
 * Exposes an `autotrader_search` tool for agent ad-hoc searches against
 * AutoTrader UK via /at-gateway (GraphQL). Runs inside the agent container
 * as a separate process (MCP stdio transport).
 *
 * This is a thin self-contained client — it does NOT import from the watcher.
 * Stream C will register this file in container/agent-runner/src/index.ts.
 *
 * Usage: the agent calls autotrader_search with make/model/postcode etc.
 * Returns a triage-friendly slim listing array.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- Constants ---

const AT_GATEWAY = 'https://www.autotrader.co.uk/at-gateway';
const DEFAULT_MAX_RESULTS = 20;
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

// GraphQL query — price tier not on SearchListing, excluded intentionally (Phase 0 finding)
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
        advertId
        title
        subTitle
        attentionGrabber
        price
        vehicleLocation
        images
        numberOfImages
        sellerType
        dealerLink
        trackingContext {
          advertContext { make model year condition price }
          distance { distance distance_unit }
        }
      }
    }
    page { number count results { count } }
  }
}`.replace(/\s+/g, ' ').trim();

// --- Types ---

interface ATListing {
  advertId: string;
  title: string;
  subTitle: string | null;
  attentionGrabber: string | null;
  price: string | null;
  vehicleLocation: string | null;
  images: string[];
  numberOfImages: number;
  sellerType: 'TRADE' | 'PRIVATE' | null;
  dealerLink: string | null;
  trackingContext: {
    advertContext: {
      make: string;
      model: string;
      year: number;
      condition: string;
      price: number;
    };
    distance: { distance: number; distance_unit: string | null };
  };
}

interface SlimATListing {
  advertId: string;
  title: string;
  subTitle: string | null;
  price: number | null;
  priceFormatted: string | null;
  year: number | null;
  make: string;
  model: string;
  mileage?: string | null;          // not in search response; populated by detail enrichment if done
  distanceMiles: number | null;
  location: string | null;
  sellerType: string | null;
  attentionGrabber: string | null;
  thumbnailUrl: string | null;
  url: string;
}

// --- Helpers ---

function log(msg: string): void {
  process.stderr.write(`[autotrader-search] ${msg}\n`);
}

function parsePriceString(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw.replace(/[£,\s]/g, ''));
  return isNaN(n) ? null : n;
}

function slimListing(l: ATListing): SlimATListing {
  const ctx = l.trackingContext?.advertContext;
  const thumbnail = l.images?.[0]
    ? l.images[0].replace('{resize}', THUMBNAIL_RESIZE)
    : null;

  return {
    advertId: l.advertId,
    title: l.title,
    subTitle: l.subTitle ?? null,
    price: parsePriceString(l.price),
    priceFormatted: l.price ?? null,
    year: ctx?.year ?? null,
    make: ctx?.make ?? l.title,
    model: ctx?.model ?? '',
    distanceMiles: l.trackingContext?.distance?.distance ?? null,
    location: l.vehicleLocation ?? null,
    sellerType: l.sellerType ?? null,
    attentionGrabber: l.attentionGrabber ?? null,
    thumbnailUrl: thumbnail,
    url: `https://www.autotrader.co.uk/car-details/${l.advertId}`,
  };
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// --- Search ---

interface FilterInput {
  filter: string;
  selected: string[];
}

async function searchAT(opts: {
  make: string;
  model?: string;
  postcode: string;
  max_price?: number;
  max_mileage?: number;
  year_min?: number;
  year_max?: number;
  fuel?: string;
  transmission?: string;
  page?: number;
  sortBy?: string;
}): Promise<{ listings: SlimATListing[]; total: number; page: number; error?: string }> {
  const filters: FilterInput[] = [
    { filter: 'make', selected: [opts.make] },
  ];

  if (opts.model) filters.push({ filter: 'model', selected: [opts.model] });
  if (opts.year_min != null) filters.push({ filter: 'min_year', selected: [String(opts.year_min)] });
  if (opts.year_max != null) filters.push({ filter: 'max_year', selected: [String(opts.year_max)] });
  if (opts.max_price != null) filters.push({ filter: 'max_price', selected: [String(opts.max_price)] });
  if (opts.max_mileage != null) filters.push({ filter: 'maximum_mileage', selected: [String(opts.max_mileage)] });

  filters.push({ filter: 'postcode', selected: [opts.postcode] });
  filters.push({ filter: 'price_search_type', selected: ['total'] });
  filters.push({ filter: 'home_delivery_adverts', selected: ['include'] });

  if (opts.fuel) filters.push({ filter: 'fuel-type', selected: [opts.fuel] });
  if (opts.transmission) filters.push({ filter: 'transmission', selected: [opts.transmission] });

  const payload = [
    {
      operationName: 'SearchResultsListingsGridQuery',
      variables: {
        filters,
        channel: 'cars',
        page: opts.page ?? 1,
        sortBy: opts.sortBy ?? 'relevance',
        listingType: ['NATURAL_LISTING'],
        searchId: '00000000-0000-4000-8000-000000000000',
        featureFlags: [],
      },
      query: SEARCH_QUERY,
    },
  ];

  let res: Response;
  try {
    res = await fetch(AT_GATEWAY, {
      method: 'POST',
      headers: COMMON_HEADERS,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { listings: [], total: 0, page: 1, error: String(err) };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { listings: [], total: 0, page: 1, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  type ATResponse = Array<{
    data?: {
      searchResults?: {
        listings?: ATListing[];
        page?: { number: number; count: number; results?: { count: number } };
      };
    };
    errors?: Array<{ message: string }>;
  }>;

  const json = (await res.json()) as ATResponse;
  const sr = json[0]?.data?.searchResults;

  if (!sr) {
    const gqlErr = json[0]?.errors?.map((e) => e.message).join('; ') ?? 'Unknown error';
    return { listings: [], total: 0, page: 1, error: gqlErr };
  }

  const listings = (sr.listings ?? []).map(slimListing);
  const total = sr.page?.results?.count ?? listings.length;
  const pageNum = sr.page?.number ?? 1;

  return { listings, total, page: pageNum };
}

// --- Detail page (on-demand feature verification) ---

const DETAIL_HEADERS: Record<string, string> = {
  'User-Agent': COMMON_HEADERS['User-Agent'],
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
  'Referer': 'https://www.autotrader.co.uk/car-search',
};

type AnyRec = Record<string, any>;

function keySpecVal(specs: AnyRec[] | undefined, key: string): string | null {
  if (!Array.isArray(specs)) return null;
  const item = specs.find((s) => s?.specKey === key);
  return (item?.value as string) ?? null;
}

/** Parse the advertId from a raw id or a /car-details/ URL. */
function parseAdvertId(input: string): string | null {
  const trimmed = input.trim();
  const m = trimmed.match(/car-details\/(\w+)/);
  if (m) return m[1];
  if (/^\w+$/.test(trimmed)) return trimmed;
  return null;
}

function isSoldHtml(html: string): boolean {
  return /this car has been sold/i.test(html) || /car is no longer available/i.test(html);
}

interface ATDetailResult {
  advertId: string;
  url: string;
  status: 'active' | 'removed' | 'sold';
  title: string | null;
  priceFormatted: string | null;
  priceNumeric: number | null;
  priceTier: string | null;
  priceTierLabel: string | null;
  year: number | null;
  mileage: string | null;
  fuel: string | null;
  transmission: string | null;
  bodyType: string | null;
  colour: string | null;
  seats: string | null;
  doors: string | null;
  engineLitres: string | null;
  owners: string | null;
  sellerName: string | null;
  location: string | null;
  /** Categorized equipment list (each item Standard/Optional) — for must-have feature verification. */
  features: Array<{ category: string; items: Array<{ name: string; type: string | null }> }> | null;
  /** Performance + dimensions (boot space, BHP, MPG, etc.) */
  specs: Array<{ category: string; items: Array<{ name: string; value: string | null }> }> | null;
  description: string | null;
}

function extractDetail(html: string, advertId: string, url: string): ATDetailResult | null {
  const m = html.match(
    /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("([\s\S]*?)"\);/,
  );
  if (!m) return null;
  let data: AnyRec;
  try {
    data = JSON.parse(JSON.parse('"' + m[1] + '"'));
  } catch {
    return null;
  }
  const advert: AnyRec | undefined = data?.loaderData?.['car-details']?.aggregatorAdvert;
  if (!advert) return null;

  const heading: AnyRec = advert.heading ?? {};
  const keySpec: AnyRec[] = advert.keySpecification ?? [];
  const priceObj: AnyRec = heading?.priceBreakdown?.price ?? {};
  const pills: AnyRec[] = heading?.headingPills ?? [];
  const mileagePill = pills.find((p) => /miles/i.test(p?.label ?? ''));
  const seller: AnyRec = advert.seller ?? {};
  const loc: AnyRec = seller.location ?? {};
  const postcode = loc.postcode ?? loc.postCode ?? null;
  const locationText = loc.town
    ? postcode ? `${loc.town}, ${postcode}` : loc.town
    : postcode;

  const features = Array.isArray(advert?.featuresWithDisclaimer?.features)
    ? advert.featuresWithDisclaimer.features
        .map((c: AnyRec) => ({
          category: (c.category as string) ?? (c.title as string) ?? 'Other',
          items: (Array.isArray(c.items) ? c.items : [])
            .filter((i: AnyRec) => i?.name)
            .map((i: AnyRec) => ({ name: i.name as string, type: (i.type as string) ?? null })),
        }))
        .filter((c: AnyRec) => c.items.length > 0)
    : null;

  const specs = Array.isArray(advert?.specs)
    ? advert.specs
        .map((c: AnyRec) => ({
          category: (c.category as string) ?? 'Other',
          items: (Array.isArray(c.items) ? c.items : [])
            .filter((i: AnyRec) => i?.name)
            .map((i: AnyRec) => ({ name: i.name as string, value: (i.value as string) ?? null })),
        }))
        .filter((c: AnyRec) => c.items.length > 0)
    : null;

  const descText = advert?.description?.text;
  const description = Array.isArray(descText)
    ? descText.filter((t: unknown) => typeof t === 'string').join('\n').trim() || null
    : (typeof descText === 'string' ? descText.trim() || null : null);

  return {
    advertId,
    url,
    status: isSoldHtml(html) ? 'sold' : 'active',
    title: (heading?.title as string) ?? null,
    priceFormatted: (priceObj?.priceFormatted as string) ?? null,
    priceNumeric: (priceObj?.price as number) ?? null,
    priceTier: (heading?.priceIndicator as string) ?? null,
    priceTierLabel: (heading?.priceIndicatorLabel as string) ?? null,
    year: keySpecVal(keySpec, 'REGISTRATION')?.match(/(\d{4})/)?.[1]
      ? parseInt(keySpecVal(keySpec, 'REGISTRATION')!.match(/(\d{4})/)![1], 10)
      : null,
    mileage: (mileagePill?.label as string) ?? keySpecVal(keySpec, 'MILEAGE'),
    fuel: keySpecVal(keySpec, 'FUELTYPE'),
    transmission: keySpecVal(keySpec, 'GEARBOX'),
    bodyType: keySpecVal(keySpec, 'BODYTYPE'),
    colour: keySpecVal(keySpec, 'COLOUR') ?? keySpecVal(keySpec, 'BODYCOLOUR'),
    seats: keySpecVal(keySpec, 'SEATS'),
    doors: keySpecVal(keySpec, 'DOORS'),
    engineLitres: keySpecVal(keySpec, 'ENGINESIZELITRES'),
    owners: keySpecVal(keySpec, 'OWNERS'),
    sellerName: (seller?.name as string) ?? null,
    location: locationText,
    features,
    specs,
    description,
  };
}

// Detail-page cache — repeated opens (daily reviews, re-checks of the same listing) are
// served from disk so we don't re-hit AutoTrader and risk being flagged as a bot. TTL keeps
// it reasonably fresh; pass fresh=true to bypass (e.g. re-checking a watched price).
const DETAIL_CACHE_DIR =
  process.env['AT_DETAIL_CACHE_DIR'] ?? path.join(os.tmpdir(), 'autotrader-detail-cache');
const DETAIL_CACHE_TTL_MS =
  (parseInt(process.env['AT_DETAIL_CACHE_TTL_MIN'] ?? '360', 10) || 360) * 60_000;

function cachePathFor(advertId: string): string {
  return path.join(DETAIL_CACHE_DIR, `${advertId.replace(/[^\w-]/g, '')}.json`);
}

function readDetailCache(advertId: string): ATDetailResult | null {
  try {
    const p = cachePathFor(advertId);
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs > DETAIL_CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ATDetailResult;
  } catch {
    return null;
  }
}

function writeDetailCache(advertId: string, result: ATDetailResult): void {
  try {
    fs.mkdirSync(DETAIL_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePathFor(advertId), JSON.stringify(result));
  } catch {
    // best-effort cache; ignore write failures
  }
}

async function fetchDetailAT(
  advertId: string,
  useCache = true,
): Promise<{ result?: ATDetailResult; error?: string; cached?: boolean }> {
  if (useCache) {
    const cached = readDetailCache(advertId);
    if (cached) return { result: cached, cached: true };
  }
  const url = `https://www.autotrader.co.uk/car-details/${advertId}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: DETAIL_HEADERS });
  } catch (err) {
    return { error: String(err) };
  }
  if (res.status === 404) {
    const removed: ATDetailResult = {
      advertId, url, status: 'removed',
      title: null, priceFormatted: null, priceNumeric: null, priceTier: null,
      priceTierLabel: null, year: null, mileage: null, fuel: null, transmission: null,
      bodyType: null, colour: null, seats: null, doors: null, engineLitres: null,
      owners: null, sellerName: null, location: null, features: null, specs: null,
      description: null,
    };
    writeDetailCache(advertId, removed);
    return { result: removed, cached: false };
  }
  if (!res.ok) return { error: `HTTP ${res.status}` };

  const html = await res.text();
  const result = extractDetail(html, advertId, url);
  if (!result) return { error: 'Could not extract detail data from page' };
  writeDetailCache(advertId, result);
  return { result, cached: false };
}

// --- MCP Server ---

const server = new McpServer({
  name: 'autotrader-search',
  version: '1.0.0',
});

server.tool(
  'autotrader_search',
  'Search AutoTrader UK for used car listings. Returns a triage-friendly list with price, year, mileage (if available), location, and seller info. Note: price tier (Great/Good/Lower price) is only available on individual car detail pages, not in search results.',
  {
    make: z.string().describe('Car make in proper case, e.g. "Audi", "BMW", "Ford"'),
    postcode: z
      .string()
      .describe('UK postcode without spaces for proximity sorting, e.g. "LE11AB" or "SW1A1AA"'),
    model: z.string().optional().describe('Car model, e.g. "A4", "3 Series", "Focus"'),
    max_price: z
      .number()
      .optional()
      .describe('Maximum total price in GBP (uses price_search_type=total)'),
    max_mileage: z.number().optional().describe('Maximum mileage'),
    year_min: z.number().optional().describe('Minimum year, e.g. 2016'),
    year_max: z.number().optional().describe('Maximum year, e.g. 2022'),
    fuel: z
      .string()
      .optional()
      .describe('Fuel type, e.g. "Petrol", "Diesel", "Electric", "Hybrid"'),
    transmission: z
      .string()
      .optional()
      .describe('Transmission type, e.g. "Automatic", "Manual"'),
    page: z.number().min(1).default(1).describe('Page number (20 results per page)'),
    sort_by: z
      .enum(['relevance', 'price-asc', 'distance'])
      .optional()
      .describe('Sort order (default: relevance)'),
    limit: z
      .number()
      .optional()
      .describe(`Max results to return from the page (default ${DEFAULT_MAX_RESULTS})`),
  },
  async ({
    make,
    postcode,
    model,
    max_price,
    max_mileage,
    year_min,
    year_max,
    fuel,
    transmission,
    page,
    sort_by,
    limit,
  }) => {
    log(
      `autotrader_search: make=${make} model=${model ?? '-'} postcode=${postcode} ` +
        `max_price=${max_price ?? '-'} page=${page}`,
    );

    const result = await searchAT({
      make,
      model,
      postcode,
      max_price,
      max_mileage,
      year_min,
      year_max,
      fuel,
      transmission,
      page,
      sortBy: sort_by,
    });

    if (result.error && result.listings.length === 0) {
      return errorResult(result.error);
    }

    const effectiveLimit = limit ?? DEFAULT_MAX_RESULTS;
    const sliced = result.listings.slice(0, effectiveLimit);

    return jsonResult({
      total_found: result.total,
      page: result.page,
      returned: sliced.length,
      note: 'Price tier (Great/Good/Lower price) requires a detail-page fetch per listing and is not included here. Use the watcher\'s fetchDetail() for enriched data.',
      listings: sliced,
      ...(result.error ? { warning: result.error } : {}),
    });
  },
);

server.tool(
  'autotrader_detail',
  'Fetch one AutoTrader listing\'s detail page and return its full equipment/features list, specs, price tier, and seller description. Use this to VERIFY a brief\'s must-have features (e.g. adaptive cruise, lane assist) on a specific car: the `features` array is grouped by category (e.g. "Drivers Assistance") and each item is tagged Standard or Optional. Also returns specs (boot space, BHP, MPG, dimensions), seats/doors, and the seller description. Call it for alert candidates after triage.',
  {
    advert_id: z
      .string()
      .describe('AutoTrader advert id, or a full car-details URL (the id will be parsed out)'),
    fresh: z
      .boolean()
      .optional()
      .describe('Bypass the cache and re-fetch from AutoTrader. Default false — repeated opens are served from a short-lived cache to avoid re-hitting the site. Use only when you need an up-to-the-minute price/state (e.g. re-checking a watched listing).'),
  },
  async ({ advert_id, fresh }) => {
    const id = parseAdvertId(advert_id);
    if (!id) return errorResult(`Could not parse an advert id from "${advert_id}"`);
    log(`autotrader_detail: advertId=${id} fresh=${fresh ?? false}`);
    const { result, error, cached } = await fetchDetailAT(id, !fresh);
    if (error || !result) return errorResult(error ?? 'Unknown error fetching detail');
    return jsonResult({ ...result, _cached: cached ?? false });
  },
);

// --- Start Server ---

const transport = new StdioServerTransport();
await server.connect(transport);
