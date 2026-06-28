/**
 * Cars notification formatter.
 *
 * Target output:
 *   2018 Audi A4 2.0 TDI · 67k mi · £14,995 (AT: Great price) · LE3 · trade · [link]
 *
 * All segments are dropped gracefully if the required data is missing.
 * "undefined" and "null" are never rendered.
 */

// Inline the minimal NormalisedListing type to avoid cross-compilation-root imports.
// Must stay in sync with watcher/src/sources/types.ts.
interface NormalisedListing {
  source: string;
  sourceId: string;
  title: string;
  url: string;
  priceGbp: number | null;
  currency: string;
  thumbnailUrl?: string;
  sellerType?: 'TRADE' | 'PRIVATE' | null;
  attributes: Record<string, unknown>;
}

/** Shorten mileage text: "55,010 miles" → "55k mi" */
function shortenMileage(mileageText: string | null | undefined): string | null {
  if (!mileageText) return null;
  const n = parseInt(mileageText.replace(/[,\s]/g, ''), 10);
  if (isNaN(n)) return null;
  if (n >= 1000) return `${Math.round(n / 1000)}k mi`;
  return `${n} mi`;
}

/**
 * Extract city name from AT location text.
 *
 * AT returns strings like "Leicester (3 miles)" or "Birmingham (12 miles)".
 * A postcode regex never matches because AT doesn't include postcodes in search results.
 * We extract everything before the first parenthesis or end-of-string, trimmed.
 *
 * Examples:
 *   "Leicester (3 miles)" → "Leicester"
 *   "Birmingham"          → "Birmingham"
 *   "LE3 4AB (2 miles)"  → "LE3 4AB" (if ever passed as a postcode string)
 */
function extractCity(locationText: string | null | undefined): string | null {
  if (!locationText) return null;
  const m = locationText.match(/^([^(]+?)(?:\s*\(|$)/);
  if (!m) return null;
  const city = m[1].trim();
  return city.length > 0 ? city : null;
}

/**
 * Map sellerType to friendly string. Case-insensitive: the top-level
 * NormalisedListing.sellerType is uppercase ('TRADE'|'PRIVATE') while the
 * attributes.seller_type fallback may be either case depending on whether the
 * value came straight from the adapter (lowercase) or survived a DB round-trip
 * (upsertNormalisedListing stores the uppercase top-level value).
 */
function friendlySellerType(
  sellerType: 'TRADE' | 'PRIVATE' | null | undefined | string,
): string | null {
  const t = sellerType?.toUpperCase();
  if (t === 'TRADE') return 'trade';
  if (t === 'PRIVATE') return 'private';
  return null;
}

/**
 * Format a cars notification line from a NormalisedListing.
 * Expects attributes populated by fetchDetail().
 */
export function formatCarsNotification(
  offer: NormalisedListing & { url: string },
): string {
  const attrs = offer.attributes ?? {};

  const year = attrs['year'] as number | null | undefined;
  const make = attrs['make'] as string | null | undefined;
  const model = attrs['model'] as string | null | undefined;
  const subTitle = attrs['subTitle'] as string | null | undefined;
  const mileageText = attrs['mileage_text'] as string | null | undefined;
  const priceTier = attrs['price_tier'] as string | null | undefined;
  const priceTierLabel = attrs['price_tier_label'] as string | null | undefined;
  const priceDeviationGbp = attrs['price_deviation_gbp'] as number | null | undefined;
  const vehicleLocation = attrs['vehicleLocation'] as string | null | undefined;
  const locationText = attrs['location_text'] as string | null | undefined;

  const segments: string[] = [];

  // Segment 1: year + make + model + trim
  // Build the car identity line
  const yearStr = year ? String(year) : null;
  const titleParts: string[] = [];
  if (yearStr) titleParts.push(yearStr);
  if (make) titleParts.push(make);
  if (model) titleParts.push(model);

  // Trim: use subTitle if it adds info beyond what's in the title
  // If the title already contains make+model (e.g. "Audi A4"), append subTitle as trim
  if (subTitle) {
    titleParts.push(subTitle);
  } else if (!make && !model && offer.title) {
    titleParts.push(offer.title);
  }

  const titleLine = titleParts.join(' ');
  if (titleLine) segments.push(titleLine);

  // Segment 2: mileage
  const mileageShort = shortenMileage(mileageText);
  if (mileageShort) segments.push(mileageShort);

  // Segment 3: price + optional AT price tier label + optional deviation
  if (offer.priceGbp != null) {
    let priceSegment = `£${offer.priceGbp.toLocaleString('en-GB')}`;
    // Only show price tier if it's not NOANALYSIS and we have a label
    if (
      priceTier &&
      priceTier !== 'NOANALYSIS' &&
      priceTierLabel &&
      priceTierLabel.trim() !== ''
    ) {
      priceSegment += ` (AT: ${priceTierLabel}`;
      // Append deviation if present: "£500 below market" or "£200 above market"
      if (priceDeviationGbp != null) {
        const absDeviation = Math.abs(priceDeviationGbp);
        const direction = priceDeviationGbp < 0 ? 'below' : 'above';
        priceSegment += `, £${absDeviation.toLocaleString('en-GB')} ${direction} market`;
      }
      priceSegment += `)`;
    }
    segments.push(priceSegment);
  }

  // Segment 4: location (city extracted from AT location string)
  const locationSource = locationText ?? vehicleLocation;
  const city = extractCity(locationSource);
  if (city) segments.push(city);

  // Segment 5: seller type
  // Prefer the top-level sellerType; fall back to attributes.seller_type so the value
  // survives a DB round-trip (upsertNormalisedListing folds sellerType into attributes).
  const sellerTypeValue =
    offer.sellerType ?? (offer.attributes?.['seller_type'] as 'TRADE' | 'PRIVATE' | null | undefined);
  const sellerStr = friendlySellerType(sellerTypeValue);
  if (sellerStr) segments.push(sellerStr);

  // Segment 6: URL
  if (offer.url) segments.push(offer.url);

  return segments.join(' · ');
}
