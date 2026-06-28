/**
 * Tests for NormalisedListing schema round-trip and source adapter registry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../db.js';
import { registerAdapter, getAdapter, listAdapters, hasAdapter } from './index.js';
import type { SourceAdapter, NormalisedListing, SearchOutcome, StateOutcome } from './types.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ---- In-memory DB helper ----

function makeTestDb(): Database.Database {
  // Use a temp file path so openDatabase's PRAGMA WAL works (WAL doesn't support :memory: reliably)
  const tmp = path.join(os.tmpdir(), `test-dh-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDatabase(tmp);
  // Schedule cleanup
  process.on('exit', () => { try { fs.unlinkSync(tmp); } catch { /* ok */ } });
  return db;
}

// ---- Round-trip test ----

describe('NormalisedListing DB round-trip', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    // Insert a dummy hunt so foreign keys are satisfied
    db.prepare(
      `INSERT INTO hunts (name, status, criteria, search_terms) VALUES ('test-hunt', 'active', '{}', '[]')`
    ).run();
  });

  it('round-trips vertical and attributes through offers table', () => {
    // Insert an offer with vertical and attributes directly (simulating what Stream A's upsertNormalisedListing will do)
    const listing: NormalisedListing = {
      source: 'autotrader',
      sourceId: 'at-12345',
      title: '2018 Audi A4 TDI',
      url: 'https://autotrader.co.uk/car-details/12345',
      priceGbp: 14995,
      currency: 'GBP',
      thumbnailUrl: 'https://example.com/img.jpg',
      sellerType: 'TRADE',
      attributes: {
        year: 2018,
        mileage_num: 67000,
        fuel: 'Diesel',
        transmission: 'Manual',
        price_tier: 'GREAT',
      },
    };

    const attrs = JSON.stringify(listing.attributes);

    db.prepare(`
      INSERT INTO offers (source, source_id, title, url, thumbnail_url, vertical, attributes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(listing.source, listing.sourceId, listing.title, listing.url, listing.thumbnailUrl ?? null, 'cars', attrs);

    const row = db.prepare('SELECT * FROM offers WHERE source = ? AND source_id = ?')
      .get(listing.source, listing.sourceId) as Record<string, unknown>;

    expect(row).toBeTruthy();
    expect(row['source']).toBe('autotrader');
    expect(row['source_id']).toBe('at-12345');
    expect(row['title']).toBe('2018 Audi A4 TDI');
    expect(row['vertical']).toBe('cars');

    const parsedAttrs = JSON.parse(row['attributes'] as string) as Record<string, unknown>;
    expect(parsedAttrs['year']).toBe(2018);
    expect(parsedAttrs['mileage_num']).toBe(67000);
    expect(parsedAttrs['fuel']).toBe('Diesel');
    expect(parsedAttrs['price_tier']).toBe('GREAT');
  });

  it('attributes JSON round-trips with nested objects', () => {
    const nestedAttrs = {
      spec: {
        engine: '2.0 TDI',
        doors: 4,
      },
      price_context: {
        deviation: -1732,
        label: 'Lower price',
      },
      tags: ['manual', 'diesel'],
    };

    db.prepare(`
      INSERT INTO offers (source, source_id, title, vertical, attributes)
      VALUES (?, ?, ?, ?, ?)
    `).run('autotrader', 'at-nested', 'Test Car', 'cars', JSON.stringify(nestedAttrs));

    const row = db.prepare('SELECT attributes FROM offers WHERE source_id = ?')
      .get('at-nested') as { attributes: string };

    const parsed = JSON.parse(row.attributes) as typeof nestedAttrs;
    expect(parsed.spec.engine).toBe('2.0 TDI');
    expect(parsed.spec.doors).toBe(4);
    expect(parsed.price_context.deviation).toBe(-1732);
    expect(parsed.tags).toEqual(['manual', 'diesel']);
  });

  it('vertical defaults to null for legacy offers (no vertical set)', () => {
    db.prepare(`INSERT INTO offers (source, source_id, title) VALUES (?, ?, ?)`).run('ebay', 'legacy-1', 'Old Computer');
    const row = db.prepare('SELECT vertical FROM offers WHERE source_id = ?').get('legacy-1') as { vertical: string | null };
    // No vertical set — should be null (legacy offers treated as 'computers' by readers)
    expect(row.vertical).toBeNull();
  });

  it('attributes column defaults to empty JSON object', () => {
    db.prepare(`INSERT INTO offers (source, source_id, title) VALUES (?, ?, ?)`).run('ebay', 'legacy-2', 'Old GPU');
    const row = db.prepare('SELECT attributes FROM offers WHERE source_id = ?').get('legacy-2') as { attributes: string };
    expect(JSON.parse(row.attributes)).toEqual({});
  });
});

// ---- Registry tests ----

describe('Source adapter registry', () => {
  // Note: the ebay adapter registers itself on import of './ebay/index.js'.
  // We work with fresh adapters by creating our own for these tests.
  // (The ebay adapter imported by types.test.ts side-effects are harmless.)

  it('registers and retrieves an adapter', () => {
    const mockAdapter: SourceAdapter = {
      id: 'mock-source',
      capabilities: { hasAuctions: false, richSearch: true, needsDetailFetch: false },
      minIntervalMs: 1000,
      async search(): Promise<SearchOutcome> {
        return { listings: [], apiCalls: 1, errors: [] };
      },
      async getState(): Promise<StateOutcome> {
        return { status: 'active', apiCalls: 1 };
      },
    };

    registerAdapter(mockAdapter);
    const retrieved = getAdapter('mock-source');
    expect(retrieved.id).toBe('mock-source');
    expect(retrieved.capabilities.richSearch).toBe(true);
  });

  it('hasAdapter returns true for registered adapter', () => {
    const adapter: SourceAdapter = {
      id: 'mock-has-test',
      capabilities: { hasAuctions: true, richSearch: false, needsDetailFetch: true },
      minIntervalMs: 6000,
      async search(): Promise<SearchOutcome> { return { listings: [], apiCalls: 0, errors: [] }; },
      async getState(): Promise<StateOutcome> { return { status: 'active', apiCalls: 0 }; },
    };
    registerAdapter(adapter);
    expect(hasAdapter('mock-has-test')).toBe(true);
    expect(hasAdapter('nonexistent-source')).toBe(false);
  });

  it('getAdapter throws for unknown source', () => {
    expect(() => getAdapter('totally-unknown-source-xyz')).toThrow('Unknown source adapter: totally-unknown-source-xyz');
  });

  it('listAdapters returns all registered adapters', () => {
    const before = listAdapters().length;
    const adapter: SourceAdapter = {
      id: `list-test-${Date.now()}`,
      capabilities: { hasAuctions: false, richSearch: false, needsDetailFetch: false },
      minIntervalMs: 0,
      async search(): Promise<SearchOutcome> { return { listings: [], apiCalls: 0, errors: [] }; },
      async getState(): Promise<StateOutcome> { return { status: 'active', apiCalls: 0 }; },
    };
    registerAdapter(adapter);
    expect(listAdapters().length).toBe(before + 1);
    expect(listAdapters().some((a) => a.id === adapter.id)).toBe(true);
  });
});
