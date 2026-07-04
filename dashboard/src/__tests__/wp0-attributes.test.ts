/**
 * WP0 — typed attribute parsers over Record<string, unknown> bags.
 * Fixture mirrors the real AutoTrader adapter output shape.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCarAttributes,
  parseFeatures,
  getSourcePriceOpinion,
} from '../lib/attributes';

/** Realistic AutoTrader offer.attributes payload (hunt 11 shape). */
function autotraderFixture(): Record<string, unknown> {
  return {
    subTitle: '77kWh GT Line S Auto 5dr',
    year: 2022,
    mileage_num: 59282,
    mileage_text: '59,282 miles',
    fuel: 'Electric',
    transmission: 'Automatic',
    body_type: 'SUV',
    colour: 'Grey',
    seller_type: 'trade',
    seller_name: 'Example Motors Ltd',
    location_text: 'Leicester (31 miles)',
    distance_miles: 31,
    price_tier: 'GOOD',
    price_tier_label: 'Good price',
    price_deviation_gbp: null,
    features: [
      {
        category: 'Driver Convenience',
        items: [
          { name: 'Adaptive Cruise Control', type: 'Standard' },
          { name: 'Pilot Pack', type: 'Optional' },
        ],
      },
    ],
  };
}

describe('parseCarAttributes', () => {
  it('parses the realistic AutoTrader fixture', () => {
    const car = parseCarAttributes(autotraderFixture());
    expect(car.year).toBe(2022);
    expect(car.mileage_num).toBe(59282);
    expect(car.mileage_text).toBe('59,282 miles');
    expect(car.fuel).toBe('Electric');
    expect(car.transmission).toBe('Automatic');
    expect(car.body_type).toBe('SUV');
    expect(car.colour).toBe('Grey');
    expect(car.seller_type).toBe('trade');
    expect(car.seller_name).toBe('Example Motors Ltd');
    expect(car.location_text).toBe('Leicester (31 miles)');
    expect(car.distance_miles).toBe(31);
    expect(car.price_tier).toBe('GOOD');
    expect(car.price_tier_label).toBe('Good price');
    // null deviation → field absent (all-optional contract)
    expect(car.price_deviation_gbp).toBeUndefined();
    expect(car.features).toEqual([
      {
        category: 'Driver Convenience',
        items: [
          { name: 'Adaptive Cruise Control', type: 'Standard' },
          { name: 'Pilot Pack', type: 'Optional' },
        ],
      },
    ]);
  });

  it('coerces numeric strings to numbers', () => {
    const car = parseCarAttributes({
      year: '2022',
      mileage_num: '59282',
      distance_miles: '31',
      price_deviation_gbp: '-450',
    });
    expect(car.year).toBe(2022);
    expect(car.mileage_num).toBe(59282);
    expect(car.distance_miles).toBe(31);
    expect(car.price_deviation_gbp).toBe(-450);
  });

  it('strips comma group separators from numeric strings', () => {
    const car = parseCarAttributes({ mileage_num: '59,282' });
    expect(car.mileage_num).toBe(59282);
  });

  it('rejects hex and other non-decimal string formats', () => {
    const car = parseCarAttributes({ year: '0x7E6', mileage_num: '1e4' });
    expect(car.year).toBeUndefined();
    expect(car.mileage_num).toBeUndefined();
  });

  it('passes plain numbers through unchanged', () => {
    const car = parseCarAttributes({ mileage_num: 59282 });
    expect(car.mileage_num).toBe(59282);
  });

  it('drops wrong-typed and empty values instead of guessing', () => {
    const car = parseCarAttributes({
      year: 'twenty twenty two',
      mileage_num: { nested: true },
      fuel: 42,
      colour: '',
      seller_type: null,
      distance_miles: NaN,
    });
    expect(car).toEqual({});
  });

  it('returns {} on garbage input', () => {
    expect(parseCarAttributes(null)).toEqual({});
    expect(parseCarAttributes(undefined)).toEqual({});
    expect(parseCarAttributes([] as unknown as Record<string, unknown>)).toEqual({});
    expect(parseCarAttributes('junk' as unknown as Record<string, unknown>)).toEqual({});
  });
});

describe('parseFeatures', () => {
  it('parses the well-formed features list', () => {
    const features = parseFeatures(autotraderFixture());
    expect(features).toHaveLength(1);
    expect(features[0].category).toBe('Driver Convenience');
    expect(features[0].items).toHaveLength(2);
    expect(features[0].items[1]).toEqual({ name: 'Pilot Pack', type: 'Optional' });
  });

  it('normalises missing/non-string item type to null', () => {
    const features = parseFeatures({
      features: [
        { category: 'Safety', items: [{ name: 'ISOFIX' }, { name: 'Airbags', type: 7 }] },
      ],
    });
    expect(features[0].items).toEqual([
      { name: 'ISOFIX', type: null },
      { name: 'Airbags', type: null },
    ]);
  });

  it('skips malformed entries but keeps valid ones', () => {
    const features = parseFeatures({
      features: [
        'garbage',
        { category: 'No Items Key' },
        { items: [{ name: 'No Category' }] },
        { category: 'Valid', items: [{ name: 'Heat Pump', type: 'Standard' }, { type: 'Standard' }, null] },
      ],
    });
    expect(features).toEqual([
      { category: 'Valid', items: [{ name: 'Heat Pump', type: 'Standard' }] },
    ]);
  });

  it('returns [] on garbage', () => {
    expect(parseFeatures(null)).toEqual([]);
    expect(parseFeatures({})).toEqual([]);
    expect(parseFeatures({ features: 'garbage' })).toEqual([]);
    expect(parseFeatures({ features: { category: 'x' } })).toEqual([]);
  });
});

describe('getSourcePriceOpinion', () => {
  it('extracts an opinion with null deviation while tier is present', () => {
    const op = getSourcePriceOpinion('autotrader', autotraderFixture());
    expect(op).toEqual({
      source: 'autotrader',
      tier: 'GOOD',
      label: 'Good price',
      deviation_gbp: null,
    });
  });

  it('carries a numeric deviation through', () => {
    const op = getSourcePriceOpinion('autotrader', {
      price_tier: 'LOW',
      price_tier_label: 'Lower price',
      price_deviation_gbp: -1250,
    });
    expect(op).toEqual({
      source: 'autotrader',
      tier: 'LOW',
      label: 'Lower price',
      deviation_gbp: -1250,
    });
  });

  it('returns null for NOANALYSIS (any case)', () => {
    expect(getSourcePriceOpinion('autotrader', { price_tier: 'NOANALYSIS' })).toBeNull();
    expect(getSourcePriceOpinion('autotrader', { price_tier: 'NoAnalysis' })).toBeNull();
  });

  it('returns null when price_tier is missing or garbage', () => {
    expect(getSourcePriceOpinion('autotrader', {})).toBeNull();
    expect(getSourcePriceOpinion('autotrader', { price_tier: null })).toBeNull();
    expect(getSourcePriceOpinion('autotrader', { price_tier: 42 })).toBeNull();
    expect(getSourcePriceOpinion('autotrader', null)).toBeNull();
    expect(getSourcePriceOpinion('ebay', undefined)).toBeNull();
  });
});
