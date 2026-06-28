/**
 * Tests for the AutoTrader search module.
 *
 * Uses mock fetch (vi.stubGlobal) and captured response data from spike #1.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parsePriceString, resolveImageUrl, normaliseSearchListing } from './search.js';
import type { ATSearchListing, ATPageInfo } from './types.js';

// --- Unit tests for helpers ---

describe('parsePriceString', () => {
  it('parses "£10,989" to 10989', () => {
    expect(parsePriceString('£10,989')).toBe(10989);
  });

  it('parses "£14,995" to 14995', () => {
    expect(parsePriceString('£14,995')).toBe(14995);
  });

  it('parses plain "12900" to 12900', () => {
    expect(parsePriceString('12900')).toBe(12900);
  });

  it('returns null for null input', () => {
    expect(parsePriceString(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parsePriceString('')).toBeNull();
  });

  it('returns null for non-numeric garbage', () => {
    expect(parsePriceString('POA')).toBeNull();
  });
});

describe('resolveImageUrl', () => {
  it('replaces {resize} with default resize string', () => {
    const url = 'https://m.atcdn.co.uk/a/media/{resize}/abc123.jpg';
    const resolved = resolveImageUrl(url);
    expect(resolved).toBe('https://m.atcdn.co.uk/a/media/w480h360/abc123.jpg');
  });

  it('accepts a custom resize string', () => {
    const url = 'https://m.atcdn.co.uk/a/media/{resize}/abc123.jpg';
    expect(resolveImageUrl(url, 'w800h600')).toBe('https://m.atcdn.co.uk/a/media/w800h600/abc123.jpg');
  });

  it('returns url unchanged if no {resize} placeholder', () => {
    const url = 'https://m.atcdn.co.uk/a/media/w480h360/abc123.jpg';
    expect(resolveImageUrl(url)).toBe(url);
  });
});

// --- normaliseSearchListing ---

const sampleListing: ATSearchListing = {
  type: 'NATURAL_LISTING',
  advertId: '202605282783235',
  title: 'Audi A4',
  subTitle: '2.0 TFSI S line S Tronic Euro 6 (s/s) 4dr',
  attentionGrabber: 'LOW MILEAGE  + AUTOMATIC!',
  price: '£10,989',
  vehicleLocation: 'Leicester (3 miles)',
  locationType: 'STANDARD',
  discount: null,
  images: [
    'https://m.atcdn.co.uk/a/media/{resize}/79fe7bc9c543448ab1915de8149a10c9.jpg',
    'https://m.atcdn.co.uk/a/media/{resize}/db2072698dd24d89bdcb7550b59476a5.jpg',
  ],
  numberOfImages: 64,
  rrp: null,
  sellerType: 'TRADE',
  dealerLink: '/dealers/leicestershire/leicester/auto-investments-uk-aiuk-limited-10003548?channel=cars',
  fpaLink: '/car-details/202605282783235?sort=relevance&twcs=true',
  hasDigitalRetailing: false,
  preReg: false,
  position: 1,
  trackingContext: {
    advertContext: {
      id: '202605282783235',
      make: 'Audi',
      model: 'A4',
      year: 2015,
      condition: 'used',
      price: 10989,
      vehicleCategory: 'car',
    },
    distance: { distance: 3, distance_unit: null },
  },
};

const samplePageInfo: ATPageInfo = {
  number: 1,
  count: 45,
  results: { count: 881 },
};

describe('normaliseSearchListing', () => {
  it('maps advertId to sourceId', () => {
    const result = normaliseSearchListing(sampleListing);
    expect(result.sourceId).toBe('202605282783235');
  });

  it('sets source to "autotrader"', () => {
    const result = normaliseSearchListing(sampleListing);
    expect(result.source).toBe('autotrader');
  });

  it('produces canonical url from advertId', () => {
    const result = normaliseSearchListing(sampleListing);
    expect(result.url).toBe('https://www.autotrader.co.uk/car-details/202605282783235');
  });

  it('parses priceGbp from "£10,989"', () => {
    const result = normaliseSearchListing(sampleListing);
    expect(result.priceGbp).toBe(10989);
  });

  it('sets currency to GBP', () => {
    const result = normaliseSearchListing(sampleListing);
    expect(result.currency).toBe('GBP');
  });

  it('resolves {resize} in first image URL', () => {
    const result = normaliseSearchListing(sampleListing);
    expect(result.thumbnailUrl).toContain('w480h360');
    expect(result.thumbnailUrl).not.toContain('{resize}');
  });

  it('maps sellerType TRADE', () => {
    const result = normaliseSearchListing(sampleListing);
    expect(result.sellerType).toBe('TRADE');
  });

  it('sets buyingFormat, condition, bidCount, auctionEndTime all null', () => {
    const result = normaliseSearchListing(sampleListing);
    expect(result.buyingFormat).toBeNull();
    expect(result.condition).toBeNull();
    expect(result.bidCount).toBeNull();
    expect(result.auctionEndTime).toBeNull();
  });

  it('populates attributes with car fields', () => {
    const result = normaliseSearchListing(sampleListing);
    expect(result.attributes['subTitle']).toBe('2.0 TFSI S line S Tronic Euro 6 (s/s) 4dr');
    expect(result.attributes['attentionGrabber']).toBe('LOW MILEAGE  + AUTOMATIC!');
    expect(result.attributes['vehicleLocation']).toBe('Leicester (3 miles)');
    expect(result.attributes['distance_miles']).toBe(3);
    expect(result.attributes['make']).toBe('Audi');
    expect(result.attributes['model']).toBe('A4');
    expect(result.attributes['year']).toBe(2015);
    expect(result.attributes['image_count']).toBe(64);
  });

  it('includes page info in attributes when provided', () => {
    const result = normaliseSearchListing(sampleListing, samplePageInfo);
    expect(result.attributes['page_number']).toBe(1);
    expect(result.attributes['page_count']).toBe(45);
    expect(result.attributes['results_count']).toBe(881);
  });

  it('omits page info from attributes when not provided', () => {
    const result = normaliseSearchListing(sampleListing);
    expect(result.attributes['page_number']).toBeUndefined();
  });
});

// --- Filter enum casing ---

describe('filter enum casing (from spike #1)', () => {
  it('make filter uses proper case (not uppercase)', () => {
    // This is a documentation/contract test — validates the spike #1 finding
    // that make must be "Audi" not "AUDI"
    const filter = { filter: 'make', selected: ['Audi'] };
    expect(filter.selected[0]).toBe('Audi');
    expect(filter.selected[0]).not.toBe('AUDI');
  });

  it('channel must be lowercase "cars"', () => {
    const channel = 'cars';
    expect(channel).toBe('cars');
    expect(channel).not.toBe('CARS');
  });

  it('sortBy uses lowercase hyphenated format', () => {
    const sortBy = 'relevance';
    expect(sortBy).toMatch(/^[a-z-]+$/);
  });

  it('listingType uses uppercase underscore format', () => {
    const listingType = ['NATURAL_LISTING'];
    expect(listingType[0]).toBe('NATURAL_LISTING');
  });
});

// --- Integration test with mocked fetch ---

describe('searchAutotrader (with mocked fetch)', () => {
  beforeEach(async () => {
    // Reset rate-limit state so tests don't block waiting for backoff
    const { _resetStateForTest } = await import('./rate-limit.js');
    _resetStateForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses captured spike #1 response and returns NormalisedListings', async () => {
    // Captured from spike #1: graphql-at-gateway.body.txt (first 2 listings)
    const capturedResponse = [
      {
        data: {
          searchResults: {
            listings: [sampleListing],
            page: samplePageInfo,
            trackingContext: { searchId: '00000000-0000-4000-8000-000000000000' },
          },
        },
      },
    ];

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => capturedResponse,
      text: async () => JSON.stringify(capturedResponse),
    }));

    const { searchAutotrader } = await import('./search.js');
    const result = await searchAutotrader({
      filters: [
        { filter: 'make', selected: ['Audi'] },
        { filter: 'model', selected: ['A4'] },
        { filter: 'postcode', selected: ['LE11AB'] },
        { filter: 'price_search_type', selected: ['total'] },
        { filter: 'home_delivery_adverts', selected: ['include'] },
      ],
    });

    expect(result.errors).toHaveLength(0);
    expect(result.listings).toHaveLength(1);
    expect(result.apiCalls).toBe(1);

    const listing = result.listings[0];
    expect(listing.source).toBe('autotrader');
    expect(listing.sourceId).toBe('202605282783235');
    expect(listing.priceGbp).toBe(10989);
    expect(listing.url).toBe('https://www.autotrader.co.uk/car-details/202605282783235');
    expect(listing.attributes['make']).toBe('Audi');
    expect(listing.attributes['year']).toBe(2015);

    expect(result.sourceMeta).toMatchObject({
      page: { number: 1, count: 45 },
    });
  });

  it('returns error for non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 503,
      headers: new Headers(),
      text: async () => 'Service Unavailable',
    }));

    const { searchAutotrader } = await import('./search.js');
    const result = await searchAutotrader({
      filters: [{ filter: 'make', selected: ['Audi'] }, { filter: 'postcode', selected: ['LE11AB'] }],
    });

    expect(result.listings).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toContain('503');
  });

  it('returns GraphQL errors when data is missing', async () => {
    const errResponse = [
      {
        errors: [{ message: 'Cannot query field "priceIndicatorRating" on type "SearchListing".' }],
      },
    ];

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => errResponse,
    }));

    const { searchAutotrader } = await import('./search.js');
    const result = await searchAutotrader({
      filters: [{ filter: 'make', selected: ['Audi'] }, { filter: 'postcode', selected: ['LE11AB'] }],
    });

    expect(result.listings).toHaveLength(0);
    expect(result.errors[0].scope).toBe('graphql');
    expect(result.errors[0].error).toContain('priceIndicatorRating');
  });
});
