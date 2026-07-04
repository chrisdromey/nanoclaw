/**
 * Regression test for the cars-attributes-in-list-views bug.
 *
 * The list endpoints (`GET /watched` and `GET /hunts/:id/offers`) historically
 * did `SELECT o.*`, returning the `attributes` column as a raw JSON STRING. The
 * frontend (OffersTab) treats `offer.attributes` as an object, so cars Year /
 * Mileage columns silently rendered "—". This test asserts both endpoints now
 * return `attributes` as a parsed object.
 *
 * The existing source-specific component test passes an already-parsed object,
 * which masked this bug — so the assertion lives at the API boundary here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// In-memory DB the mocked getDealDb() hands to the route handlers.
let db: Database.Database;

vi.mock('../../server/db.js', () => ({
  getDealDb: () => db,
}));

// Avoid pulling in the AutoTrader adapter (which imports the watcher's compiled
// rate-limit module) — the list endpoints never call into the sources layer.
vi.mock('../../server/sources/index.js', () => ({
  checkOfferStatusBySource: vi.fn(),
  pendingRefreshJobs: new Map(),
}));

import { offerRoutes } from '../../server/routes/offers';
import { huntRoutes } from '../../server/routes/hunts';
import { baselineRoutes } from '../../server/routes/baseline';

const CARS_ATTRIBUTES = { year: 2019, mileage_text: '45,000 miles' };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE hunts (
      id INTEGER PRIMARY KEY,
      name TEXT,
      vertical TEXT,
      sources TEXT
    );
    CREATE TABLE offers (
      id INTEGER PRIMARY KEY,
      source TEXT,
      source_id TEXT,
      title TEXT,
      condition TEXT,
      buying_format TEXT,
      status TEXT,
      watching INTEGER,
      auction_end_time TEXT,
      last_seen_at TEXT,
      attributes TEXT
    );
    CREATE TABLE hunt_offers (
      hunt_id INTEGER,
      offer_id INTEGER,
      status TEXT,
      first_associated_at TEXT
    );
    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      offer_id INTEGER,
      price REAL,
      shipping REAL,
      total_landed_gbp REAL,
      observed_at TEXT
    );
    CREATE TABLE market_segments (
      id INTEGER PRIMARY KEY,
      hunt_id INTEGER,
      name TEXT,
      created_at TEXT
    );
    CREATE TABLE baseline_prices (
      id INTEGER PRIMARY KEY,
      segment_id INTEGER,
      hunt_id INTEGER,
      source_type TEXT,
      observed_at TEXT
    );
    CREATE TABLE knowledge_base (id INTEGER PRIMARY KEY, hunt_id INTEGER);
    CREATE TABLE claim_verifications (id INTEGER PRIMARY KEY, hunt_id INTEGER, verdict TEXT);
  `);

  db.prepare('INSERT INTO hunts (id, name, vertical, sources) VALUES (?, ?, ?, ?)')
    .run(1, 'Audi A4 hunt', 'cars', null);
  db.prepare(
    `INSERT INTO offers (id, source, source_id, title, status, watching, auction_end_time, last_seen_at, attributes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(10, 'autotrader', '2024012345', '2019 Audi A4', 'active', 1, null, '2024-01-02T00:00:00', JSON.stringify(CARS_ATTRIBUTES));
  db.prepare('INSERT INTO hunt_offers (hunt_id, offer_id, status, first_associated_at) VALUES (?, ?, ?, ?)')
    .run(1, 10, 'watching', '2024-01-01T00:00:00');
  db.prepare('INSERT INTO prices (offer_id, price, shipping, total_landed_gbp, observed_at) VALUES (?, ?, ?, ?, ?)')
    .run(10, 18000, 0, 18000, '2024-01-02T00:00:00');
});

describe('GET /watched returns parsed attributes', () => {
  it('returns attributes as an object, not a JSON string', async () => {
    const res = await offerRoutes.request('/watched');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ attributes: Record<string, unknown> }>;
    expect(body).toHaveLength(1);
    expect(typeof body[0].attributes).toBe('object');
    expect(body[0].attributes).toEqual(CARS_ATTRIBUTES);
    // The OffersTab access pattern (attrs.year) must yield a value, not undefined.
    expect(body[0].attributes.year).toBe(2019);
  });
});

describe('GET /hunts/:id/offers returns parsed attributes', () => {
  it('returns attributes as an object, not a JSON string', async () => {
    const res = await huntRoutes.request('/hunts/1/offers?status=watching');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ attributes: Record<string, unknown> }>;
    expect(body).toHaveLength(1);
    expect(typeof body[0].attributes).toBe('object');
    expect(body[0].attributes).toEqual(CARS_ATTRIBUTES);
    expect(body[0].attributes.mileage_text).toBe('45,000 miles');
  });

  it('defaults a null-sources cars hunt to [autotrader], not [ebay]', async () => {
    const res = await huntRoutes.request('/hunts/1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: string[] };
    expect(body.sources).toEqual(['autotrader']);
  });
});

describe('GET /hunts/:id/baseline active_offer_prices', () => {
  interface BaselineOfferRow {
    offer_id: number;
    title: string;
    current_price: number | null;
    condition: string | null;
    buying_format: string | null;
    source: string;
    auction_end_time: string | null;
    attributes: Record<string, unknown>;
  }

  // Extra offers only the baseline tests need (nested beforeEach runs after
  // the outer one). watching=0 + hunt_offers status 'evaluated' keeps them out
  // of the /watched and /hunts/:id/offers?status=watching assertions above.
  beforeEach(() => {
    const insertOffer = db.prepare(
      `INSERT INTO offers (id, source, source_id, title, condition, buying_format, status, watching, auction_end_time, last_seen_at, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // eBay auction offer: NULL attributes, auction_end_time set (the latent
    // bug — this column was never selected, so "ending soon" could not fire).
    insertOffer.run(11, 'ebay', 'ebay-111', 'ThinkStation P620', 'Used', 'AUCTION', 'active', 0, '2024-06-01T12:00:00Z', '2024-01-02T00:00:00', null);
    // eBay-style offer with the adapter's default empty attributes JSON.
    insertOffer.run(12, 'ebay', 'ebay-222', 'Dell Precision 7920', 'Refurbished', 'FIXED_PRICE', 'active', 0, null, '2024-01-02T00:00:00', '{}');
    const insertHuntOffer = db.prepare(
      'INSERT INTO hunt_offers (hunt_id, offer_id, status, first_associated_at) VALUES (?, ?, ?, ?)',
    );
    insertHuntOffer.run(1, 11, 'evaluated', '2024-01-01T00:00:00');
    insertHuntOffer.run(1, 12, 'evaluated', '2024-01-01T00:00:00');
    const insertPrice = db.prepare(
      'INSERT INTO prices (offer_id, price, shipping, total_landed_gbp, observed_at) VALUES (?, ?, ?, ?, ?)',
    );
    insertPrice.run(11, 900, 0, 900, '2024-01-02T00:00:00');
    insertPrice.run(12, 1200, 0, 1200, '2024-01-02T00:00:00');
  });

  async function fetchRows(): Promise<Map<number, BaselineOfferRow>> {
    const res = await baselineRoutes.request('/hunts/1/baseline');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active_offer_prices: BaselineOfferRow[] };
    return new Map(body.active_offer_prices.map((r) => [r.offer_id, r]));
  }

  it('rows carry source and auction_end_time', async () => {
    const rows = await fetchRows();
    expect(rows.get(11)?.source).toBe('ebay');
    expect(rows.get(11)?.auction_end_time).toBe('2024-06-01T12:00:00Z');
    expect(rows.get(10)?.source).toBe('autotrader');
    expect(rows.get(10)?.auction_end_time).toBeNull();
  });

  it('returns attributes parsed to an object', async () => {
    const rows = await fetchRows();
    expect(rows.get(10)?.attributes).toEqual(CARS_ATTRIBUTES);
    expect((rows.get(10)?.attributes as { year?: number }).year).toBe(2019);
  });

  it("NULL and '{}' attributes both come back as {}", async () => {
    const rows = await fetchRows();
    expect(rows.get(11)?.attributes).toEqual({});
    expect(rows.get(12)?.attributes).toEqual({});
  });

  it('eBay-style rows are otherwise unaffected', async () => {
    const rows = await fetchRows();
    const ebay = rows.get(12);
    expect(ebay?.title).toBe('Dell Precision 7920');
    expect(ebay?.condition).toBe('Refurbished');
    expect(ebay?.buying_format).toBe('FIXED_PRICE');
    expect(ebay?.current_price).toBe(1200);
  });
});
