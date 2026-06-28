/**
 * eBay source adapter — full implementation.
 * Wraps existing searchEbay() and getItemState() into the SourceAdapter interface.
 */

import { logger } from '../../logger.js';
import { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } from '../../config.js';
import { registerAdapter } from '../index.js';
import type { SourceAdapter, SearchOutcome, StateOutcome, NormalisedListing } from '../types.js';
import { getToken, invalidateToken, isAuthError } from './auth.js';
import { searchEbay } from './search.js';
import { getItemState } from './watch.js';
import type { ItemSummary } from './types.js';

export { getToken, invalidateToken, isAuthError } from './auth.js';
export { searchEbay } from './search.js';
export { getItemState } from './watch.js';
export type { ItemSummary, ItemDetail, SearchResponse, FormatResult } from './types.js';

export interface EbaySearchParams {
  terms: string;
  categoryIds?: string;  // comma-separated, e.g. "179" or "179,9355"
}

/** Parse price from ItemSummary — prefers currentBidPrice for auctions, falls back to price. */
function parsePriceGbp(item: ItemSummary): number | null {
  const raw = item.currentBidPrice?.value || item.price?.value;
  if (!raw) return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

/** Map an eBay ItemSummary to a NormalisedListing. */
export function normaliseItem(item: ItemSummary): NormalisedListing {
  return {
    source: 'ebay',
    sourceId: item.itemId,
    title: item.title,
    url: item.itemWebUrl ?? '',
    priceGbp: parsePriceGbp(item),
    currency: item.price?.currency ?? item.currentBidPrice?.currency ?? 'GBP',
    thumbnailUrl: item.image?.imageUrl,
    sellerType: null,  // eBay doesn't distinguish trade/private
    condition: item.condition ?? null,
    buyingFormat: item.buyingOptions?.join(',') ?? null,
    auctionEndTime: item.itemEndDate ?? null,
    bidCount: item.bidCount ?? null,
    attributes: {},  // eBay quirks live in top-level columns, not attributes
  };
}

class EbayAdapter implements SourceAdapter {
  readonly id = 'ebay';
  readonly capabilities = {
    hasAuctions: true,
    richSearch: true,
    needsDetailFetch: false,
  };
  readonly minIntervalMs = 0;  // Rate-limited by OAuth quotas, not wall-clock

  async search(nativeParams: unknown): Promise<SearchOutcome> {
    const params = nativeParams as EbaySearchParams;
    const token = await getToken(EBAY_CLIENT_ID, EBAY_CLIENT_SECRET);
    if (!token) {
      return {
        listings: [],
        apiCalls: 0,
        errors: [{ scope: 'auth', error: 'No eBay access token' }],
      };
    }

    try {
      const result = await searchEbay(params.terms, token, undefined, undefined, params.categoryIds);

      const listings: NormalisedListing[] = result.items.map(normaliseItem);

      const sourceMeta: Record<string, unknown> = {
        totalByFormat: result.totalByFormat,
      };

      return {
        listings,
        apiCalls: result.apiCallCount,
        sourceMeta,
        errors: result.errors.map((e) => ({ scope: e.format, error: e.error })),
      };
    } catch (err) {
      if (isAuthError(err)) invalidateToken();
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, terms: params.terms }, 'EbayAdapter.search failed');
      return {
        listings: [],
        apiCalls: 0,
        errors: [{ scope: 'search', error: msg }],
      };
    }
  }

  async getState(sourceId: string): Promise<StateOutcome> {
    const token = await getToken(EBAY_CLIENT_ID, EBAY_CLIENT_SECRET);
    if (!token) {
      return {
        status: 'active',
        apiCalls: 0,
        error: 'No eBay access token',
      };
    }

    try {
      const result = await getItemState(sourceId, token);

      if (result.error) {
        return {
          status: 'active',
          apiCalls: result.apiCallCount,
          error: result.error,
        };
      }

      if (result.removed) {
        return { status: 'removed', apiCalls: result.apiCallCount };
      }
      if (result.ended) {
        return { status: 'ended', apiCalls: result.apiCallCount };
      }

      const item = result.item;
      const priceStr = item?.currentBidPrice?.value || item?.price?.value;
      return {
        status: 'active',
        priceGbp: priceStr ? parseFloat(priceStr) : null,
        bidCount: item?.bidCount ?? null,
        auctionEndTime: item?.itemEndDate ?? null,
        apiCalls: result.apiCallCount,
      };
    } catch (err) {
      if (isAuthError(err)) invalidateToken();
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, sourceId }, 'EbayAdapter.getState failed');
      return {
        status: 'active',
        apiCalls: 0,
        error: msg,
      };
    }
  }
}

const ebayAdapter = new EbayAdapter();
registerAdapter(ebayAdapter);

export { ebayAdapter };
