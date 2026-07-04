import { cn } from '@/lib/utils';
import { formatPrice } from '@/lib/format';
import { parseCarAttributes, getSourcePriceOpinion } from '@/lib/attributes';

interface CarAttributesBlockProps {
  attributes: Record<string, unknown>;
  /** Offer source name (e.g. "autotrader") — labels the price-opinion row. */
  source: string;
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
export default function CarAttributesBlock({ attributes, source }: CarAttributesBlockProps) {
  const attrs = parseCarAttributes(attributes);
  const opinion = getSourcePriceOpinion(source, attributes);

  const year = attrs.year != null ? String(attrs.year) : null;
  const mileageText = attrs.mileage_text ?? null;
  const fuel = attrs.fuel ?? null;
  const body = attrs.body_type ?? null;
  const transmission = attrs.transmission ?? null;
  const colour = attrs.colour ?? null;
  const sellerType = attrs.seller_type ?? null;
  // AT returns location_text like "Leicester (3 miles)"; display just the city name.
  const rawLocationText = attrs.location_text ?? null;
  const locationText = rawLocationText ? rawLocationText.replace(/\s*\(.*?\)\s*$/, '').trim() || rawLocationText : null;
  const distanceMiles = attrs.distance_miles ?? null;

  // Source's own price opinion (tier label + deviation from its market estimate)
  const opinionLabel = opinion ? (opinion.label ?? opinion.tier) : null;
  const deviationGbp = opinion?.deviation_gbp ?? null;

  const hasAny =
    year || mileageText || fuel || body || transmission || colour ||
    sellerType || locationText || distanceMiles != null || opinionLabel;

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
        {opinionLabel && (
          <div className="flex items-baseline gap-3 text-sm">
            <span className="text-zinc-500 w-28 shrink-0">Source opinion — {source}</span>
            <span className="text-zinc-300">
              {opinionLabel}
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
