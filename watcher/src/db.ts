/**
 * Database access layer for the watcher.
 * Owns the deal-hunter.db schema — creates tables if they don't exist.
 * The container MCP server connects to the same DB but does not create tables.
 */

import Database from 'better-sqlite3';
import { logger } from './logger.js';
import type { ItemSummary } from './ebay/types.js';

export interface Hunt {
  id: number;
  name: string;
  status: string;
  criteria: string;
  search_terms: string;
  cadence_minutes: number;
  monitoring: number;
  category_ids: string | null;
  created_at: string;
}

export interface SearchTermEntry {
  terms: string;
  category_ids?: string;
}

/** Parse search_terms JSON, handling both legacy string[] and new SearchTermEntry[] format. */
export function parseSearchTerms(raw: string): SearchTermEntry[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('search_terms must be a JSON array');
  if (parsed.length === 0) return [];
  if (typeof parsed[0] === 'string') {
    return (parsed as string[]).map((t) => ({ terms: t }));
  }
  return parsed as SearchTermEntry[];
}

export interface Offer {
  id: number;
  source: string;
  source_id: string;
  title: string;
  url: string | null;
  seller: string | null;
  seller_rating: number | null;
  condition: string | null;
  buying_format: string | null;
  auction_end_time: string | null;
  bid_count: number | null;
  watching: number;
  watch_conditions: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  last_status_change: string | null;
  notified_thresholds: string | null;
}

export interface UpsertResult {
  offerId: number;
  isNew: boolean;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hunts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'closed')),
      criteria TEXT NOT NULL DEFAULT '{}',
      search_terms TEXT NOT NULL DEFAULT '[]',
      cadence_minutes INTEGER NOT NULL DEFAULT 60,
      monitoring INTEGER NOT NULL DEFAULT 1,
      category_ids TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      close_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      seller TEXT,
      seller_rating REAL,
      condition TEXT,
      specs_extracted TEXT DEFAULT '{}',
      buying_format TEXT,
      auction_end_time TEXT,
      bid_count INTEGER,
      watching INTEGER NOT NULL DEFAULT 0,
      watch_conditions TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'ended', 'removed', 'sold')),
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source, source_id)
    );

    CREATE TABLE IF NOT EXISTS search_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      source TEXT NOT NULL,
      terms TEXT NOT NULL,
      result_count INTEGER DEFAULT 0,
      new_offer_count INTEGER DEFAULT 0,
      relevant_count INTEGER DEFAULT 0,
      searched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hunt_offers (
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      offer_id INTEGER NOT NULL REFERENCES offers(id),
      search_query_id INTEGER REFERENCES search_queries(id),
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'evaluated', 'watching', 'dismissed')),
      first_associated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (hunt_id, offer_id)
    );

    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER NOT NULL REFERENCES offers(id),
      price REAL NOT NULL,
      shipping REAL,
      currency TEXT NOT NULL DEFAULT 'GBP',
      total_landed_gbp REAL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER NOT NULL REFERENCES offers(id),
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      decision TEXT NOT NULL CHECK(decision IN ('alert', 'skip', 'watch')),
      reasoning TEXT,
      evaluated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER NOT NULL REFERENCES offers(id),
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      urgency TEXT NOT NULL DEFAULT 'medium' CHECK(urgency IN ('high', 'medium', 'low')),
      message_sent TEXT,
      alerted_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_response TEXT,
      feedback_extracted TEXT,
      responded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS market_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      name TEXT NOT NULL,
      description TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      filter_patterns TEXT NOT NULL DEFAULT '{}',
      price_low REAL,
      price_mid REAL,
      price_high REAL,
      sample_size INTEGER DEFAULT 0,
      confidence TEXT DEFAULT 'LOW' CHECK(confidence IN ('HIGH', 'MEDIUM', 'LOW')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hunt_id, name)
    );

    CREATE TABLE IF NOT EXISTS baseline_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_id INTEGER REFERENCES market_segments(id),
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      source_type TEXT NOT NULL CHECK(source_type IN ('sold', 'active', 'auction_completed')),
      title TEXT NOT NULL,
      price REAL NOT NULL,
      shipping REAL,
      total_landed_gbp REAL,
      condition TEXT,
      sold_date TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_url TEXT,
      source_item_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_offers_source ON offers(source, source_id);
    CREATE INDEX IF NOT EXISTS idx_offers_watching ON offers(watching) WHERE watching = 1;
    CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
    CREATE INDEX IF NOT EXISTS idx_hunt_offers_status ON hunt_offers(hunt_id, status);
    CREATE INDEX IF NOT EXISTS idx_prices_offer ON prices(offer_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_evaluations_hunt ON evaluations(hunt_id);
    CREATE INDEX IF NOT EXISTS idx_evaluations_offer ON evaluations(offer_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_hunt ON alerts(hunt_id, alerted_at);
    CREATE INDEX IF NOT EXISTS idx_search_queries_hunt ON search_queries(hunt_id, searched_at);
    CREATE INDEX IF NOT EXISTS idx_market_segments_hunt ON market_segments(hunt_id);
    CREATE INDEX IF NOT EXISTS idx_baseline_prices_hunt ON baseline_prices(hunt_id);
    CREATE INDEX IF NOT EXISTS idx_baseline_prices_segment ON baseline_prices(segment_id);
  `);

  // Migrations — add columns that were introduced after initial schema
  const huntCols = db.prepare("PRAGMA table_info('hunts')").all() as Array<{ name: string }>;
  if (!huntCols.some((c) => c.name === 'monitoring')) {
    db.exec('ALTER TABLE hunts ADD COLUMN monitoring INTEGER NOT NULL DEFAULT 1');
  }
  if (!huntCols.some((c) => c.name === 'category_ids')) {
    db.exec('ALTER TABLE hunts ADD COLUMN category_ids TEXT');
  }
  if (!huntCols.some((c) => c.name === 'last_reviewed_at')) {
    db.exec('ALTER TABLE hunts ADD COLUMN last_reviewed_at TEXT');
  }

  const offerCols = db.prepare("PRAGMA table_info('offers')").all() as Array<{ name: string }>;
  if (!offerCols.some((c) => c.name === 'last_status_change')) {
    db.exec('ALTER TABLE offers ADD COLUMN last_status_change TEXT');
  }
  if (!offerCols.some((c) => c.name === 'notified_thresholds')) {
    db.exec("ALTER TABLE offers ADD COLUMN notified_thresholds TEXT DEFAULT '[]'");
  }
}

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  ensureSchema(db);
  logger.info({ dbPath }, 'Database ready');
  return db;
}

// --- Read operations ---

export function getActiveHunts(db: Database.Database): Hunt[] {
  return db.prepare("SELECT * FROM hunts WHERE status = 'active' AND monitoring = 1").all() as Hunt[];
}

export function getWatchedOffers(db: Database.Database): Offer[] {
  return db.prepare("SELECT * FROM offers WHERE watching = 1 AND status = 'active'").all() as Offer[];
}

export function getOfferBySourceId(db: Database.Database, source: string, sourceId: string): Offer | undefined {
  return db.prepare('SELECT * FROM offers WHERE source = ? AND source_id = ?').get(source, sourceId) as
    | Offer
    | undefined;
}

export function getLatestPrice(
  db: Database.Database,
  offerId: number,
): { price: number; shipping: number | null; total_landed_gbp: number | null; observed_at: string } | undefined {
  return db
    .prepare('SELECT price, shipping, total_landed_gbp, observed_at FROM prices WHERE offer_id = ? ORDER BY observed_at DESC LIMIT 1')
    .get(offerId) as { price: number; shipping: number | null; total_landed_gbp: number | null; observed_at: string } | undefined;
}

export function getLastSearchTime(db: Database.Database, huntId: number, terms: string): string | undefined {
  const row = db
    .prepare('SELECT MAX(searched_at) as last FROM search_queries WHERE hunt_id = ? AND terms = ?')
    .get(huntId, terms) as { last: string | null } | undefined;
  return row?.last ?? undefined;
}

export function getHuntIdsForOffer(db: Database.Database, offerId: number): number[] {
  const rows = db
    .prepare('SELECT hunt_id FROM hunt_offers WHERE offer_id = ?')
    .all(offerId) as Array<{ hunt_id: number }>;
  return rows.map((r) => r.hunt_id);
}

export function getHunt(db: Database.Database, huntId: number): Hunt | undefined {
  return db.prepare('SELECT * FROM hunts WHERE id = ?').get(huntId) as Hunt | undefined;
}

// --- Write operations ---

/** Upsert an offer from eBay search results. Returns the offer ID and whether it was new. */
export function upsertOffer(db: Database.Database, item: ItemSummary): UpsertResult {
  const source = 'ebay';
  const sourceId = item.itemId;
  const existing = db.prepare('SELECT id FROM offers WHERE source = ? AND source_id = ?').get(source, sourceId) as
    | { id: number }
    | undefined;

  if (existing) {
    const sets: string[] = ["last_seen_at = datetime('now')"];
    const params: unknown[] = [];

    if (item.title) { sets.push('title = ?'); params.push(item.title); }
    if (item.seller?.username) { sets.push('seller = ?'); params.push(item.seller.username); }
    if (item.seller?.feedbackScore != null) { sets.push('seller_rating = ?'); params.push(parseFloat(item.seller.feedbackPercentage || '0')); }
    if (item.condition) { sets.push('condition = ?'); params.push(item.condition); }
    if (item.buyingOptions?.length) { sets.push('buying_format = ?'); params.push(item.buyingOptions.join(',')); }
    if (item.itemEndDate) { sets.push('auction_end_time = ?'); params.push(item.itemEndDate); }
    if (item.bidCount != null) { sets.push('bid_count = ?'); params.push(item.bidCount); }

    params.push(existing.id);
    db.prepare(`UPDATE offers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return { offerId: existing.id, isNew: false };
  }

  const buyingFormat = item.buyingOptions?.join(',') || null;
  const result = db
    .prepare(
      `INSERT INTO offers (source, source_id, title, url, seller, seller_rating, condition,
       buying_format, auction_end_time, bid_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      source,
      sourceId,
      item.title,
      item.itemWebUrl || null,
      item.seller?.username || null,
      item.seller?.feedbackPercentage ? parseFloat(item.seller.feedbackPercentage) : null,
      item.condition || null,
      buyingFormat,
      item.itemEndDate || null,
      item.bidCount ?? null,
    );

  return { offerId: result.lastInsertRowid as number, isNew: true };
}

export function recordPrice(
  db: Database.Database,
  offerId: number,
  price: number,
  shipping: number | null,
  currency = 'GBP',
  totalLandedGbp: number | null = null,
): void {
  db.prepare(
    'INSERT INTO prices (offer_id, price, shipping, currency, total_landed_gbp) VALUES (?, ?, ?, ?, ?)',
  ).run(offerId, price, shipping, currency, totalLandedGbp);
}

export function recordSearch(
  db: Database.Database,
  huntId: number,
  source: string,
  terms: string,
  resultCount: number,
  newOfferCount: number,
): number {
  const result = db
    .prepare(
      'INSERT INTO search_queries (hunt_id, source, terms, result_count, new_offer_count) VALUES (?, ?, ?, ?, ?)',
    )
    .run(huntId, source, terms, resultCount, newOfferCount);
  return result.lastInsertRowid as number;
}

export function associateOfferWithHunt(
  db: Database.Database,
  huntId: number,
  offerId: number,
  searchQueryId: number,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO hunt_offers (hunt_id, offer_id, search_query_id, status) VALUES (?, ?, ?, 'new')",
  ).run(huntId, offerId, searchQueryId);
}

export function updateOfferStatus(db: Database.Database, offerId: number, status: string): void {
  db.prepare("UPDATE offers SET status = ?, last_status_change = datetime('now') WHERE id = ?").run(status, offerId);
}

export function getNotifiedThresholds(db: Database.Database, offerId: number): number[] {
  const row = db.prepare('SELECT notified_thresholds FROM offers WHERE id = ?').get(offerId) as { notified_thresholds: string | null } | undefined;
  if (!row?.notified_thresholds) return [];
  try { return JSON.parse(row.notified_thresholds); } catch { return []; }
}

export function addNotifiedThreshold(db: Database.Database, offerId: number, thresholdHours: number): void {
  const current = getNotifiedThresholds(db, offerId);
  if (!current.includes(thresholdHours)) {
    current.push(thresholdHours);
    db.prepare('UPDATE offers SET notified_thresholds = ? WHERE id = ?').run(JSON.stringify(current), offerId);
  }
}

export function updateOfferWatchFields(
  db: Database.Database,
  offerId: number,
  fields: { bid_count?: number; auction_end_time?: string; price?: number; shipping?: number },
): void {
  const sets: string[] = ["last_seen_at = datetime('now')"];
  const params: unknown[] = [];
  if (fields.bid_count != null) { sets.push('bid_count = ?'); params.push(fields.bid_count); }
  if (fields.auction_end_time) { sets.push('auction_end_time = ?'); params.push(fields.auction_end_time); }
  params.push(offerId);
  db.prepare(`UPDATE offers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/** Run a full search result write as a transaction (upsert offers, record prices, associate with hunt). */
export function applySearchResults(
  db: Database.Database,
  huntId: number,
  terms: string,
  items: ItemSummary[],
): { newCount: number; totalCount: number; searchQueryId: number } {
  let newCount = 0;

  const run = db.transaction(() => {
    const searchQueryId = recordSearch(db, huntId, 'ebay', terms, items.length, 0); // newCount updated after

    for (const item of items) {
      const { offerId, isNew } = upsertOffer(db, item);
      if (isNew) newCount++;

      // Record price observation
      const priceVal = item.currentBidPrice?.value || item.price?.value;
      if (priceVal) {
        const price = parseFloat(priceVal);
        const shippingVal = item.shippingOptions?.[0]?.shippingCost?.value;
        const shipping = shippingVal ? parseFloat(shippingVal) : null;
        recordPrice(db, offerId, price, shipping);
      }

      associateOfferWithHunt(db, huntId, offerId, searchQueryId);
    }

    // Update the search query with actual new count
    db.prepare('UPDATE search_queries SET new_offer_count = ? WHERE id = ?').run(newCount, searchQueryId);

    return searchQueryId;
  });

  const searchQueryId = run();
  return { newCount, totalCount: items.length, searchQueryId };
}
