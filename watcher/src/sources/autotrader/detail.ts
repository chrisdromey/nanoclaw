/**
 * AutoTrader detail-page enrichment.
 *
 * Fetches GET /car-details/<advertId>, extracts window.__staticRouterHydrationData,
 * double-JSON.parses, and pulls price tier + spec fields.
 *
 * Path to price tier (Phase 0 confirmed):
 *   loaderData["car-details"].aggregatorAdvert.heading.priceIndicator       → enum
 *   loaderData["car-details"].aggregatorAdvert.heading.priceIndicatorLabel  → label
 *   (deviation from priceBreakdown.price.deviation text)
 *
 * CSS classes on rendered cards are hashed — never use as selectors.
 */

import { rateLimitedFetch, AutoTraderDisabledError } from './rate-limit.js';
import type { ATDetailData, ATFeatureCategory, ATSpecCategory } from './types.js';
import type { NormalisedListing, DetailOutcome } from '../types.js';

const AT_BASE = 'https://www.autotrader.co.uk';

const DETAIL_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
  'Referer': 'https://www.autotrader.co.uk/car-search',
};

/** Parse mileage string to number — "55,010 miles" → 55010 */
function parseMileageNum(mileageText: string | null): number | null {
  if (!mileageText) return null;
  const n = parseInt(mileageText.replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? null : n;
}

/**
 * Parse £ deviation from text — "£1,732 below market average" → -1732,
 * "£500 above market average" → +500.
 */
function parseDeviationText(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(/£([\d,]+)\s+(below|above)/i);
  if (!m) return null;
  const amount = parseInt(m[1].replace(/,/g, ''), 10);
  return isNaN(amount) ? null : (m[2].toLowerCase() === 'below' ? -amount : amount);
}

/** Extract registration plate text — "2015 (65 reg)" → "65 reg" */
function parseRegistrationPlate(regText: string | null): string | null {
  if (!regText) return null;
  const m = regText.match(/\(([^)]+reg[^)]*)\)/i);
  return m ? m[1] : null;
}

/**
 * Normalise AT's advertiserType ("dealer" | "trade" | "private") to the canonical
 * lowercase seller_type used across the dashboard/formatter ('trade' | 'private').
 */
function normaliseSellerType(advertiserType: string | null): 'trade' | 'private' | null {
  if (!advertiserType) return null;
  const t = advertiserType.toLowerCase();
  if (t === 'dealer' || t === 'trade') return 'trade';
  if (t === 'private') return 'private';
  return null;
}

/** Extract colour from keySpecification array */
function extractSpecValue(
  specs: Array<{ label: string; value: string; specKey: string }> | null,
  key: string,
): string | null {
  if (!specs) return null;
  const item = specs.find((s) => s.specKey === key);
  return item?.value ?? null;
}

/**
 * Extract the categorized equipment list from aggregatorAdvert.featuresWithDisclaimer.features.
 * Each category (e.g. "Drivers Assistance") lists items with a Standard/Optional type — this is
 * what the cars evaluator uses to verify a brief's must-have features against a specific car.
 */
function extractFeatures(advert: Record<string, unknown>): ATFeatureCategory[] | null {
  const fwd = advert['featuresWithDisclaimer'] as
    | { features?: Array<Record<string, unknown>> }
    | undefined;
  const cats = fwd?.features;
  if (!Array.isArray(cats) || cats.length === 0) return null;
  const out: ATFeatureCategory[] = [];
  for (const c of cats) {
    const items = (c['items'] as Array<{ name?: string; type?: string }> | undefined) ?? [];
    const mapped = items
      .filter((i) => i && i.name)
      .map((i) => ({ name: i.name as string, type: (i.type as string) ?? null }));
    if (mapped.length === 0) continue;
    out.push({
      category: (c['category'] as string) ?? (c['title'] as string) ?? 'Other',
      items: mapped,
    });
  }
  return out.length > 0 ? out : null;
}

/** Extract performance + dimensions spec categories from aggregatorAdvert.specs. */
function extractSpecs(advert: Record<string, unknown>): ATSpecCategory[] | null {
  const specs = advert['specs'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(specs) || specs.length === 0) return null;
  const out: ATSpecCategory[] = [];
  for (const c of specs) {
    const items = (c['items'] as Array<{ name?: string; value?: string }> | undefined) ?? [];
    const mapped = items
      .filter((i) => i && i.name)
      .map((i) => ({ name: i.name as string, value: (i.value as string) ?? null }));
    if (mapped.length === 0) continue;
    out.push({ category: (c['category'] as string) ?? 'Other', items: mapped });
  }
  return out.length > 0 ? out : null;
}

/** Extract the seller free-text description (advert.description.text is an array of paragraphs). */
function extractDescription(advert: Record<string, unknown>): string | null {
  const desc = advert['description'] as { text?: unknown } | undefined;
  if (!desc) return null;
  const text = desc.text;
  if (Array.isArray(text)) {
    const joined = text.filter((t) => typeof t === 'string').join('\n').trim();
    return joined.length > 0 ? joined : null;
  }
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
}

/**
 * Extract detail data from a /car-details/ HTML page.
 * Returns null if the page structure is unrecognised.
 */
export function extractDetailData(html: string): ATDetailData | null {
  // Primary extraction: window.__staticRouterHydrationData
  const m = html.match(
    /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("([\s\S]*?)"\);/,
  );

  if (m) {
    let data: Record<string, unknown>;
    try {
      // Double JSON.parse: the outer string is a JSON-encoded string literal
      data = JSON.parse(JSON.parse('"' + m[1] + '"')) as Record<string, unknown>;
    } catch {
      return null;
    }

    const loaderData = (data as { loaderData?: Record<string, unknown> })?.loaderData;
    const carDetails = (loaderData?.['car-details'] as Record<string, unknown>) ?? null;
    const advert = (carDetails?.aggregatorAdvert as Record<string, unknown>) ?? null;

    if (!advert) return null;

    const heading = (advert.heading as Record<string, unknown>) ?? null;
    const keySpec = (advert.keySpecification as Array<{ label: string; value: string; specKey: string }>) ?? null;
    const seller = (advert.seller as Record<string, unknown>) ?? null;
    const advertTrackingData = (advert.advertTrackingData as Record<string, unknown>) ?? null;
    const advertContext = (advertTrackingData?.advertContext as Record<string, unknown>) ?? null;

    // Price tier — the primary deal signal
    const priceIndicator = (heading?.priceIndicator as string) ?? null;
    const priceIndicatorLabel = (heading?.priceIndicatorLabel as string) ?? null;

    // Price breakdown
    const priceBreakdown = (heading?.priceBreakdown as Record<string, unknown>) ?? null;
    const priceObj = (priceBreakdown?.price as Record<string, unknown>) ?? null;
    const priceFormatted = (priceObj?.priceFormatted as string) ?? null;
    const priceNumeric = (priceObj?.price as number) ?? null;
    const priceDeviationText = (priceObj?.deviation as string) ?? null;
    const deviation = parseDeviationText(priceDeviationText);

    // Mileage from headingPills — e.g. [{ label: "55,010 miles" }, ...]
    const headingPills = (heading?.headingPills as Array<{ label: string }>) ?? [];
    const mileagePill = headingPills.find((p) => /miles/i.test(p.label));
    const mileageText = mileagePill?.label ?? null;
    const mileageNum = parseMileageNum(mileageText);

    // Spec fields from keySpecification
    const fuel = extractSpecValue(keySpec, 'FUELTYPE');
    const transmission = extractSpecValue(keySpec, 'GEARBOX');
    const bodyType = extractSpecValue(keySpec, 'BODYTYPE');
    const colour = extractSpecValue(keySpec, 'COLOUR') ?? extractSpecValue(keySpec, 'COLOR');
    const seats = extractSpecValue(keySpec, 'SEATS');
    const doors = extractSpecValue(keySpec, 'DOORS');
    const engineLitres = extractSpecValue(keySpec, 'ENGINESIZELITRES');
    const owners = extractSpecValue(keySpec, 'OWNERS');

    // Equipment list, specs, and description — for feature verification
    const features = extractFeatures(advert);
    const specs = extractSpecs(advert);
    const description = extractDescription(advert);

    // Year from advertContext or headingPills — "2015 (65 reg)" pill
    const yearFromCtx = (advertContext?.year as number) ?? null;
    const regPill = headingPills.find((p) => /\d{4}.*reg/i.test(p.label));
    const yearFromPill = regPill ? parseInt(regPill.label.match(/(\d{4})/)?.[1] ?? '', 10) : null;
    const year = yearFromCtx ?? (yearFromPill && !isNaN(yearFromPill) ? yearFromPill : null);

    // Registration plate from keySpecification or headingPill
    const regSpecValue = extractSpecValue(keySpec, 'REGISTRATION');
    const registrationPlate = parseRegistrationPlate(regSpecValue ?? regPill?.label ?? null);

    // Seller info — sellerType comes from advertTrackingData.advertContext.advertiserType
    // ("dealer"/"private"); normalised to 'trade'|'private' (Fix 5).
    const sellerType = normaliseSellerType((advertContext?.advertiserType as string) ?? null);
    const sellerName = (seller?.name as string) ?? null;
    const contactDetails = (advert.contactDetails as Record<string, unknown>) ?? null;
    const dealerUrl = (contactDetails?.website as string) ?? null;

    // Seller location — prefer granular address from detail page if present
    const sellerAddress = (seller?.location as Record<string, unknown>) ?? null;
    const sellerTown = (sellerAddress?.town as string) ?? null;
    const sellerPostcode =
      (sellerAddress?.postcode as string) ?? (sellerAddress?.postCode as string) ?? null;
    // Build a location_text from detail: prefer "Town, Postcode" if available
    const detailLocationText = sellerTown
      ? sellerPostcode
        ? `${sellerTown}, ${sellerPostcode}`
        : sellerTown
      : sellerPostcode ?? null;

    return {
      priceIndicator,
      priceIndicatorLabel,
      deviation,
      mileageText,
      mileageNum,
      fuel,
      transmission,
      bodyType,
      colour,
      year,
      registrationPlate,
      sellerType,
      sellerName,
      dealerUrl,
      detailLocationText,
      priceFormatted,
      priceNumeric,
      priceDeviationText,
      seats,
      doors,
      engineLitres,
      owners,
      features,
      specs,
      description,
    };
  }

  // Fallback: SVG gauge title for price tier enum only
  const svgTitle = html.match(
    /data-testid="price-indicator-gauge"[\s\S]{0,2000}?<title>([\w]+)<\/title>/,
  )?.[1];

  if (svgTitle) {
    return {
      priceIndicator: svgTitle ?? null,
      priceIndicatorLabel: null,
      deviation: null,
      mileageText: null,
      mileageNum: null,
      fuel: null,
      transmission: null,
      bodyType: null,
      colour: null,
      year: null,
      registrationPlate: null,
      sellerType: null,
      sellerName: null,
      dealerUrl: null,
      detailLocationText: null,
      priceFormatted: null,
      priceNumeric: null,
      priceDeviationText: null,
      seats: null,
      doors: null,
      engineLitres: null,
      owners: null,
      features: null,
      specs: null,
      description: null,
    };
  }

  return null;
}

/**
 * Detect "sold" state from detail page HTML.
 * AT shows a banner when a car has sold — look for known text patterns.
 */
export function isSoldPage(html: string): boolean {
  return /this car has been sold/i.test(html) || /car is no longer available/i.test(html);
}

/** Merge ATDetailData into a NormalisedListing's attributes. */
export function mergeDetailAttributes(
  listing: NormalisedListing,
  detail: ATDetailData,
): NormalisedListing {
  // Seller type: prefer the detail-page value, fall back to the search-level value.
  // Contract (Fix 5): attributes.seller_type MUST stay present and the top-level
  // NormalisedListing.sellerType must stay set — another agent relies on both. We only
  // emit seller_type when we actually have a value so a null doesn't clobber the
  // search-level value during the scheduler's attribute merge.
  const existingSellerType = (listing.attributes['seller_type'] as string | null | undefined) ?? null;
  const sellerType = detail.sellerType ?? existingSellerType;

  return {
    ...listing,
    // Update price if detail has a numeric value
    priceGbp: detail.priceNumeric ?? listing.priceGbp,
    // Keep top-level sellerType set (uppercased to match search-level 'TRADE'|'PRIVATE').
    sellerType: sellerType ? (sellerType.toUpperCase() as 'TRADE' | 'PRIVATE') : listing.sellerType ?? null,
    attributes: {
      ...listing.attributes,
      price_tier: detail.priceIndicator,
      price_tier_label: detail.priceIndicatorLabel,
      price_deviation_gbp: detail.deviation,
      mileage_num: detail.mileageNum,
      mileage_text: detail.mileageText,
      fuel: detail.fuel,
      transmission: detail.transmission,
      body_type: detail.bodyType,
      colour: detail.colour,
      year: detail.year ?? listing.attributes['year'],
      registration_plate: detail.registrationPlate,
      seller_name: detail.sellerName,
      dealer_url: detail.dealerUrl,
      // Extra spec fields
      seats: detail.seats,
      doors: detail.doors,
      engine_litres: detail.engineLitres,
      owners: detail.owners,
      // Equipment list + specs + description for feature verification (cars are bought by feature)
      features: detail.features,
      specs: detail.specs,
      description: detail.description,
      // Only emit seller_type when we have a value (don't clobber search value with null).
      ...(sellerType ? { seller_type: sellerType } : {}),
      // Overwrite location_text with granular detail data if present (Issue 7)
      ...(detail.detailLocationText
        ? { location_text: detail.detailLocationText }
        : {}),
    },
  };
}

/**
 * Fetch the detail page and enrich a listing.
 * Returns a DetailOutcome with the enriched listing or an error.
 */
export async function fetchDetailPage(advertId: string): Promise<DetailOutcome> {
  const url = `${AT_BASE}/car-details/${advertId}`;

  let res: Response;
  try {
    res = await rateLimitedFetch(url, { headers: DETAIL_HEADERS });
  } catch (err) {
    // Kill switch: let it propagate so the adapter reports apiCalls:0 (Fix 1).
    if (err instanceof AutoTraderDisabledError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return { listing: null, apiCalls: 1, error: msg };
  }

  if (res.status === 404) {
    return { listing: null, apiCalls: 1, error: '404 Not Found' };
  }

  if (!res.ok) {
    return { listing: null, apiCalls: 1, error: `HTTP ${res.status}` };
  }

  const html = await res.text();
  const detail = extractDetailData(html);

  if (!detail) {
    return {
      listing: null,
      apiCalls: 1,
      error: 'Could not extract detail data from page',
    };
  }

  const base: NormalisedListing = {
    source: 'autotrader',
    sourceId: advertId,
    title: '',
    url,
    priceGbp: detail.priceNumeric,
    currency: 'GBP',
    sellerType: null,
    condition: null,
    buyingFormat: null,
    auctionEndTime: null,
    bidCount: null,
    attributes: {},
  };

  return {
    listing: mergeDetailAttributes(base, detail),
    apiCalls: 1,
  };
}

/**
 * Check the state of a listing (active / removed / sold).
 * Used by getState() in the main adapter.
 */
export async function getListingState(advertId: string): Promise<{
  status: 'active' | 'removed' | 'sold';
  priceGbp: number | null;
  attributes: Record<string, unknown>;
  apiCalls: number;
  error?: string;
}> {
  const url = `${AT_BASE}/car-details/${advertId}`;

  let res: Response;
  try {
    res = await rateLimitedFetch(url, { headers: DETAIL_HEADERS });
  } catch (err) {
    // Kill switch: let it propagate so the adapter reports apiCalls:0 (Fix 1).
    if (err instanceof AutoTraderDisabledError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    // Network/other failure — set error so change-detection skips (does not assert live).
    return { status: 'active', priceGbp: null, attributes: {}, apiCalls: 1, error: msg };
  }

  if (res.status === 404) {
    return { status: 'removed', priceGbp: null, attributes: {}, apiCalls: 1 };
  }

  if (!res.ok) {
    return {
      status: 'active',
      priceGbp: null,
      attributes: {},
      apiCalls: 1,
      error: `HTTP ${res.status}`,
    };
  }

  const html = await res.text();

  if (isSoldPage(html)) {
    return { status: 'sold', priceGbp: null, attributes: {}, apiCalls: 1 };
  }

  const detail = extractDetailData(html);

  // Fix 2: HTTP 200, no sold banner, not a 404, but extraction yielded nothing.
  // This means a broken selector, a soft-404, or a redirect — NOT a confirmed live
  // listing. Return an error so change-detection skips this offer (the scheduler
  // checks `error` before `status`, at scheduler.ts watch/staleness loops) rather
  // than silently treating scraper breakage as a live listing. We deliberately do
  // not assert a definitive 'removed'/'sold' either (the page may still be live).
  if (!detail) {
    return {
      status: 'active',
      priceGbp: null,
      attributes: {},
      apiCalls: 1,
      error: 'Could not extract detail data from page (HTTP 200, no sold/404) — scraper may be broken',
    };
  }

  return {
    status: 'active',
    priceGbp: detail.priceNumeric ?? null,
    attributes: {
      price_tier: detail.priceIndicator,
      price_tier_label: detail.priceIndicatorLabel,
      price_deviation_gbp: detail.deviation,
      mileage_num: detail.mileageNum,
      mileage_text: detail.mileageText,
    },
    apiCalls: 1,
  };
}
