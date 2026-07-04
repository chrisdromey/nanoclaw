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
      hunt_id INTEGER
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
