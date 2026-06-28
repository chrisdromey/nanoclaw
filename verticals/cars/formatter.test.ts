/**
 * Tests for the cars notification formatter.
 */

import { describe, it, expect } from 'vitest';
import { formatCarsNotification } from './formatter.js';

// Build a sample listing matching what fetchDetail() would produce
const fullListing = {
  source: 'autotrader',
  sourceId: '202605282783235',
  title: 'Audi A4',
  url: 'https://www.autotrader.co.uk/car-details/202605282783235',
  priceGbp: 14995,
  currency: 'GBP',
  sellerType: 'TRADE' as const,
  attributes: {
    make: 'Audi',
    model: 'A4',
    year: 2018,
    subTitle: '2.0 TDI S line 4dr',
    mileage_text: '67,000 miles',
    mileage_num: 67000,
    price_tier: 'GREAT',
    price_tier_label: 'Great price',
    price_deviation_gbp: -500,
    vehicleLocation: 'Leicester (3 miles)',
    distance_miles: 3,
    fuel: 'Diesel',
    transmission: 'Manual',
    body_type: 'Saloon',
  },
};

describe('formatCarsNotification', () => {
  it('produces the expected full notification line', () => {
    const result = formatCarsNotification(fullListing);
    // Must contain: year make model subTitle · mileage · £price (AT: label, deviation) · location · seller · url
    expect(result).toContain('2018 Audi A4');
    expect(result).toContain('67k mi');
    expect(result).toContain('£14,995');
    // price_deviation_gbp: -500 in fullListing, so label includes deviation
    expect(result).toContain('(AT: Great price,');
    expect(result).toContain('£500 below market');
    // Location: city extracted from "Leicester (3 miles)"
    expect(result).toContain('Leicester');
    expect(result).toContain('trade');
    expect(result).toContain('https://www.autotrader.co.uk/car-details/202605282783235');
  });

  it('uses ·  as segment separator', () => {
    const result = formatCarsNotification(fullListing);
    expect(result).toContain(' · ');
  });

  it('drops AT price tier when price_tier is NOANALYSIS', () => {
    const listing = {
      ...fullListing,
      attributes: { ...fullListing.attributes, price_tier: 'NOANALYSIS', price_tier_label: '' },
    };
    const result = formatCarsNotification(listing);
    expect(result).not.toContain('(AT:');
    expect(result).not.toContain('NOANALYSIS');
    expect(result).toContain('£14,995');
  });

  it('drops AT price tier when price_tier is null', () => {
    const listing = {
      ...fullListing,
      attributes: { ...fullListing.attributes, price_tier: null, price_tier_label: null },
    };
    const result = formatCarsNotification(listing);
    expect(result).not.toContain('(AT:');
  });

  it('drops AT price tier when price_tier_label is empty string', () => {
    const listing = {
      ...fullListing,
      attributes: { ...fullListing.attributes, price_tier: 'GOOD', price_tier_label: '' },
    };
    const result = formatCarsNotification(listing);
    expect(result).not.toContain('(AT:');
  });

  it('includes price tier label for GOOD tier', () => {
    const listing = {
      ...fullListing,
      attributes: {
        ...fullListing.attributes,
        price_tier: 'GOOD',
        price_tier_label: 'Good price',
        price_deviation_gbp: null,  // no deviation so the closing ) comes right after the label
      },
    };
    const result = formatCarsNotification(listing);
    expect(result).toContain('(AT: Good price)');
  });

  it('appends deviation below market when price_deviation_gbp is negative', () => {
    const listing = {
      ...fullListing,
      attributes: {
        ...fullListing.attributes,
        price_tier: 'GREAT',
        price_tier_label: 'Great price',
        price_deviation_gbp: -1732,
      },
    };
    const result = formatCarsNotification(listing);
    expect(result).toContain('£1,732 below market');
    expect(result).toContain('(AT: Great price,');
  });

  it('appends deviation above market when price_deviation_gbp is positive', () => {
    const listing = {
      ...fullListing,
      attributes: {
        ...fullListing.attributes,
        price_tier: 'HIGH',
        price_tier_label: 'Higher price',
        price_deviation_gbp: 500,
      },
    };
    const result = formatCarsNotification(listing);
    expect(result).toContain('£500 above market');
  });

  it('does not include deviation segment when price_deviation_gbp is absent', () => {
    const listing = {
      ...fullListing,
      attributes: {
        ...fullListing.attributes,
        price_tier: 'GREAT',
        price_tier_label: 'Great price',
        price_deviation_gbp: null,
      },
    };
    const result = formatCarsNotification(listing);
    expect(result).toContain('(AT: Great price)');
    expect(result).not.toContain('below market');
    expect(result).not.toContain('above market');
  });

  it('does not render "undefined" or "null" anywhere in the output', () => {
    const listing = {
      ...fullListing,
      attributes: {
        ...fullListing.attributes,
        price_tier: null,
        price_tier_label: null,
        mileage_text: null,
        vehicleLocation: null,
      },
    };
    const result = formatCarsNotification(listing);
    expect(result).not.toContain('undefined');
    expect(result).not.toContain('null');
  });

  it('extracts city from AT location string', () => {
    const listing = {
      ...fullListing,
      attributes: { ...fullListing.attributes, vehicleLocation: 'Birmingham (12 miles)', location_text: null },
    };
    const result = formatCarsNotification(listing);
    expect(result).toContain('Birmingham');
    expect(result).not.toContain('(12 miles)');
  });

  it('drops location segment when vehicleLocation is missing', () => {
    const listing = {
      ...fullListing,
      attributes: { ...fullListing.attributes, vehicleLocation: null, location_text: null },
    };
    const result = formatCarsNotification(listing);
    // No city should appear; no trailing empty segment
    expect(result).not.toContain('Leicester');
    // No ·  ·  double-separator indicating an empty segment
    expect(result).not.toMatch(/ · {2,}/);
  });

  it('drops mileage segment when mileage_text is missing', () => {
    const listing = {
      ...fullListing,
      attributes: { ...fullListing.attributes, mileage_text: null },
    };
    const result = formatCarsNotification(listing);
    expect(result).not.toContain('mi');
  });

  it('shortens mileage correctly', () => {
    const cases: Array<[string, string]> = [
      ['55,010 miles', '55k mi'],
      ['1,000 miles', '1k mi'],
      ['100,000 miles', '100k mi'],
    ];
    for (const [input, expected] of cases) {
      const listing = {
        ...fullListing,
        attributes: { ...fullListing.attributes, mileage_text: input },
      };
      const result = formatCarsNotification(listing);
      expect(result).toContain(expected);
    }
  });

  it('maps TRADE to "trade" and PRIVATE to "private"', () => {
    expect(formatCarsNotification({ ...fullListing, sellerType: 'TRADE' })).toContain('trade');
    expect(formatCarsNotification({ ...fullListing, sellerType: 'PRIVATE' })).toContain('private');
  });

  it('falls back to attributes.seller_type when top-level sellerType is absent (DB round-trip)', () => {
    // Simulates an offer read back from the DB, where sellerType was folded into
    // attributes.seller_type by upsertNormalisedListing and the top-level field is gone.
    const listing = {
      ...fullListing,
      sellerType: undefined,
      attributes: { ...fullListing.attributes, seller_type: 'PRIVATE' },
    };
    const result = formatCarsNotification(listing);
    const segments = result.split(' · ');
    expect(segments).toContain('private');
  });

  it('prefers top-level sellerType over attributes.seller_type', () => {
    const listing = {
      ...fullListing,
      sellerType: 'TRADE' as const,
      attributes: { ...fullListing.attributes, seller_type: 'PRIVATE' },
    };
    const result = formatCarsNotification(listing);
    const segments = result.split(' · ');
    expect(segments).toContain('trade');
    expect(segments).not.toContain('private');
  });

  it('drops seller type segment when sellerType is null', () => {
    const listing = { ...fullListing, sellerType: null as unknown as 'TRADE' };
    const result = formatCarsNotification(listing);
    // Segments are separated by ' · ', so check the segment is not present as a standalone word
    const segments = result.split(' · ');
    expect(segments).not.toContain('trade');
    expect(segments).not.toContain('private');
  });

  it('handles listing with no attributes gracefully', () => {
    const listing = {
      source: 'autotrader',
      sourceId: 'at-bare',
      title: 'Ford Focus',
      url: 'https://www.autotrader.co.uk/car-details/at-bare',
      priceGbp: 5000,
      currency: 'GBP',
      sellerType: null as unknown as 'TRADE',
      attributes: {},
    };
    const result = formatCarsNotification(listing);
    expect(result).toContain('£5,000');
    expect(result).toContain('https://');
    expect(result).not.toContain('undefined');
    expect(result).not.toContain('null');
  });

  it('drops price segment when priceGbp is null', () => {
    const listing = { ...fullListing, priceGbp: null };
    const result = formatCarsNotification(listing);
    expect(result).not.toContain('£');
  });

  it('formats price with GBP locale separators', () => {
    const listing = { ...fullListing, priceGbp: 14995 };
    const result = formatCarsNotification(listing);
    expect(result).toContain('£14,995');
  });

  it('includes URL always when present', () => {
    const result = formatCarsNotification(fullListing);
    expect(result).toContain('https://www.autotrader.co.uk/car-details/202605282783235');
  });
});
