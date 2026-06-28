import { cn } from '@/lib/utils';
import { formatPrice } from '@/lib/format';

interface CarAttributesBlockProps {
  attributes: Record<string, unknown>;
}

function attr(attributes: Record<string, unknown>, key: string): string | null {
  const v = attributes[key];
  if (v === undefined || v === null || v === '') return null;
  return String(v);
}

function numAttr(attributes: Record<string, unknown>, key: string): number | null {
  const v = attributes[key];
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

interface RowProps {
  label: string;
  value: string | null;
  mono?: boolean;
}

function Row({ label, value, mono }: RowProps) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="text-zinc-500 w-28 shrink-0">{label}</span>
      <span className={cn(mono ? 'font-mono text-zinc-300' : 'text-zinc-300')}>{value}</span>
    </div>
  );
}

/**
 * Renders car-specific attributes extracted from offer.attributes.
 * Gracefully skips any fields that are missing or null.
 */
export default function CarAttributesBlock({ attributes }: CarAttributesBlockProps) {
  const year = attr(attributes, 'year');
  const mileageText = attr(attributes, 'mileage_text');
  const fuel = attr(attributes, 'fuel');
  const body = attr(attributes, 'body_type');
  const transmission = attr(attributes, 'transmission');
  const colour = attr(attributes, 'colour');
  const sellerType = attr(attributes, 'seller_type');
  // AT returns location_text like "Leicester (3 miles)"; display just the city name.
  const rawLocationText = attr(attributes, 'location_text');
  const locationText = rawLocationText ? rawLocationText.replace(/\s*\(.*?\)\s*$/, '').trim() || rawLocationText : null;
  const distanceMiles = numAttr(attributes, 'distance_miles');
  const priceTierLabel = attr(attributes, 'price_tier_label');

  // Deviation from market mid
  const deviationGbp = numAttr(attributes, 'price_deviation_gbp');

  const hasAny =
    year || mileageText || fuel || body || transmission || colour ||
    sellerType || locationText || distanceMiles != null || priceTierLabel;

  if (!hasAny) return null;

  return (
    <div className="bg-surface border border-zinc-800 rounded-lg p-4 mb-6">
      <h3 className="text-heading text-zinc-300 mb-3">Car Details</h3>
      <div className="space-y-1.5">
        <Row label="Year" value={year} mono />
        <Row label="Mileage" value={mileageText} mono />
        <Row label="Fuel" value={fuel} />
        <Row label="Body" value={body} />
        <Row label="Transmission" value={transmission} />
        <Row label="Colour" value={colour} />
        <Row label="Seller" value={sellerType ? sellerType.charAt(0).toUpperCase() + sellerType.slice(1).toLowerCase() : null} />
        <Row label="Location" value={locationText} />
        {distanceMiles != null && (
          <div className="flex items-baseline gap-3 text-sm">
            <span className="text-zinc-500 w-28 shrink-0">Distance</span>
            <span className="font-mono text-zinc-300">{distanceMiles} mi</span>
          </div>
        )}
        {priceTierLabel && (
          <div className="flex items-baseline gap-3 text-sm">
            <span className="text-zinc-500 w-28 shrink-0">Price tier</span>
            <span className="text-zinc-300">
              {priceTierLabel}
              {deviationGbp != null && (
                <span
                  className={cn(
                    'ml-2 font-mono text-xs',
                    deviationGbp < 0 ? 'text-success' : 'text-danger',
                  )}
                >
                  {deviationGbp < 0
                    ? `${formatPrice(Math.abs(deviationGbp))} below market`
                    : `${formatPrice(deviationGbp)} above market`}
                </span>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
