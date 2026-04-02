/**
 * eBay Browse API watch adapter.
 * Fetches current state of individual items via getItem endpoint.
 */

import { logger } from '../logger.js';
import { EBAY_MARKETPLACE } from '../config.js';
import type { ItemDetail } from './types.js';

const ITEM_API_BASE = 'https://api.ebay.com/buy/browse/v1/item';

export interface WatchResult {
  item: ItemDetail | null;
  removed: boolean;
  error?: string;
  apiCallCount: number;
}

export async function getItemState(
  itemId: string,
  token: string,
  marketplace = EBAY_MARKETPLACE,
): Promise<WatchResult> {
  const url = `${ITEM_API_BASE}/${encodeURIComponent(itemId)}`;

  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': marketplace,
        'Content-Type': 'application/json',
      },
    });

    if (resp.status === 404) {
      return { item: null, removed: true, apiCallCount: 1 };
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      if (resp.status === 401) throw new Error('401 Unauthorized');
      return { item: null, removed: false, error: `${resp.status}: ${body.slice(0, 200)}`, apiCallCount: 1 };
    }

    const data = (await resp.json()) as ItemDetail;
    return { item: data, removed: false, apiCallCount: 1 };
  } catch (err) {
    if (err instanceof Error && err.message.includes('401')) throw err;
    logger.error({ itemId, err }, 'getItem failed');
    return { item: null, removed: false, error: String(err), apiCallCount: 1 };
  }
}
