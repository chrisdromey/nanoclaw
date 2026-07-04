/**
 * Scheduler dispatch tests.
 * Verifies per-source dispatch, per-source error isolation,
 * consecutive_failures tracking, and per-source budget enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SchedulerState } from './scheduler.js';

// ---- Mocks ----

vi.mock('./sources/ebay/index.js', () => ({}));
vi.mock('./sources/autotrader/index.js', () => ({}));

const mockGetAdapter = vi.fn();
const mockHasAdapter = vi.fn();

vi.mock('./sources/index.js', () => ({
  getAdapter: (...args: unknown[]) => mockGetAdapter(...args),
  hasAdapter: (...args: unknown[]) => mockHasAdapter(...args),
  registerAdapter: vi.fn(),
}));

const mockGetTranslator = vi.fn();
const mockRegisterTranslator = vi.fn();

vi.mock('./translators/index.js', () => ({
  getTranslator: (...args: unknown[]) => mockGetTranslator(...args),
  registerTranslator: (...args: unknown[]) => mockRegisterTranslator(...args),
}));

vi.mock('./sources/ebay/auth.js', () => ({
  isAuthError: vi.fn().mockReturnValue(false),
  invalidateToken: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./config.js', () => ({
  DAILY_API_BUDGET: 100,
  WATCH_CADENCE_MS: 7_200_000,
  STALENESS_SWEEP_CADENCE_MS: 14_400_000,
  STALE_OFFER_HOURS: 24,
  STALE_QUEUE_DAYS: 7,
  MAX_TRIAGE_BATCH_PER_RUN: 40,
  TRIAGE_DRAIN_CADENCE_MS: 1_800_000,
  EBAY_CLIENT_ID: 'id',
  EBAY_CLIENT_SECRET: 'secret',
  AUCTION_THRESHOLDS: [24, 12, 6],
}));

const mockSendNewOffers = vi.fn();

vi.mock('./notifier.js', () => ({
  sendNewOffersNotification: (...args: unknown[]) => mockSendNewOffers(...args),
  sendUrgentNotification: vi.fn(),
  sendPriceChangeNotification: vi.fn(),
}));

// DB mock — in-memory SQLite via better-sqlite3
import Database from 'better-sqlite3';
import { openDatabase, applyNormalisedResults } from './db.js';
import type { NormalisedListing } from './sources/types.js';

// Re-export applyNormalisedResults is enough; db is tested separately.

// Build a minimal in-memory DB for scheduler tests
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Minimal schema needed for the scheduler
  db.exec(`
    CREATE TABLE hunts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      criteria TEXT NOT NULL DEFAULT '{}',
      search_terms TEXT NOT NULL DEFAULT '[]',
      cadence_minutes INTEGER NOT NULL DEFAULT 60,
      monitoring INTEGER NOT NULL DEFAULT 1,
      category_ids TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      vertical TEXT NOT NULL DEFAULT 'computers',
      sources TEXT NOT NULL DEFAULT '["ebay"]',
      poll_interval_minutes INTEGER
    );
    CREATE TABLE offers (
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
      status TEXT NOT NULL DEFAULT 'active',
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_status_change TEXT,
      notified_thresholds TEXT DEFAULT '[]',
      thumbnail_url TEXT,
      vertical TEXT,
      attributes TEXT DEFAULT '{}',
      UNIQUE(source, source_id)
    );
    CREATE TABLE search_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      source TEXT NOT NULL,
      terms TEXT NOT NULL,
      result_count INTEGER DEFAULT 0,
      new_offer_count INTEGER DEFAULT 0,
      relevant_count INTEGER DEFAULT 0,
      searched_at TEXT NOT NULL DEFAULT (datetime('now')),
      consecutive_failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE hunt_offers (
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      offer_id INTEGER NOT NULL REFERENCES offers(id),
      search_query_id INTEGER REFERENCES search_queries(id),
      status TEXT NOT NULL DEFAULT 'new',
      first_associated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (hunt_id, offer_id)
    );
    CREATE TABLE prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER NOT NULL REFERENCES offers(id),
      price REAL NOT NULL,
      shipping REAL,
      currency TEXT NOT NULL DEFAULT 'GBP',
      total_landed_gbp REAL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE market_segments (
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
      confidence TEXT DEFAULT 'LOW',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hunt_id, name)
    );
  `);
  return db;
}

function makeState(): SchedulerState {
  return {
    lastSearchTime: new Map(),
    lastWatchPollTime: 0,
    lastStalenessSweepTime: 0,
    dailyApiCalls: new Map(),
    dailyApiCallsResetAt: Date.now() + 86_400_000,
    consecutiveFailures: new Map(),
    sourcePausedAt: new Map(),
    // Defaults keep drain/flush inert for dispatch tests; triage tests override.
    lastDrainTime: Date.now(),
    lastQueueFlushTime: Date.now(),
  };
}

function makeListing(id: string): NormalisedListing {
  return {
    source: 'ebay',
    sourceId: id,
    title: `Item ${id}`,
    url: `https://ebay.co.uk/itm/${id}`,
    priceGbp: 100,
    currency: 'GBP',
    attributes: {},
  };
}

describe('Scheduler dispatch', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    // Default: every vertical/source pair has a passthrough translator
    mockGetTranslator.mockReturnValue((_hunt: unknown, terms: string) => ({ terms }));
  });

  it('calls eBay adapter once for a hunt with sources: [ebay]', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical)
      VALUES ('Test Hunt', '["rtx 3080"]', 0, '["ebay"]', 'computers')
    `).run();

    const ebaySearchMock = vi.fn().mockResolvedValue({
      listings: [makeListing('v1|001|0')],
      apiCalls: 3,
      errors: [],
    });

    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'ebay',
      search: ebaySearchMock,
      getState: vi.fn(),
      capabilities: { hasAuctions: true, richSearch: true, needsDetailFetch: false },
      minIntervalMs: 0,
    });

    const state = makeState();
    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    expect(ebaySearchMock).toHaveBeenCalledTimes(1);
    expect(ebaySearchMock).toHaveBeenCalledWith({ terms: 'rtx 3080', categoryIds: undefined });

    // Offer should be in DB
    const offer = db.prepare('SELECT * FROM offers WHERE source_id = ?').get('v1|001|0');
    expect(offer).toBeTruthy();
  });

  it('runs eBay even when AutoTrader throws — per-source isolation', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical)
      VALUES ('Cars Hunt', '["audi a4"]', 0, '["ebay","autotrader"]', 'cars')
    `).run();

    const ebaySearchMock = vi.fn().mockResolvedValue({
      listings: [makeListing('v1|audi|0')],
      apiCalls: 3,
      errors: [],
    });
    const atSearchMock = vi.fn().mockRejectedValue(new Error('AT GraphQL 429'));

    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockImplementation((id: string) => {
      if (id === 'ebay') {
        return { id: 'ebay', search: ebaySearchMock, getState: vi.fn(), capabilities: { hasAuctions: true, richSearch: true, needsDetailFetch: false }, minIntervalMs: 0 };
      }
      return { id: 'autotrader', search: atSearchMock, getState: vi.fn(), capabilities: { hasAuctions: false, richSearch: false, needsDetailFetch: true }, minIntervalMs: 6000 };
    });

    const state = makeState();
    const { tick } = await import('./scheduler.js');

    // tick() should NOT throw
    await expect(tick(state, db)).resolves.toBeUndefined();

    expect(ebaySearchMock).toHaveBeenCalledTimes(1);
    expect(atSearchMock).toHaveBeenCalledTimes(1);
  });

  it('increments consecutive_failures on adapter error', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical)
      VALUES ('Fail Hunt', '["broken"]', 0, '["ebay"]', 'computers')
    `).run();

    const failingSearch = vi.fn().mockRejectedValue(new Error('api error'));
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'ebay',
      search: failingSearch,
      getState: vi.fn(),
      capabilities: { hasAuctions: true, richSearch: true, needsDetailFetch: false },
      minIntervalMs: 0,
    });

    const state = makeState();
    const { tick } = await import('./scheduler.js');

    // Run tick 3 times (cadence = 0, clear lastSearchTime to make terms eligible each time)
    await tick(state, db);
    state.lastSearchTime.clear();
    await tick(state, db);
    state.lastSearchTime.clear();
    await tick(state, db);

    // consecutiveFailures tracked in-memory state
    const key = Array.from(state.consecutiveFailures.keys())[0];
    expect(key).toMatch(/broken/);
    expect(state.consecutiveFailures.get(key)).toBe(3);
  });

  it('auto-pauses source after 10 consecutive failures', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical)
      VALUES ('Pause Hunt', '["bomb"]', 0, '["ebay"]', 'computers')
    `).run();
    const huntId = (db.prepare('SELECT id FROM hunts').get() as { id: number }).id;

    const searchMock = vi.fn().mockResolvedValue({ listings: [], apiCalls: 0, errors: [] });
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'ebay',
      search: searchMock,
      getState: vi.fn(),
      capabilities: { hasAuctions: true, richSearch: true, needsDetailFetch: false },
      minIntervalMs: 0,
    });

    // Pre-seed the in-memory failure counter to threshold, freshly paused (as
    // recordSourceFailure would: cool-down clock starts now, so no probe yet).
    const state = makeState();
    state.consecutiveFailures.set(`${huntId}:ebay:bomb`, 10);
    state.sourcePausedAt.set(`${huntId}:ebay:bomb`, Date.now());

    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    // Adapter should NOT have been called (source is paused in state)
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('arms sourcePausedAt once a real failing adapter crosses the failure threshold', async () => {
    // Unlike the pre-seeded auto-pause test above, this drives a genuinely-throwing
    // adapter through tick() until it crosses CONSECUTIVE_FAILURE_PAUSE_THRESHOLD (10)
    // and asserts the cool-down clock was actually armed by recordSourceFailure.
    // It must fail if `state.sourcePausedAt.set(key, Date.now())` (~scheduler.ts:179) is removed.
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical)
      VALUES ('Arm Hunt', '["kaboom"]', 0, '["ebay"]', 'computers')
    `).run();
    const huntId = (db.prepare('SELECT id FROM hunts').get() as { id: number }).id;

    const failingSearch = vi.fn().mockRejectedValue(new Error('persistent network error'));
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'ebay',
      search: failingSearch,
      getState: vi.fn(),
      capabilities: { hasAuctions: true, richSearch: true, needsDetailFetch: false },
      minIntervalMs: 0,
    });

    const state = makeState();
    const key = `${huntId}:ebay:kaboom`;
    const { tick } = await import('./scheduler.js');

    // Run 10 ticks. cadence_minutes=0 means cadence never gates; but Bug 1's fix now
    // advances lastSearchTime on a throw, so clear it between ticks to re-run the search.
    // Cool-down hasn't elapsed between ticks, so once armed the source is skipped — run
    // exactly enough ticks to reach the threshold (10 actual searches → 10 failures).
    for (let i = 0; i < 10; i++) {
      state.lastSearchTime.clear();
      await tick(state, db);
    }

    // Threshold reached → the cool-down clock must have been armed (NOT pre-seeded).
    expect(failingSearch).toHaveBeenCalledTimes(10);
    expect(state.consecutiveFailures.get(key)).toBe(10);
    expect(state.sourcePausedAt.get(key)).toBeGreaterThan(0);
  });

  it('does NOT count a translator/config error toward the auto-pause budget', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical)
      VALUES ('Config Error Hunt', '["broken"]', 0, '["ebay"]', 'computers')
    `).run();
    const huntId = (db.prepare('SELECT id FROM hunts').get() as { id: number }).id;

    // Translator throws deterministically (e.g. missing required criteria field).
    mockGetTranslator.mockReturnValue(() => {
      throw new Error('translateCarsCriteriaToAutotrader: criteria.make is required');
    });

    const searchMock = vi.fn().mockResolvedValue({ listings: [], apiCalls: 0, errors: [] });
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'ebay',
      search: searchMock,
      getState: vi.fn(),
      capabilities: { hasAuctions: true, richSearch: true, needsDetailFetch: false },
      minIntervalMs: 0,
    });

    const state = makeState();
    const { tick } = await import('./scheduler.js');
    // Run several ticks; a config error must never accrue consecutive_failures.
    await tick(state, db);
    state.lastSearchTime.clear();
    await tick(state, db);
    state.lastSearchTime.clear();
    await tick(state, db);

    // The network adapter is never reached, and no failure budget is burned.
    expect(searchMock).not.toHaveBeenCalled();
    expect(state.consecutiveFailures.get(`${huntId}:ebay:broken`) ?? 0).toBe(0);
    // It backs off to cadence (lastSearchTime set) instead of spamming every tick.
    expect(state.lastSearchTime.has(`${huntId}:ebay:broken`)).toBe(true);
  });

  it('auto-pause is recoverable: probes again after the cool-down without a restart', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical)
      VALUES ('Recover Hunt', '["flaky"]', 0, '["ebay"]', 'computers')
    `).run();
    const huntId = (db.prepare('SELECT id FROM hunts').get() as { id: number }).id;

    // Adapter now succeeds — simulating the transient outage having cleared.
    const searchMock = vi.fn().mockResolvedValue({ listings: [], apiCalls: 0, errors: [] });
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'ebay',
      search: searchMock,
      getState: vi.fn(),
      capabilities: { hasAuctions: true, richSearch: true, needsDetailFetch: false },
      minIntervalMs: 0,
    });

    const state = makeState();
    const { tick } = await import('./scheduler.js');
    const key = `${huntId}:ebay:flaky`;

    // Paused, but cool-down has NOT elapsed → still skipped.
    state.consecutiveFailures.set(key, 10);
    state.sourcePausedAt.set(key, Date.now());
    await tick(state, db);
    expect(searchMock).not.toHaveBeenCalled();

    // Cool-down elapsed → one probe is allowed; success clears the pause.
    state.sourcePausedAt.set(key, Date.now() - 61 * 60_000); // > default 60-min cool-down
    state.lastSearchTime.clear();
    await tick(state, db);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(state.consecutiveFailures.get(key)).toBe(0);
    expect(state.sourcePausedAt.has(key)).toBe(false);
  });

  it('enforces per-source budget', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical)
      VALUES ('Budget Hunt', '["expensive"]', 0, '["ebay"]', 'computers')
    `).run();

    mockHasAdapter.mockReturnValue(true);
    const searchMock = vi.fn().mockResolvedValue({ listings: [], apiCalls: 0, errors: [] });
    mockGetAdapter.mockReturnValue({
      id: 'ebay',
      search: searchMock,
      getState: vi.fn(),
      capabilities: { hasAuctions: true, richSearch: true, needsDetailFetch: false },
      minIntervalMs: 0,
    });

    // Set eBay calls at budget limit (100 from mock config)
    const state = makeState();
    state.dailyApiCalls.set('ebay', 101);

    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    expect(searchMock).not.toHaveBeenCalled();
  });

  // Issue 3: fetchDetail wired for needsDetailFetch sources
  it('calls fetchDetail for each new AT listing and merges attributes', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical, criteria)
      VALUES ('Cars Hunt', '["audi a4"]', 0, '["autotrader"]', 'cars', '{"make":"Audi"}')
    `).run();

    const newListings: NormalisedListing[] = [
      { source: 'autotrader', sourceId: 'at-001', title: 'Audi A4 2018', url: 'https://at.co.uk/001', priceGbp: 12000, currency: 'GBP', attributes: {} },
      { source: 'autotrader', sourceId: 'at-002', title: 'Audi A4 2019', url: 'https://at.co.uk/002', priceGbp: 13000, currency: 'GBP', attributes: {} },
      { source: 'autotrader', sourceId: 'at-003', title: 'Audi A4 2020', url: 'https://at.co.uk/003', priceGbp: 14000, currency: 'GBP', attributes: {} },
    ];

    const fetchDetailMock = vi.fn().mockImplementation(async (sourceId: string) => ({
      listing: {
        source: 'autotrader',
        sourceId,
        title: 'Detail',
        url: 'https://at.co.uk/' + sourceId,
        priceGbp: 12000,
        currency: 'GBP',
        attributes: { price_tier: 'great_price', mileage_num: 67000 },
      },
      apiCalls: 1,
    }));

    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'autotrader',
      search: vi.fn().mockResolvedValue({ listings: newListings, apiCalls: 1, errors: [] }),
      fetchDetail: fetchDetailMock,
      getState: vi.fn(),
      capabilities: { hasAuctions: false, richSearch: false, needsDetailFetch: true },
      minIntervalMs: 0,
    });

    const state = makeState();
    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    // fetchDetail should be called once per new listing (3 new)
    expect(fetchDetailMock).toHaveBeenCalledTimes(3);
    expect(fetchDetailMock).toHaveBeenCalledWith('at-001');
    expect(fetchDetailMock).toHaveBeenCalledWith('at-002');
    expect(fetchDetailMock).toHaveBeenCalledWith('at-003');

    // Attributes should be merged into the offers rows
    const offer = db.prepare("SELECT attributes FROM offers WHERE source_id = 'at-001'").get() as { attributes: string } | undefined;
    expect(offer).toBeTruthy();
    const attrs = JSON.parse(offer!.attributes);
    expect(attrs.price_tier).toBe('great_price');
    expect(attrs.mileage_num).toBe(67000);
  });

  it('caps fetchDetail at MAX_DETAIL_FETCHES_PER_TICK (default 10)', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical, criteria)
      VALUES ('Cars Hunt Cap', '["bmw"]', 0, '["autotrader"]', 'cars', '{}')
    `).run();

    // 15 new listings
    const newListings: NormalisedListing[] = Array.from({ length: 15 }, (_, i) => ({
      source: 'autotrader',
      sourceId: `at-cap-${i}`,
      title: `Car ${i}`,
      url: `https://at.co.uk/cap/${i}`,
      priceGbp: 10000,
      currency: 'GBP',
      attributes: {},
    }));

    const fetchDetailMock = vi.fn().mockResolvedValue({
      listing: null,
      apiCalls: 1,
    });

    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'autotrader',
      search: vi.fn().mockResolvedValue({ listings: newListings, apiCalls: 1, errors: [] }),
      fetchDetail: fetchDetailMock,
      getState: vi.fn(),
      capabilities: { hasAuctions: false, richSearch: false, needsDetailFetch: true },
      minIntervalMs: 0,
    });

    const state = makeState();
    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    // Should cap at 10 (default MAX_DETAIL_FETCHES_PER_TICK)
    expect(fetchDetailMock).toHaveBeenCalledTimes(10);
  });

  // Issue 18: cars/autotrader translator produces AT-shaped filters via the translator registry
  it('uses getTranslator for cars/autotrader hunt and passes AT-shaped params to adapter', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical, criteria)
      VALUES ('AT Cars Hunt', '[""]', 0, '["autotrader"]', 'cars', '{"make":"Audi","model":"A4","max_price":15000}')
    `).run();

    const atFilters = [
      { name: 'make', value: 'Audi' },
      { name: 'model', value: 'A4' },
    ];

    // Return AT-shaped params (filters array) from the translator
    mockGetTranslator.mockReturnValue(() => ({ filters: atFilters, channel: 'desktop', pageSize: 25 }));

    const atSearchMock = vi.fn().mockResolvedValue({ listings: [], apiCalls: 1, errors: [] });

    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'autotrader',
      search: atSearchMock,
      getState: vi.fn(),
      capabilities: { hasAuctions: false, richSearch: false, needsDetailFetch: true },
      minIntervalMs: 0,
    });

    const state = makeState();
    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    // Translator should have been looked up for cars/autotrader
    expect(mockGetTranslator).toHaveBeenCalledWith('cars', 'autotrader');
    // AT adapter should be called with AT-shaped filters, not eBay params
    expect(atSearchMock).toHaveBeenCalledTimes(1);
    expect(atSearchMock).toHaveBeenCalledWith({ filters: atFilters, channel: 'desktop', pageSize: 25 });
  });

  // FIX 1: per-vertical poll cadence is enforced (cars default = 360 min).
  it('enforces the per-vertical poll cadence — skips a recently-searched cars hunt', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical)
      VALUES ('Cars Cadence', '["audi a4"]', 60, '["autotrader"]', 'cars')
    `).run();
    const huntId = (db.prepare('SELECT id FROM hunts').get() as { id: number }).id;

    const atSearchMock = vi.fn().mockResolvedValue({ listings: [], apiCalls: 0, errors: [] });
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'autotrader',
      search: atSearchMock,
      getState: vi.fn(),
      capabilities: { hasAuctions: false, richSearch: false, needsDetailFetch: true },
      minIntervalMs: 0,
    });

    const state = makeState();
    // Searched 1 hour ago — below the 360-min cars default, so it must be skipped
    // (would NOT be skipped under the old cadence_minutes=60 behaviour).
    state.lastSearchTime.set(`${huntId}:autotrader:audi a4`, Date.now() - 60 * 60_000);

    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    expect(atSearchMock).not.toHaveBeenCalled();
  });

  // FIX 1: per-hunt poll_interval_minutes overrides the vertical default.
  it('per-hunt poll_interval_minutes overrides the vertical default', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical, poll_interval_minutes)
      VALUES ('Cars Override', '["bmw"]', 60, '["autotrader"]', 'cars', 1)
    `).run();
    const huntId = (db.prepare('SELECT id FROM hunts').get() as { id: number }).id;

    const atSearchMock = vi.fn().mockResolvedValue({ listings: [], apiCalls: 0, errors: [] });
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'autotrader',
      search: atSearchMock,
      getState: vi.fn(),
      capabilities: { hasAuctions: false, richSearch: false, needsDetailFetch: true },
      minIntervalMs: 0,
    });

    const state = makeState();
    // Override = 1 min; searched 5 min ago => eligible (despite cars 360-min default).
    state.lastSearchTime.set(`${huntId}:autotrader:bmw`, Date.now() - 5 * 60_000);

    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    expect(atSearchMock).toHaveBeenCalledTimes(1);
  });

  // FIX 4: eBay token invalidation must not fire for non-eBay sources.
  it('does not invalidate the eBay token when a non-eBay search throws an auth error', async () => {
    const { isAuthError, invalidateToken } = await import('./sources/ebay/auth.js');
    (isAuthError as ReturnType<typeof vi.fn>).mockReturnValue(true);

    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical)
      VALUES ('AT Auth', '["audi"]', 0, '["autotrader"]', 'cars')
    `).run();

    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'autotrader',
      search: vi.fn().mockRejectedValue(new Error('boom')),
      getState: vi.fn(),
      capabilities: { hasAuctions: false, richSearch: false, needsDetailFetch: true },
      minIntervalMs: 0,
    });

    const state = makeState();
    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    expect(invalidateToken).not.toHaveBeenCalled();

    // Restore default so later tests see isAuthError === false (clearAllMocks keeps impls).
    (isAuthError as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('skips source when no translator is registered for the vertical/source pair', async () => {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical, criteria)
      VALUES ('No Translator Hunt', '["foo"]', 0, '["autotrader"]', 'cars', '{}')
    `).run();

    // No translator registered — getTranslator returns undefined
    mockGetTranslator.mockReturnValue(undefined);

    const atSearchMock = vi.fn().mockResolvedValue({ listings: [], apiCalls: 0, errors: [] });
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'autotrader',
      search: atSearchMock,
      getState: vi.fn(),
      capabilities: { hasAuctions: false, richSearch: false, needsDetailFetch: true },
      minIntervalMs: 0,
    });

    const state = makeState();
    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    // Adapter should NOT be called — no translator means skip
    expect(atSearchMock).not.toHaveBeenCalled();
  });
});

describe('Triage queue management (backlog cap / stale flush / drain)', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    mockGetTranslator.mockReturnValue((_hunt: unknown, terms: string) => ({ terms }));
  });

  function seedHunt(): number {
    db.prepare(`
      INSERT INTO hunts (name, search_terms, cadence_minutes, sources, vertical)
      VALUES ('Backlog Hunt', '["thinkcentre"]', 0, '["ebay"]', 'computers')
    `).run();
    return (db.prepare('SELECT id FROM hunts').get() as { id: number }).id;
  }

  /** Insert an offer + hunt_offers association with a given queue age (days). */
  function seedQueuedOffer(huntId: number, sourceId: string, ageDays: number): void {
    db.prepare(`
      INSERT INTO offers (source, source_id, title, url) VALUES ('ebay', ?, 'Item ' || ?, 'https://x/' || ?)
    `).run(sourceId, sourceId, sourceId);
    const offerId = (db.prepare('SELECT id FROM offers WHERE source_id = ?').get(sourceId) as { id: number }).id;
    db.prepare(`
      INSERT INTO hunt_offers (hunt_id, offer_id, status, first_associated_at)
      VALUES (?, ?, 'new', datetime('now', '-' || ? || ' days'))
    `).run(huntId, offerId, ageDays);
  }

  function idleAdapter() {
    const search = vi.fn().mockResolvedValue({ listings: [], apiCalls: 1, errors: [] });
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'ebay',
      search,
      getState: vi.fn(),
      capabilities: { hasAuctions: true, richSearch: true, needsDetailFetch: false },
      minIntervalMs: 0,
    });
    return search;
  }

  it('auto-dismisses queued offers older than STALE_QUEUE_DAYS on first tick, keeps fresh ones', async () => {
    const huntId = seedHunt();
    seedQueuedOffer(huntId, 'old-1', 10);
    seedQueuedOffer(huntId, 'old-2', 8);
    seedQueuedOffer(huntId, 'fresh-1', 2);
    idleAdapter();

    const state = makeState();
    state.lastQueueFlushTime = 0; // startup condition
    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    const statuses = db
      .prepare('SELECT o.source_id as sid, ho.status FROM hunt_offers ho JOIN offers o ON o.id = ho.offer_id')
      .all() as Array<{ sid: string; status: string }>;
    const byId = Object.fromEntries(statuses.map((r) => [r.sid, r.status]));
    expect(byId['old-1']).toBe('dismissed');
    expect(byId['old-2']).toBe('dismissed');
    expect(byId['fresh-1']).toBe('new');
    expect(state.lastQueueFlushTime).toBeGreaterThan(0);
  });

  it('caps announced offers at MAX_TRIAGE_BATCH_PER_RUN with pendingCount for the rest', async () => {
    seedHunt();
    // Adapter returns 50 new listings in one tick
    const listings = Array.from({ length: 50 }, (_, i) => makeListing(`bulk|${i}`));
    const search = vi.fn().mockResolvedValue({ listings, apiCalls: 1, errors: [] });
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue({
      id: 'ebay',
      search,
      getState: vi.fn(),
      capabilities: { hasAuctions: true, richSearch: true, needsDetailFetch: false },
      minIntervalMs: 0,
    });

    const state = makeState();
    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    expect(mockSendNewOffers).toHaveBeenCalledTimes(1);
    const summaries = mockSendNewOffers.mock.calls[0][0];
    expect(summaries).toHaveLength(1);
    expect(summaries[0].newCount).toBe(40);
    expect(summaries[0].pendingCount).toBe(50);
    expect(summaries[0].newListings).toHaveLength(40);
  });

  it('drains the remaining backlog on a later tick when no fresh offers arrive', async () => {
    const huntId = seedHunt();
    // 10 queued offers left over from an earlier capped batch (fresh enough to keep)
    for (let i = 0; i < 10; i++) seedQueuedOffer(huntId, `left|${i}`, 1);
    idleAdapter(); // no new listings this tick

    const state = makeState();
    state.lastDrainTime = 0; // drain cadence elapsed
    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    expect(mockSendNewOffers).toHaveBeenCalledTimes(1);
    const summaries = mockSendNewOffers.mock.calls[0][0];
    expect(summaries).toHaveLength(1);
    expect(summaries[0].newCount).toBe(10);
    expect(summaries[0].pendingCount).toBe(10);
    expect(state.lastDrainTime).toBeGreaterThan(0);
  });

  it('does not drain before the drain cadence elapses', async () => {
    const huntId = seedHunt();
    seedQueuedOffer(huntId, 'wait|1', 1);
    idleAdapter();

    const state = makeState(); // lastDrainTime = now → cadence not elapsed
    const { tick } = await import('./scheduler.js');
    await tick(state, db);

    expect(mockSendNewOffers).not.toHaveBeenCalled();
  });
});
