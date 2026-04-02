/**
 * eBay Browse API search adapter.
 * Fires parallel requests across AUCTION, FIXED_PRICE, BEST_OFFER and deduplicates.
 * Ported from container/agent-runner/src/ebay-search-mcp.ts for host-side use.
 */

import { logger } from '../logger.js';
import { EBAY_MARKETPLACE, SEARCH_LIMIT_PER_FORMAT } from '../config.js';
import type { ItemSummary, SearchResponse, FormatResult } from './types.js';

const BROWSE_API_BASE = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const BUYING_FORMATS = ['AUCTION', 'FIXED_PRICE', 'BEST_OFFER'] as const;

export interface SearchResult {
  items: ItemSummary[];
  totalByFormat: Record<string, number>;
  errors: Array<{ format: string; error: string }>;
  apiCallCount: number;
}

async function searchByFormat(
  format: string,
  q: string,
  token: string,
  marketplace: string,
  limit: number,
  categoryIds?: string,
): Promise<FormatResult> {
  const params = new URLSearchParams({
    q,
    limit: String(limit),
    filter: `buyingOptions:{${format}}`,
  });
  if (categoryIds) params.set('category_ids', categoryIds);

  const url = `${BROWSE_API_BASE}?${params.toString()}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplace,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (resp.status === 401) throw new Error('401 Unauthorized');
    return { format, items: [], total: 0, error: `${resp.status} ${resp.statusText}: ${body.slice(0, 200)}` };
  }

  const data = (await resp.json()) as SearchResponse;
  return {
    format,
    items: data.itemSummaries || [],
    total: data.total ?? 0,
  };
}

function deduplicateItems(results: FormatResult[]): ItemSummary[] {
  const seen = new Map<string, ItemSummary>();
  for (const r of results) {
    for (const item of r.items) {
      if (!seen.has(item.itemId)) {
        seen.set(item.itemId, item);
      }
    }
  }
  return Array.from(seen.values());
}

export async function searchEbay(
  query: string,
  token: string,
  marketplace = EBAY_MARKETPLACE,
  limit = SEARCH_LIMIT_PER_FORMAT,
  categoryIds?: string,
): Promise<SearchResult> {
  const results = await Promise.allSettled(
    BUYING_FORMATS.map((fmt) => searchByFormat(fmt, query, token, marketplace, limit, categoryIds)),
  );

  const succeeded: FormatResult[] = [];
  const errors: Array<{ format: string; error: string }> = [];

  results.forEach((result, i) => {
    const format = BUYING_FORMATS[i];
    if (result.status === 'fulfilled') {
      if (result.value.error) {
        errors.push({ format, error: result.value.error });
      } else {
        succeeded.push(result.value);
      }
    } else {
      // Re-throw auth errors so caller can invalidate token
      if (String(result.reason).includes('401')) throw result.reason;
      errors.push({ format, error: String(result.reason) });
    }
  });

  const items = deduplicateItems(succeeded);
  const totalByFormat: Record<string, number> = {};
  for (const r of succeeded) totalByFormat[r.format] = r.total;

  logger.debug({ query, itemCount: items.length, totalByFormat, errors: errors.length }, 'eBay search complete');

  return { items, totalByFormat, errors, apiCallCount: 3 };
}
