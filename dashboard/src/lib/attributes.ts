/**
 * Typed parsers over offer/baseline `attributes` records.
 *
 * This is the ONLY module that should reach into `Record<string, unknown>`
 * attribute bags — components receive typed values (CarAttributes,
 * NormalisedFeatureCategory[], SourcePriceOpinion). Defensive by design:
 * every accessor tolerates missing keys, wrong types, and outright garbage.
 */

import type {
  CarAttributes,
  NormalisedFeatureCategory,
  NormalisedFeatureItem,
  SourcePriceOpinion,
} from '@shared/types';

/** Coerce to a non-empty string, else undefined. */
function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' ? undefined : s;
  }
  return undefined;
}

/**
 * Coerce to a finite number: accepts numbers and plain decimal strings
 * (comma group separators stripped — real AutoTrader mileage text is
 * comma-grouped, e.g. "59,282"). Non-decimal formats Number() would accept
 * (hex like "0x7E6", exponents, Infinity) are rejected.
 */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof v === 'string') {
    const s = v.trim().replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse the normalised features list (array of { category, items }) from an
 * attributes record. Malformed entries are skipped; garbage input yields [].
 */
export function parseFeatures(
  attrs: Record<string, unknown> | null | undefined,
): NormalisedFeatureCategory[] {
  if (!isRecord(attrs)) return [];
  const raw = attrs.features;
  if (!Array.isArray(raw)) return [];

  const categories: NormalisedFeatureCategory[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const category = str(entry.category);
    if (!category || !Array.isArray(entry.items)) continue;

    const items: NormalisedFeatureItem[] = [];
    for (const item of entry.items) {
      if (!isRecord(item)) continue;
      const name = str(item.name);
      if (!name) continue;
      const type = typeof item.type === 'string' ? item.type : null;
      items.push({ name, type });
    }
    categories.push({ category, items });
  }
  return categories;
}

/**
 * Parse a cars offer's attributes into a typed CarAttributes view.
 * Every field is optional; wrong-typed values are dropped, numeric strings
 * are coerced (mirrors the defensive style of CarAttributesBlock's attr/numAttr).
 */
export function parseCarAttributes(
  attrs: Record<string, unknown> | null | undefined,
): CarAttributes {
  if (!isRecord(attrs)) return {};
  const out: CarAttributes = {};

  const setNum = (key: keyof CarAttributes, v: unknown) => {
    const n = num(v);
    if (n !== undefined) (out as Record<string, unknown>)[key] = n;
  };
  const setStr = (key: keyof CarAttributes, v: unknown) => {
    const s = str(v);
    if (s !== undefined) (out as Record<string, unknown>)[key] = s;
  };

  setNum('year', attrs.year);
  setNum('mileage_num', attrs.mileage_num);
  setStr('mileage_text', attrs.mileage_text);
  setStr('fuel', attrs.fuel);
  setStr('transmission', attrs.transmission);
  setStr('body_type', attrs.body_type);
  setStr('colour', attrs.colour);
  setStr('seller_type', attrs.seller_type);
  setStr('seller_name', attrs.seller_name);
  setStr('location_text', attrs.location_text);
  setNum('distance_miles', attrs.distance_miles);
  setStr('make', attrs.make);
  setStr('model', attrs.model);
  setNum('owners', attrs.owners);
  setStr('price_tier', attrs.price_tier);
  setStr('price_tier_label', attrs.price_tier_label);
  setNum('price_deviation_gbp', attrs.price_deviation_gbp);

  const features = parseFeatures(attrs);
  if (features.length > 0) out.features = features;

  return out;
}

/**
 * Extract a source's own price opinion from an attributes record.
 * Returns null when the source offered no analysis (price_tier missing or
 * 'NOANALYSIS'). `deviation_gbp` may be null while a tier is present.
 */
export function getSourcePriceOpinion(
  source: string,
  attrs: Record<string, unknown> | null | undefined,
): SourcePriceOpinion | null {
  if (!isRecord(attrs)) return null;
  const tier = str(attrs.price_tier);
  if (!tier || tier.toUpperCase() === 'NOANALYSIS') return null;
  return {
    source,
    tier,
    label: str(attrs.price_tier_label) ?? null,
    deviation_gbp: num(attrs.price_deviation_gbp) ?? null,
  };
}
