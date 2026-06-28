/**
 * Sold Data Tool (MCP)
 *
 * Scrapes eBay UK sold/completed listings for historical price data.
 * Used by the agent during price baselining to understand what items
 * have actually sold for, as opposed to current asking prices.
 *
 * Low volume by design — a few calls when a hunt starts, periodic refreshes.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as cheerio from 'cheerio';
import puppeteer, { type Browser } from 'puppeteer-core';

// --- Constants ---

const RATE_LIMIT_MS = 3000;
const MAX_PAGES = 3;
const ITEMS_PER_PAGE = 200;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// --- Types ---

interface SoldItem {
  title: string;
  sold_price: number;
  shipping: number;
  condition: string;
  sold_date: string;
  item_id: string;
}

interface ScrapeResult {
  items: SoldItem[];
  pages_fetched: number;
  has_more: boolean;
  errors: string[];
}

// --- Helpers ---

function log(message: string): void {
  console.error(`[sold-data] ${message}`);
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// --- URL Builder ---

function buildSearchUrl(terms: string, page: number): string {
  const params = new URLSearchParams({
    _nkw: terms,
    _sacat: '0',
    rt: 'nc',
    LH_Sold: '1',
    LH_Complete: '1',
    _ipg: String(ITEMS_PER_PAGE),
    _sop: '10', // newest first
  });
  if (page > 1) {
    params.set('_pgn', String(page));
  }
  return `https://www.ebay.co.uk/sch/i.html?${params.toString()}`;
}

// --- Browser Management ---

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
let browserInstance: Browser | null = null;
let browserCloseTimer: ReturnType<typeof setTimeout> | null = null;
const BROWSER_IDLE_TIMEOUT_MS = 60_000; // close after 60s idle

async function getBrowser(): Promise<Browser> {
  // Reset idle timer on each use
  if (browserCloseTimer) {
    clearTimeout(browserCloseTimer);
    browserCloseTimer = null;
  }

  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  log('Launching headless Chromium...');
  browserInstance = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });
  log('Chromium launched');
  return browserInstance;
}

function scheduleBrowserClose(): void {
  if (browserCloseTimer) clearTimeout(browserCloseTimer);
  browserCloseTimer = setTimeout(async () => {
    if (browserInstance) {
      log('Closing idle browser');
      await browserInstance.close().catch(() => {});
      browserInstance = null;
    }
  }, BROWSER_IDLE_TIMEOUT_MS);
}

// --- Fetch ---

async function fetchPage(url: string): Promise<string> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(randomUserAgent());
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-GB,en;q=0.9',
    });

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    if (!response) {
      throw new Error('fetch_error: no response');
    }

    const status = response.status();
    if (status === 429) {
      throw new Error('rate_limited');
    }
    if (status >= 400) {
      throw new Error(`fetch_error: HTTP ${status}`);
    }

    // Wait briefly for any dynamic content
    await delay(1000);

    const html = await page.content();

    // Check for CAPTCHA
    const head = html.slice(0, 3000).toLowerCase();
    if (head.includes('pardon our interruption') || head.includes('captcha') ||
        head.includes('are you a human')) {
      throw new Error('captcha_detected');
    }

    return html;
  } finally {
    await page.close().catch(() => {});
    scheduleBrowserClose();
  }
}

// --- Parsers ---

function parsePrice(text: string): number | null {
  if (!text) return null;

  const cleaned = text.replace(/[£,]/g, '').trim();

  // "Best offer accepted" — can't determine price
  if (cleaned.toLowerCase().includes('best offer')) return null;

  // Range: "100.00 to 150.00" — take higher value (final sold price for auctions)
  if (cleaned.toLowerCase().includes(' to ')) {
    const parts = cleaned.split(/\s+to\s+/i);
    const high = parseFloat(parts[parts.length - 1].replace(/[^\d.]/g, ''));
    if (isNaN(high)) return null;
    return high;
  }

  const value = parseFloat(cleaned.replace(/[^\d.]/g, ''));
  if (isNaN(value)) return null;
  return value;
}

function parseSoldDate(text: string): string | null {
  if (!text) return null;

  // Expected: "Sold 15 Mar 2026" or "Sold Mar 15, 2026"
  const cleaned = text.replace(/^sold\s+/i, '').trim();

  // Try "15 Mar 2026" (UK format)
  const ukMatch = cleaned.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})$/);
  if (ukMatch) {
    const day = parseInt(ukMatch[1]);
    const month = MONTH_MAP[ukMatch[2].toLowerCase()];
    const year = parseInt(ukMatch[3]);
    if (month !== undefined && !isNaN(day) && !isNaN(year)) {
      return new Date(year, month, day).toISOString().split('T')[0];
    }
  }

  // Try "Mar 15, 2026" (US format)
  const usMatch = cleaned.match(/^(\w{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (usMatch) {
    const month = MONTH_MAP[usMatch[1].toLowerCase()];
    const day = parseInt(usMatch[2]);
    const year = parseInt(usMatch[3]);
    if (month !== undefined && !isNaN(day) && !isNaN(year)) {
      return new Date(year, month, day).toISOString().split('T')[0];
    }
  }

  return null;
}

function parseShipping(text: string): number {
  if (!text) return 0;

  const lower = text.toLowerCase();
  if (lower.includes('free')) return 0;

  // "+£5.99 postage" or "£5.99 postage"
  const match = text.match(/£([\d,.]+)/);
  if (match) {
    const value = parseFloat(match[1].replace(',', ''));
    if (!isNaN(value)) return value;
  }

  return 0;
}

// --- HTML Scraper ---

function parseCardLayout($: cheerio.CheerioAPI): SoldItem[] {
  const items: SoldItem[] = [];

  $('li.s-card').each((_, el) => {
    const $el = $(el);

    // Title — from .s-card__title, ignore .clipped "Opens in new tab" spans
    const titleEl = $el.find('.s-card__title .su-styled-text').not('.clipped').first();
    const title = titleEl.text().trim();
    if (!title || title === 'Shop on eBay' || title.startsWith('Shop on eBay')) return;

    // Price — .s-card__price class on a span
    const priceText = $el.find('.s-card__price').first().text().trim();
    const price = parsePrice(priceText);
    if (price === null) return;

    // Sold date — .s-card__caption contains "Sold  19 Mar 2026"
    const captionText = $el.find('.s-card__caption .su-styled-text').first().text().trim();
    const soldDate = parseSoldDate(captionText);

    // Shipping — look for text containing "delivery" or "postage" in attribute rows
    let shipping = 0;
    $el.find('.s-card__attribute-row').each((_, row) => {
      const rowText = $(row).text().trim();
      if (rowText.toLowerCase().includes('free') &&
          (rowText.toLowerCase().includes('delivery') || rowText.toLowerCase().includes('postage'))) {
        shipping = 0;
      } else if (rowText.includes('£') &&
                 (rowText.toLowerCase().includes('delivery') || rowText.toLowerCase().includes('postage'))) {
        shipping = parseShipping(rowText);
      }
    });

    // Condition — .s-card__subtitle
    const condition = $el.find('.s-card__subtitle .su-styled-text').first().text().trim() || 'Unknown';

    // Extract item ID from the link wrapping the title heading
    const titleLink = $el.find('a.s-card__link').filter((_, a) => {
      return $(a).find('.s-card__title').length > 0;
    }).first();
    const href = titleLink.attr('href') || '';
    const itemIdMatch = href.match(/\/itm\/(\d+)/);
    const itemId = itemIdMatch ? itemIdMatch[1] : '';

    items.push({
      title,
      sold_price: price,
      shipping,
      condition,
      sold_date: soldDate || '',
      item_id: itemId,
    });
  });

  return items;
}

function parseLegacyLayout($: cheerio.CheerioAPI): SoldItem[] {
  const items: SoldItem[] = [];

  $('li.s-item').each((_, el) => {
    const $el = $(el);

    const title = $el.find('.s-item__title').first().text().trim();
    if (!title || title === 'Shop on eBay' || title.startsWith('Shop on eBay')) return;

    const priceText = $el.find('.s-item__price').first().text().trim();
    const price = parsePrice(priceText);
    if (price === null) return;

    const soldDateText = $el.find('.POSITIVE').first().text().trim();
    const soldDate = parseSoldDate(soldDateText);

    const shippingText = $el.find('.s-item__shipping, .s-item__freeXDays').first().text().trim();
    const shipping = parseShipping(shippingText);

    const condition = $el.find('.SECONDARY_INFO').first().text().trim() || 'Unknown';

    const href = $el.find('.s-item__link').first().attr('href') || '';
    const itemIdMatch = href.match(/\/itm\/(\d+)/);
    const itemId = itemIdMatch ? itemIdMatch[1] : '';

    items.push({
      title,
      sold_price: price,
      shipping,
      condition,
      sold_date: soldDate || '',
      item_id: itemId,
    });
  });

  return items;
}

function parseSoldItems(html: string): { items: SoldItem[]; warnings: string[] } {
  const $ = cheerio.load(html);
  const warnings: string[] = [];

  // Detect layout: eBay uses .s-card (current) or .s-item (legacy)
  const hasCards = $('li.s-card').length > 0;
  const hasItems = $('li.s-item').length > 0;

  if (hasCards) {
    const items = parseCardLayout($);
    if (hasItems) {
      warnings.push('Page has both .s-card and .s-item elements; using .s-card');
    }
    return { items, warnings };
  }

  if (hasItems) {
    const items = parseLegacyLayout($);
    return { items, warnings };
  }

  warnings.push('No listing elements found in page (.s-card or .s-item)');
  return { items: [], warnings };
}

// --- Core Scrape Function ---

async function scrapeEbaySold(
  searchTerms: string,
  daysBack: number,
  maxResults: number,
  page: number,
): Promise<ScrapeResult> {
  const errors: string[] = [];
  let allItems: SoldItem[] = [];
  const pagesNeeded = Math.min(Math.ceil((page * maxResults) / ITEMS_PER_PAGE), MAX_PAGES);

  for (let ebayPage = 1; ebayPage <= pagesNeeded; ebayPage++) {
    const url = buildSearchUrl(searchTerms, ebayPage);
    log(`Fetching page ${ebayPage}/${pagesNeeded}: ${url}`);

    try {
      const html = await fetchPage(url);
      const { items, warnings } = parseSoldItems(html);
      errors.push(...warnings);

      if (items.length === 0) {
        log(`Page ${ebayPage} returned no items, stopping pagination`);
        break;
      }

      allItems.push(...items);
      log(`Page ${ebayPage}: parsed ${items.length} items (total: ${allItems.length})`);

      // Rate limit before next page
      if (ebayPage < pagesNeeded) {
        await delay(RATE_LIMIT_MS);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Page ${ebayPage}: ${msg}`);
      log(`Page ${ebayPage} error: ${msg}`);

      // If page 1 fails, we have nothing — propagate
      if (ebayPage === 1) {
        return { items: [], pages_fetched: 0, has_more: false, errors };
      }
      // Otherwise, return what we have from earlier pages
      break;
    }
  }

  // Filter by days_back
  if (daysBack < 90) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    allItems = allItems.filter(item => {
      if (!item.sold_date) return true; // keep items without dates (can't filter)
      return item.sold_date >= cutoffStr;
    });
  }

  // Paginate results
  const offset = (page - 1) * maxResults;
  const hasMore = allItems.length > offset + maxResults;
  allItems = allItems.slice(offset, offset + maxResults);

  const ebayPagesFetched = Math.min(errors.filter(e => e.startsWith('Page')).length > 0
    ? Math.max(1, allItems.length > 0 ? Math.ceil(allItems.length / ITEMS_PER_PAGE) : 0)
    : Math.min(pagesNeeded, Math.ceil((allItems.length || 1) / ITEMS_PER_PAGE)),
    pagesNeeded);

  return {
    items: allItems,
    pages_fetched: ebayPagesFetched,
    has_more: hasMore,
    errors,
  };
}

// --- MCP Server ---

const server = new McpServer({
  name: 'sold-data',
  version: '1.0.0',
});

// Tool 1: get_sold_prices
server.tool(
  'get_sold_prices',
  'Fetch historical sold/completed listing prices from eBay UK. Returns individual sold items with price, shipping, condition, and date. Use for price baselining research.',
  {
    search_terms: z.string().describe('Search query (e.g. "lenovo m90q gen 3")'),
    marketplace: z.string().default('ebay_gb').describe('Marketplace ID (only ebay_gb supported)'),
    days_back: z.number().min(1).max(90).default(90).describe('How far back to look (max 90 days)'),
    max_results: z.number().min(1).max(600).default(50).describe('Maximum items to return per page'),
    page: z.number().min(1).default(1).describe('Page number for pagination (each page returns max_results items)'),
  },
  async ({ search_terms, marketplace, days_back, max_results, page }) => {
    if (marketplace !== 'ebay_gb') {
      return errorResult(`Unsupported marketplace: ${marketplace}. Only ebay_gb is supported.`);
    }

    log(`get_sold_prices: "${search_terms}" (${days_back}d, max ${max_results}, page ${page})`);
    const result = await scrapeEbaySold(search_terms, days_back, max_results, page);

    if (result.items.length === 0 && result.errors.length > 0) {
      return errorResult(result.errors.join('; '));
    }

    return jsonResult({
      items: result.items,
      meta: {
        search_terms,
        marketplace,
        currency: 'GBP',
        days_back,
        page,
        max_results,
        total_fetched: result.items.length,
        has_more: result.has_more,
        pages_fetched: result.pages_fetched,
        errors: result.errors.length > 0 ? result.errors : undefined,
      },
    });
  },
);

// --- Start Server ---

const transport = new StdioServerTransport();
await server.connect(transport);
