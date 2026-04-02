/**
 * eBay Search Tool (MCP)
 *
 * Searches eBay Browse API across all buying formats (AUCTION, FIXED_PRICE,
 * BEST_OFFER) in parallel, deduplicates by item ID, and returns a single
 * unified result set. Solves the problem where the Browse API silently
 * excludes auction listings unless explicitly filtered.
 *
 * Receives a pre-fetched OAuth token via EBAY_ACCESS_TOKEN env var.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// --- Constants ---

const BROWSE_API_BASE = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const BUYING_FORMATS = ['AUCTION', 'FIXED_PRICE', 'BEST_OFFER'] as const;
const DEFAULT_MARKETPLACE = 'EBAY_GB';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const ACCESS_TOKEN = process.env.EBAY_ACCESS_TOKEN || '';

function log(msg: string) {
  process.stderr.write(`[ebay-search] ${msg}\n`);
}

// --- Types ---

interface ItemSummary {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  currentBidPrice?: { value: string; currency: string };
  buyingOptions?: string[];
  condition?: string;
  bidCount?: number;
  itemEndDate?: string;
  itemLocation?: { postalCode?: string; country?: string };
  seller?: { username?: string; feedbackPercentage?: string; feedbackScore?: number };
  itemWebUrl?: string;
  shippingOptions?: Array<{ shippingCost?: { value: string; currency: string } }>;
  [key: string]: unknown;
}

/** Triage-weight item — only the fields the agent needs to decide whether to getItem. */
interface SlimItem {
  itemId: string;
  title: string;
  categories?: Array<{ categoryId: string; categoryName: string }>;
  price?: { value: string; currency: string };
  currentBidPrice?: { value: string; currency: string };
  condition?: string;
  buyingOptions?: string[];
  bidCount?: number;
  itemEndDate?: string;
  shippingCost?: { value: string; currency: string };
  seller?: string;
  itemWebUrl?: string;
  location?: string;
}

function slimItem(item: ItemSummary): SlimItem {
  const seller = item.seller;
  const sellerStr = seller
    ? `${seller.username} (${seller.feedbackPercentage ?? '?'}%, ${seller.feedbackScore ?? '?'})`
    : undefined;

  const shipping = item.shippingOptions?.[0]?.shippingCost;

  const categories = (item as Record<string, unknown>).categories as
    | Array<{ categoryId: string; categoryName: string }>
    | undefined;

  return {
    itemId: item.itemId,
    title: item.title,
    ...(categories?.length ? { categories } : {}),
    ...(item.price ? { price: item.price } : {}),
    ...(item.currentBidPrice ? { currentBidPrice: item.currentBidPrice } : {}),
    ...(item.condition ? { condition: item.condition } : {}),
    ...(item.buyingOptions ? { buyingOptions: item.buyingOptions } : {}),
    ...(item.bidCount != null ? { bidCount: item.bidCount } : {}),
    ...(item.itemEndDate ? { itemEndDate: item.itemEndDate } : {}),
    ...(shipping ? { shippingCost: shipping } : {}),
    ...(sellerStr ? { seller: sellerStr } : {}),
    ...(item.itemWebUrl ? { itemWebUrl: item.itemWebUrl } : {}),
    ...(item.itemLocation?.country ? { location: item.itemLocation.country } : {}),
  };
}

interface SearchResponse {
  total: number;
  itemSummaries?: ItemSummary[];
  warnings?: unknown[];
}

interface FormatResult {
  format: string;
  items: ItemSummary[];
  total: number;
  error?: string;
}

// --- API ---

async function searchByFormat(
  format: string,
  q: string,
  opts: {
    category_ids?: string;
    filter?: string;
    sort?: string;
    limit: number;
    marketplace: string;
  },
): Promise<FormatResult> {
  const params = new URLSearchParams({ q, limit: String(opts.limit) });

  // Combine user filter with buying format filter
  const buyingFilter = `buyingOptions:{${format}}`;
  const combinedFilter = opts.filter ? `${opts.filter},${buyingFilter}` : buyingFilter;
  params.set('filter', combinedFilter);

  if (opts.category_ids) params.set('category_ids', opts.category_ids);
  if (opts.sort) params.set('sort', opts.sort);

  const url = `${BROWSE_API_BASE}?${params.toString()}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'X-EBAY-C-MARKETPLACE-ID': opts.marketplace,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { format, items: [], total: 0, error: `${resp.status} ${resp.statusText}: ${body}` };
  }

  const data = (await resp.json()) as SearchResponse;
  return {
    format,
    items: data.itemSummaries || [],
    total: data.total ?? 0,
  };
}

function deduplicateAndSlim(results: FormatResult[]): SlimItem[] {
  const seen = new Map<string, SlimItem>();
  for (const r of results) {
    for (const item of r.items) {
      if (!seen.has(item.itemId)) {
        seen.set(item.itemId, slimItem(item));
      }
    }
  }
  return Array.from(seen.values());
}

// --- Helpers ---

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

// --- MCP Server ---

const server = new McpServer({
  name: 'ebay-search',
  version: '1.0.0',
});

server.tool(
  'search_ebay',
  'Search eBay active listings across all buying formats (auction, buy-it-now, best-offer) in parallel. Returns a deduplicated result set.',
  {
    q: z.string().describe('Search keywords (e.g. "lenovo m90q gen 3")'),
    category_ids: z.string().optional().describe('Comma-separated eBay category IDs to narrow results'),
    filter: z.string().optional().describe('Additional Browse API filters (e.g. "price:[50..200],priceCurrency:GBP,conditions:{USED}")'),
    sort: z.string().optional().describe('Sort order: newlyListed, price, -price, endingSoonest (default: newlyListed)'),
    limit: z.number().optional().describe(`Max results per buying format (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Total results can be up to 3x this.`),
    marketplace: z.string().optional().describe(`eBay marketplace ID (default: ${DEFAULT_MARKETPLACE}). Examples: EBAY_GB, EBAY_US, EBAY_DE`),
  },
  async ({ q, category_ids, filter, sort, limit, marketplace }) => {
    if (!ACCESS_TOKEN) {
      return errorResult('EBAY_ACCESS_TOKEN not set. Cannot authenticate with Browse API.');
    }

    const effectiveLimit = Math.min(limit || DEFAULT_LIMIT, MAX_LIMIT);
    const effectiveMarketplace = marketplace || DEFAULT_MARKETPLACE;

    log(`search_ebay: "${q}" (limit=${effectiveLimit}, marketplace=${effectiveMarketplace})`);

    const opts = {
      category_ids,
      filter,
      sort,
      limit: effectiveLimit,
      marketplace: effectiveMarketplace,
    };

    // Fire all three buying format searches in parallel
    const results = await Promise.allSettled(
      BUYING_FORMATS.map((fmt) => searchByFormat(fmt, q, opts)),
    );

    const succeeded: FormatResult[] = [];
    const failed: Array<{ format: string; error: string }> = [];

    results.forEach((result, i) => {
      const format = BUYING_FORMATS[i];
      if (result.status === 'fulfilled') {
        if (result.value.error) {
          failed.push({ format, error: result.value.error });
          log(`  ${format}: error — ${result.value.error}`);
        } else {
          succeeded.push(result.value);
          log(`  ${format}: ${result.value.items.length} items (total: ${result.value.total})`);
        }
      } else {
        failed.push({ format, error: String(result.reason) });
        log(`  ${format}: rejected — ${result.reason}`);
      }
    });

    if (succeeded.length === 0) {
      return errorResult(`All buying format searches failed: ${failed.map((f) => `${f.format}: ${f.error}`).join('; ')}`);
    }

    const items = deduplicateAndSlim(succeeded);

    return jsonResult({
      total: items.length,
      items,
      meta: {
        query: q,
        marketplace: effectiveMarketplace,
        limit_per_format: effectiveLimit,
        formats_searched: succeeded.map((r) => ({ format: r.format, count: r.items.length, api_total: r.total })),
        formats_failed: failed.length > 0 ? failed : undefined,
      },
    });
  },
);

// --- Start Server ---

const transport = new StdioServerTransport();
await server.connect(transport);
