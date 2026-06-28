/**
 * Tests for the AutoTrader detail-page extraction module.
 *
 * Uses the captured spike #3 detail page HTML as fixture.
 * Live HTTP calls gated behind LIVE=1 env var.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDetailData, isSoldPage, mergeDetailAttributes } from './detail.js';
import type { NormalisedListing } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fixture: captured detail page from spike #3
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../spikes/autotrader/03-price-tier/samples/06-detail-page.html',
);

function loadFixture(): string {
  return fs.readFileSync(FIXTURE_PATH, 'utf8');
}

// ─── extractDetailData ───────────────────────────────────────────────────────

describe('extractDetailData (from captured spike #3 HTML)', () => {
  let html: string;

  try {
    html = loadFixture();
  } catch {
    if (process.env['CI'] === 'true') {
      // In CI the fixture MUST exist — a missing fixture means a broken test setup
      it('fixture exists in CI (FAIL: fixture not found)', () => {
        throw new Error(
          `CI=true but fixture not found at ${FIXTURE_PATH}. ` +
          `Ensure spikes/autotrader/03-price-tier/samples/06-detail-page.html is checked in.`,
        );
      });
    } else {
      // Running locally without fixture — log and skip
      console.log(`[detail.test] Skipping spike #3 fixture tests — fixture not found at ${FIXTURE_PATH}`);
      it.skip('fixture not found at ' + FIXTURE_PATH, () => {});
    }
    // eslint-disable-next-line no-var
    var html_missing = true;
  }

  if (!html_missing!) {
    it('extracts priceIndicator as "LOW"', () => {
      const data = extractDetailData(html!);
      expect(data).not.toBeNull();
      expect(data!.priceIndicator).toBe('LOW');
    });

    it('extracts priceIndicatorLabel as "Lower price"', () => {
      const data = extractDetailData(html!);
      expect(data!.priceIndicatorLabel).toBe('Lower price');
    });

    it('extracts mileageText containing "55,010"', () => {
      const data = extractDetailData(html!);
      expect(data!.mileageText).toContain('55,010');
    });

    it('extracts mileageNum as 55010', () => {
      const data = extractDetailData(html!);
      expect(data!.mileageNum).toBe(55010);
    });

    it('extracts fuel as "Petrol"', () => {
      const data = extractDetailData(html!);
      expect(data!.fuel).toBe('Petrol');
    });

    it('extracts transmission as "Automatic"', () => {
      const data = extractDetailData(html!);
      expect(data!.transmission).toBe('Automatic');
    });

    it('extracts bodyType as "Saloon"', () => {
      const data = extractDetailData(html!);
      expect(data!.bodyType).toBe('Saloon');
    });

    it('extracts year as 2015', () => {
      const data = extractDetailData(html!);
      expect(data!.year).toBe(2015);
    });

    it('extracts the categorized equipment list incl. Drivers Assistance', () => {
      const data = extractDetailData(html!);
      expect(Array.isArray(data!.features)).toBe(true);
      const da = data!.features!.find((c) => /driver/i.test(c.category));
      expect(da).toBeDefined();
      // Items carry a Standard/Optional type, used for feature verification
      expect(da!.items.length).toBeGreaterThan(0);
      expect(da!.items.some((i) => i.type === 'Standard' || i.type === 'Optional')).toBe(true);
    });

    it('extracts specs incl. dimensions (boot space)', () => {
      const data = extractDetailData(html!);
      expect(Array.isArray(data!.specs)).toBe(true);
      const allItems = data!.specs!.flatMap((c) => c.items.map((i) => i.name.toLowerCase()));
      expect(allItems.some((n) => n.includes('boot'))).toBe(true);
    });

    it('extracts extra keySpecification fields (seats)', () => {
      const data = extractDetailData(html!);
      expect(data!.seats).toBe('5');
    });

    it('builds detailLocationText with town and postcode (lowercase key)', () => {
      const data = extractDetailData(html!);
      expect(data!.detailLocationText).toBe('Leicester, LE2 6UP');
    });

    it('extracts priceNumeric as 10989', () => {
      const data = extractDetailData(html!);
      expect(data!.priceNumeric).toBe(10989);
    });

    it('extracts deviation (negative for "below market average")', () => {
      const data = extractDetailData(html!);
      // "£1,732 below market average" → -1732
      expect(data!.deviation).toBe(-1732);
    });

    it('extracts sellerName (contains AUTO INVESTMENTS)', () => {
      const data = extractDetailData(html!);
      expect(data!.sellerName).toContain('AUTO INVESTMENTS');
    });

    it('returns ≥4 spec fields', () => {
      const data = extractDetailData(html!);
      const specFields = [
        data!.fuel,
        data!.transmission,
        data!.bodyType,
        data!.mileageText,
        data!.year,
        data!.priceIndicator,
      ].filter(Boolean);
      expect(specFields.length).toBeGreaterThanOrEqual(4);
    });
  }
});

// ─── extractDetailData edge cases ────────────────────────────────────────────

describe('extractDetailData edge cases', () => {
  it('returns null for empty HTML', () => {
    expect(extractDetailData('')).toBeNull();
  });

  it('returns null if __staticRouterHydrationData is absent and no SVG gauge', () => {
    expect(extractDetailData('<html><body>No data here</body></html>')).toBeNull();
  });

  it('uses SVG fallback when __staticRouterHydrationData absent but gauge present', () => {
    const fakeHtml = `
      <div data-testid="price-indicator-gauge">
        <svg><title>GREAT</title></svg>
      </div>
    `;
    const data = extractDetailData(fakeHtml);
    expect(data).not.toBeNull();
    expect(data!.priceIndicator).toBe('GREAT');
    // Other fields should be null in fallback
    expect(data!.mileageText).toBeNull();
    expect(data!.fuel).toBeNull();
  });

  it('handles broken JSON in __staticRouterHydrationData gracefully', () => {
    const brokenHtml = `<script>window.__staticRouterHydrationData = JSON.parse("NOT_VALID_JSON");</script>`;
    expect(extractDetailData(brokenHtml)).toBeNull();
  });
});

// ─── isSoldPage ──────────────────────────────────────────────────────────────

describe('isSoldPage', () => {
  it('detects "This car has been sold" banner', () => {
    expect(isSoldPage('<div>This car has been sold</div>')).toBe(true);
    expect(isSoldPage('<div>This Car Has Been Sold</div>')).toBe(true);
  });

  it('detects "car is no longer available"', () => {
    expect(isSoldPage('Sorry, this car is no longer available.')).toBe(true);
  });

  it('returns false for normal listing page', () => {
    expect(isSoldPage('<div>This car is available for purchase</div>')).toBe(false);
  });
});

// ─── mergeDetailAttributes ───────────────────────────────────────────────────

describe('mergeDetailAttributes', () => {
  const base: NormalisedListing = {
    source: 'autotrader',
    sourceId: 'at-123',
    title: 'Audi A4',
    url: 'https://www.autotrader.co.uk/car-details/at-123',
    priceGbp: 10000,
    currency: 'GBP',
    sellerType: 'TRADE',
    attributes: { make: 'Audi', model: 'A4', year: 2015 },
  };

  it('merges price tier and spec into attributes', () => {
    const detail = {
      priceIndicator: 'GREAT',
      priceIndicatorLabel: 'Great price',
      deviation: -500,
      mileageText: '30,000 miles',
      mileageNum: 30000,
      fuel: 'Petrol',
      transmission: 'Automatic',
      bodyType: 'Saloon',
      colour: 'Black',
      year: 2015,
      registrationPlate: '65 reg',
      sellerName: 'Test Dealer',
      dealerUrl: 'https://dealer.example.com',
      detailLocationText: 'Leicester, LE3 5AB',
      priceFormatted: '£10,000',
      priceNumeric: 10000,
      priceDeviationText: '£500 below market average',
      seats: '5',
      doors: '4',
      engineLitres: '2.0L',
      owners: '1',
      features: [
        {
          category: 'Drivers Assistance',
          items: [
            { name: 'Adaptive Cruise Control', type: 'Optional' },
            { name: 'Lane Departure Warning', type: 'Standard' },
          ],
        },
      ],
      specs: [
        { category: 'Size and dimensions', items: [{ name: 'Boot space (seats up)', value: '480L' }] },
      ],
      description: 'Lovely example, full service history.',
    };

    const merged = mergeDetailAttributes(base, detail);
    expect(merged.attributes['price_tier']).toBe('GREAT');
    expect(merged.attributes['price_tier_label']).toBe('Great price');
    expect(merged.attributes['price_deviation_gbp']).toBe(-500);
    expect(merged.attributes['location_text']).toBe('Leicester, LE3 5AB');
    expect(merged.attributes['mileage_num']).toBe(30000);
    expect(merged.attributes['mileage_text']).toBe('30,000 miles');
    expect(merged.attributes['fuel']).toBe('Petrol');
    expect(merged.attributes['transmission']).toBe('Automatic');
    expect(merged.attributes['body_type']).toBe('Saloon');
    expect(merged.attributes['colour']).toBe('Black');
    expect(merged.attributes['registration_plate']).toBe('65 reg');
    expect(merged.attributes['seller_name']).toBe('Test Dealer');
    expect(merged.attributes['seats']).toBe('5');
    expect(merged.attributes['engine_litres']).toBe('2.0L');
    // Equipment list persisted for feature verification
    const feats = merged.attributes['features'] as Array<{ category: string; items: Array<{ name: string; type: string | null }> }>;
    expect(feats[0].category).toBe('Drivers Assistance');
    expect(feats[0].items.find((i) => i.name === 'Adaptive Cruise Control')?.type).toBe('Optional');
  });

  it('preserves existing attributes from search', () => {
    const detail = {
      priceIndicator: null,
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
      sellerName: null,
      dealerUrl: null,
      detailLocationText: null,
      priceFormatted: null,
      priceNumeric: null,
      priceDeviationText: null,
      seats: null, doors: null, engineLitres: null, owners: null,
      features: null, specs: null, description: null,
    };
    const merged = mergeDetailAttributes(base, detail);
    expect(merged.attributes['make']).toBe('Audi');
    expect(merged.attributes['model']).toBe('A4');
    expect(merged.attributes['year']).toBe(2015);
  });

  it('updates priceGbp if detail has a numeric price', () => {
    const detail = {
      priceIndicator: null, priceIndicatorLabel: null, deviation: null,
      mileageText: null, mileageNum: null, fuel: null, transmission: null,
      bodyType: null, colour: null, year: null, registrationPlate: null,
      sellerName: null, dealerUrl: null, detailLocationText: null,
      priceFormatted: '£11,500', priceNumeric: 11500,
      priceDeviationText: null,
      seats: null, doors: null, engineLitres: null, owners: null,
      features: null, specs: null, description: null,
    };
    const merged = mergeDetailAttributes(base, detail);
    expect(merged.priceGbp).toBe(11500);
  });

  it('preserves original priceGbp if detail has no numeric price', () => {
    const detail = {
      priceIndicator: null, priceIndicatorLabel: null, deviation: null,
      mileageText: null, mileageNum: null, fuel: null, transmission: null,
      bodyType: null, colour: null, year: null, registrationPlate: null,
      sellerName: null, dealerUrl: null, detailLocationText: null,
      priceFormatted: null, priceNumeric: null,
      priceDeviationText: null,
      seats: null, doors: null, engineLitres: null, owners: null,
      features: null, specs: null, description: null,
    };
    const merged = mergeDetailAttributes(base, detail);
    expect(merged.priceGbp).toBe(10000);
  });
});

// ─── Live integration (LIVE=1 only) ──────────────────────────────────────────

if (process.env.LIVE === '1') {
  describe('LIVE: fetchDetailPage', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fetches real car detail page and extracts ≥4 spec fields', async () => {
      const { fetchDetailPage } = await import('./detail.js');
      // Using the same advertId from spike #3
      const result = await fetchDetailPage('202605282783235');
      expect(result.listing).not.toBeNull();
      const attrs = result.listing!.attributes;

      const specFields = [
        attrs['fuel'],
        attrs['transmission'],
        attrs['body_type'],
        attrs['mileage_text'],
        attrs['year'],
        attrs['price_tier'],
      ].filter(Boolean);

      expect(specFields.length).toBeGreaterThanOrEqual(4);
    }, 30000);
  });
}
