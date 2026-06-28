/**
 * EbayAdapter unit tests.
 * Mocks searchEbay and getItemState to verify NormalisedListing mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth module before importing adapter
vi.mock('./auth.js', () => ({
  getToken: vi.fn().mockResolvedValue('test-token'),
  invalidateToken: vi.fn(),
  isAuthError: vi.fn().mockReturnValue(false),
}));

// Mock search module
vi.mock('./search.js', () => ({
  searchEbay: vi.fn(),
}));

// Mock watch module
vi.mock('./watch.js', () => ({
  getItemState: vi.fn(),
}));

// Mock logger
vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock config
vi.mock('../../config.js', () => ({
  EBAY_CLIENT_ID: 'test-id',
  EBAY_CLIENT_SECRET: 'test-secret',
  EBAY_MARKETPLACE: 'EBAY_GB',
  SEARCH_LIMIT_PER_FORMAT: 50,
  TOKEN_REFRESH_MS: 5_400_000,
}));

// Mock the registry to avoid side-effects in tests
vi.mock('../index.js', () => ({
  registerAdapter: vi.fn(),
  getAdapter: vi.fn(),
  hasAdapter: vi.fn(),
  listAdapters: vi.fn(),
}));

import { searchEbay } from './search.js';
import { getItemState } from './watch.js';
import { ebayAdapter, normaliseItem } from './index.js';
import type { ItemSummary } from './types.js';

const mockSearchEbay = vi.mocked(searchEbay);
const mockGetItemState = vi.mocked(getItemState);

const makeSummary = (overrides: Partial<ItemSummary> = {}): ItemSummary => ({
  itemId: 'v1|123456|0',
  title: 'Test GPU RTX 3080',
  price: { value: '450.00', currency: 'GBP' },
  buyingOptions: ['FIXED_PRICE'],
  condition: 'USED',
  itemWebUrl: 'https://ebay.co.uk/itm/123456',
  image: { imageUrl: 'https://i.ebayimg.com/thumb.jpg' },
  ...overrides,
});

describe('normaliseItem', () => {
  it('maps all standard fields correctly', () => {
    const item = makeSummary();
    const listing = normaliseItem(item);

    expect(listing.source).toBe('ebay');
    expect(listing.sourceId).toBe('v1|123456|0');
    expect(listing.title).toBe('Test GPU RTX 3080');
    expect(listing.url).toBe('https://ebay.co.uk/itm/123456');
    expect(listing.priceGbp).toBe(450);
    expect(listing.currency).toBe('GBP');
    expect(listing.thumbnailUrl).toBe('https://i.ebayimg.com/thumb.jpg');
    expect(listing.sellerType).toBeNull();
    expect(listing.condition).toBe('USED');
    expect(listing.buyingFormat).toBe('FIXED_PRICE');
    expect(listing.auctionEndTime).toBeNull();
    expect(listing.bidCount).toBeNull();
    expect(listing.attributes).toEqual({});
  });

  it('prefers currentBidPrice over price for auctions', () => {
    const item = makeSummary({
      price: { value: '100.00', currency: 'GBP' },
      currentBidPrice: { value: '75.00', currency: 'GBP' },
      buyingOptions: ['AUCTION'],
      bidCount: 3,
      itemEndDate: '2026-07-01T12:00:00Z',
    });
    const listing = normaliseItem(item);

    expect(listing.priceGbp).toBe(75);
    expect(listing.buyingFormat).toBe('AUCTION');
    expect(listing.bidCount).toBe(3);
    expect(listing.auctionEndTime).toBe('2026-07-01T12:00:00Z');
  });

  it('handles missing optional fields gracefully', () => {
    const item: ItemSummary = {
      itemId: 'v1|999|0',
      title: 'Minimal Item',
    };
    const listing = normaliseItem(item);

    expect(listing.priceGbp).toBeNull();
    expect(listing.url).toBe('');
    expect(listing.thumbnailUrl).toBeUndefined();
    expect(listing.condition).toBeNull();
    expect(listing.buyingFormat).toBeNull();
    expect(listing.attributes).toEqual({});
  });

  it('always produces empty attributes for eBay items', () => {
    const listing = normaliseItem(makeSummary({ condition: 'NEW', bidCount: 5 }));
    expect(listing.attributes).toEqual({});
  });
});

describe('EbayAdapter.search()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns normalised listings on success', async () => {
    mockSearchEbay.mockResolvedValueOnce({
      items: [makeSummary(), makeSummary({ itemId: 'v1|999|0', title: 'Another Item' })],
      totalByFormat: { FIXED_PRICE: 2 },
      errors: [],
      apiCallCount: 3,
    });

    const outcome = await ebayAdapter.search({ terms: 'rtx 3080' });

    expect(outcome.listings).toHaveLength(2);
    expect(outcome.apiCalls).toBe(3);
    expect(outcome.errors).toHaveLength(0);
    expect(outcome.sourceMeta?.totalByFormat).toEqual({ FIXED_PRICE: 2 });

    const first = outcome.listings[0];
    expect(first.source).toBe('ebay');
    expect(first.attributes).toEqual({});
  });

  it('includes source errors in outcome without throwing', async () => {
    mockSearchEbay.mockResolvedValueOnce({
      items: [],
      totalByFormat: {},
      errors: [{ format: 'AUCTION', error: '503 Service Unavailable' }],
      apiCallCount: 3,
    });

    const outcome = await ebayAdapter.search({ terms: 'broken' });

    expect(outcome.listings).toHaveLength(0);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].scope).toBe('AUCTION');
  });

  it('handles search function throwing', async () => {
    mockSearchEbay.mockRejectedValueOnce(new Error('network error'));

    const outcome = await ebayAdapter.search({ terms: 'bad' });

    expect(outcome.listings).toHaveLength(0);
    expect(outcome.errors[0].error).toContain('network error');
  });
});

describe('EbayAdapter.getState()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps active item to active StateOutcome', async () => {
    mockGetItemState.mockResolvedValueOnce({
      item: {
        itemId: 'v1|123|0',
        title: 'Test',
        price: { value: '250.00', currency: 'GBP' },
        bidCount: 0,
        itemEndDate: undefined,
      },
      removed: false,
      ended: false,
      apiCallCount: 1,
    });

    const outcome = await ebayAdapter.getState('v1|123|0');

    expect(outcome.status).toBe('active');
    expect(outcome.priceGbp).toBe(250);
    expect(outcome.apiCalls).toBe(1);
  });

  it('maps removed item to removed status', async () => {
    mockGetItemState.mockResolvedValueOnce({
      item: null,
      removed: true,
      ended: false,
      apiCallCount: 1,
    });

    const outcome = await ebayAdapter.getState('v1|gone|0');
    expect(outcome.status).toBe('removed');
  });

  it('maps ended item to ended status', async () => {
    mockGetItemState.mockResolvedValueOnce({
      item: { itemId: 'v1|old|0', title: 'Old', itemEndDate: '2020-01-01T00:00:00Z' },
      removed: false,
      ended: true,
      apiCallCount: 1,
    });

    const outcome = await ebayAdapter.getState('v1|old|0');
    expect(outcome.status).toBe('ended');
  });

  it('returns active with error if getItemState has error field', async () => {
    mockGetItemState.mockResolvedValueOnce({
      item: null,
      removed: false,
      ended: false,
      error: '500 Internal Server Error',
      apiCallCount: 1,
    });

    const outcome = await ebayAdapter.getState('v1|err|0');
    expect(outcome.status).toBe('active');
    expect(outcome.error).toBe('500 Internal Server Error');
  });

  it('handles thrown errors gracefully', async () => {
    mockGetItemState.mockRejectedValueOnce(new Error('network failure'));

    const outcome = await ebayAdapter.getState('v1|crash|0');
    expect(outcome.status).toBe('active');
    expect(outcome.error).toContain('network failure');
  });
});
