/**
 * Database access layer for the watcher.
 * Owns the deal-hunter.db schema — creates tables if they don't exist.
 * The container MCP server connects to the same DB but does not create tables.
 */

import Database from 'better-sqlite3';
import { logger } from './logger.js';
import type { NormalisedListing } from './sources/types.js';
import { getVerticals, type VerticalConfig } from './verticals.js';

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
  vertical: string;
  sources: string[];
  poll_interval_minutes: number | null;
  gate_version?: number | null;
}

/** Parse hunt sources from a raw DB row (sources stored as JSON string). */
export function parseSourcesFromRow(row: { sources?: string | null }): string[] {
  try {
    const parsed = JSON.parse(row.sources ?? '["ebay"]');
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // fall through
  }
  return ['ebay'];
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
  thumbnail_url: string | null;
  vertical: string | null;
  attributes: string;  // JSON string; use parseAttributes() to decode
}

/** Parse attributes JSON from an offer row, with empty-object fallback. */
export function parseAttributes(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
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
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft', 'active', 'paused', 'closed')),
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
      evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- Per-offer requirement verdicts: JSON array of {requirement, verdict, evidence, tier}.
      -- verdict uses the same enum as claim_verifications ('verified'|'unverified'|'contradicted');
      -- requirement is a verbatim criteria.intent.must_have / nice_to_have string; tier is 'must'|'nice'.
      -- NULL = no checks recorded. Declared last so fresh DBs match ALTER TABLE column order.
      requirement_checks TEXT
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- declared last so fresh DBs match the column order ALTER TABLE produces on migrated DBs
      attributes TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS hunt_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      trigger TEXT NOT NULL,
      summary TEXT NOT NULL,
      offers_evaluated INTEGER NOT NULL DEFAULT 0,
      offers_alerted INTEGER NOT NULL DEFAULT 0,
      offers_watched INTEGER NOT NULL DEFAULT 0,
      offers_skipped INTEGER NOT NULL DEFAULT 0,
      logged_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-container-result model spend, written by the agent-runner (container side) from the
    -- SDK result message. Token and cost values are deltas since the previous result in the same
    -- container process. prompt_head is the first 200 chars of the prompt that produced the turn,
    -- enough to classify the run (price-change / watch-condition / new-offers / chat).
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      prompt_head TEXT,
      models TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      num_turns INTEGER,
      logged_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Jev (TypeSafe) must-have verdicts computed by the watcher at detail-enrichment time
    -- (handoff #2). Keyed per hunt because must-haves are per hunt. requirement is the verbatim
    -- criteria.intent.must_have string; verdict enum matches evaluations.requirement_checks.
    -- probabilities = JSON [{label, p}] of the top candidate evidence lines, for the dashboard.
    CREATE TABLE IF NOT EXISTS offer_requirement_checks (
      offer_id INTEGER NOT NULL REFERENCES offers(id),
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      requirement TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('verified', 'unverified', 'contradicted')),
      evidence TEXT,
      confidence REAL NOT NULL,
      probabilities TEXT NOT NULL DEFAULT '[]',
      model TEXT NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (offer_id, hunt_id, requirement)
    );

    -- Resolved vertical capabilities, mirrored from config/verticals.yml at watcher startup.
    -- The container agent (deal-hunter-mcp) reads this table because verticals.yml is not
    -- mounted in-container, but the DB always is. Single source of truth stays verticals.yml.
    CREATE TABLE IF NOT EXISTS verticals (
      name TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Provenance gating (gate_version >= 2). Per-target spec knowledge-base coverage, recorded by
    -- the car-spec-research skill so the DB-only activation gate can verify a cited KB exists for a
    -- feature-led hunt before it activates. must_have_citations is a JSON map { feature: count }.
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      vertical TEXT NOT NULL,
      target_key TEXT NOT NULL,
      kb_path TEXT NOT NULL,
      citation_count INTEGER NOT NULL DEFAULT 0,
      must_have_citations TEXT NOT NULL DEFAULT '{}',
      built_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hunt_id, target_key)
    );

    -- Provenance gating (gate_version >= 2). Adversarial verification of each must-have feature per
    -- target, recorded by the musthave-verification sub-agent. A 'verified' verdict (including
    -- user-waived ones, tagged in notes) satisfies the D gate check; missing/unverified/contradicted
    -- blocks activation.
    CREATE TABLE IF NOT EXISTS claim_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hunt_id INTEGER NOT NULL REFERENCES hunts(id),
      target_key TEXT NOT NULL,
      feature TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('verified', 'unverified', 'contradicted')),
      evidence_url TEXT,
      notes TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hunt_id, target_key, feature)
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
    CREATE INDEX IF NOT EXISTS idx_hunt_log_hunt ON hunt_log(hunt_id, logged_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_base_hunt ON knowledge_base(hunt_id);
    CREATE INDEX IF NOT EXISTS idx_claim_verifications_hunt ON claim_verifications(hunt_id);
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
  // Provenance gating: gate_version. Intentionally NO default — existing rows stay NULL and are
  // treated as legacy (v1) by the activation gate, which grandfathers them past the B/C/D checks.
  // Only hunts created by manage_hunt action:create get gate_version = 2 (the strict regime).
  if (!huntCols.some((c) => c.name === 'gate_version')) {
    db.exec('ALTER TABLE hunts ADD COLUMN gate_version INTEGER');
  }

  const offerCols = db.prepare("PRAGMA table_info('offers')").all() as Array<{ name: string }>;
  if (!offerCols.some((c) => c.name === 'last_status_change')) {
    db.exec('ALTER TABLE offers ADD COLUMN last_status_change TEXT');
  }
  if (!offerCols.some((c) => c.name === 'notified_thresholds')) {
    db.exec("ALTER TABLE offers ADD COLUMN notified_thresholds TEXT DEFAULT '[]'");
  }
  if (!offerCols.some((c) => c.name === 'thumbnail_url')) {
    db.exec('ALTER TABLE offers ADD COLUMN thumbnail_url TEXT');
  }
  if (!offerCols.some((c) => c.name === 'vertical')) {
    db.exec('ALTER TABLE offers ADD COLUMN vertical TEXT');
  }
  if (!offerCols.some((c) => c.name === 'attributes')) {
    db.exec("ALTER TABLE offers ADD COLUMN attributes TEXT DEFAULT '{}'");
  }

  // baseline_prices: structured comp attributes (e.g. cars mileage_num/year) so research comps
  // can feed the depreciation-trend fit, not just live offers.
  const baselineCols = db.prepare("PRAGMA table_info('baseline_prices')").all() as Array<{ name: string }>;
  if (!baselineCols.some((c) => c.name === 'attributes')) {
    db.exec("ALTER TABLE baseline_prices ADD COLUMN attributes TEXT NOT NULL DEFAULT '{}'");
  }

  // hunts table: vertical, sources, poll_interval_minutes
  if (!huntCols.some((c) => c.name === 'vertical')) {
    db.exec("ALTER TABLE hunts ADD COLUMN vertical TEXT NOT NULL DEFAULT 'computers'");
  }
  if (!huntCols.some((c) => c.name === 'sources')) {
    db.exec('ALTER TABLE hunts ADD COLUMN sources TEXT NOT NULL DEFAULT \'["ebay"]\'');
  }
  if (!huntCols.some((c) => c.name === 'poll_interval_minutes')) {
    db.exec('ALTER TABLE hunts ADD COLUMN poll_interval_minutes INTEGER');
  }

  // hunts.status: widen the CHECK constraint to allow the 'draft' lifecycle state.
  // SQLite can't ALTER a CHECK constraint, so rebuild the table once (idempotent: only runs
  // if the live CREATE statement doesn't already permit 'draft'). All hunts columns are
  // guaranteed present here because the ADD COLUMN migrations above have already run.
  const huntsTableSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hunts'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  if (huntsTableSql && !huntsTableSql.includes("'draft'")) {
    // PRAGMA foreign_keys can't be toggled inside a transaction; do it around the rebuild so
    // child tables (market_segments, baseline_prices, hunt_log, …) keep referencing hunts(id).
    db.pragma('foreign_keys = OFF');
    try {
      const rebuildHunts = db.transaction(() => {
        db.exec(`
          CREATE TABLE hunts_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft', 'active', 'paused', 'closed')),
            criteria TEXT NOT NULL DEFAULT '{}',
            search_terms TEXT NOT NULL DEFAULT '[]',
            cadence_minutes INTEGER NOT NULL DEFAULT 60,
            monitoring INTEGER NOT NULL DEFAULT 1,
            category_ids TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            closed_at TEXT,
            close_reason TEXT,
            last_reviewed_at TEXT,
            vertical TEXT NOT NULL DEFAULT 'computers',
            sources TEXT NOT NULL DEFAULT '["ebay"]',
            poll_interval_minutes INTEGER,
            gate_version INTEGER
          );
          INSERT INTO hunts_new (
            id, name, status, criteria, search_terms, cadence_minutes, monitoring, category_ids,
            created_at, closed_at, close_reason, last_reviewed_at, vertical, sources, poll_interval_minutes,
            gate_version
          )
          SELECT
            id, name, status, criteria, search_terms, cadence_minutes, monitoring, category_ids,
            created_at, closed_at, close_reason, last_reviewed_at, vertical, sources, poll_interval_minutes,
            gate_version
          FROM hunts;
          DROP TABLE hunts;
          ALTER TABLE hunts_new RENAME TO hunts;
        `);
      });
      rebuildHunts();
      logger.info('Migrated hunts.status CHECK constraint to include draft state');
    } finally {
      // Always restore FK enforcement, even if the rebuild throws — otherwise a failed
      // migration would leave foreign_keys OFF on this connection for its whole lifetime.
      db.pragma('foreign_keys = ON');
    }
  }

  // search_queries table: consecutive_failures per (hunt_id, source)
  const sqCols = db.prepare("PRAGMA table_info('search_queries')").all() as Array<{ name: string }>;
  if (!sqCols.some((c) => c.name === 'consecutive_failures')) {
    db.exec('ALTER TABLE search_queries ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0');
  }

  // evaluations table: per-offer requirement verdicts (see CREATE TABLE comment for shape)
  const evalCols = db.prepare("PRAGMA table_info('evaluations')").all() as Array<{ name: string }>;
  if (!evalCols.some((c) => c.name === 'requirement_checks')) {
    db.exec('ALTER TABLE evaluations ADD COLUMN requirement_checks TEXT');
  }

  // One-time migration: backfill legacy eBay offers that were inserted before vertical column existed.
  // Idempotent — rows that already have a vertical are untouched.
  db.exec("UPDATE offers SET vertical = 'computers' WHERE vertical IS NULL AND source = 'ebay'");
}

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Count rows that need migration before ensureSchema sets defaults
  const preCount = (() => {
    try {
      const huntCols = db.prepare("PRAGMA table_info('hunts')").all() as Array<{ name: string }>;
      if (!huntCols.some((c) => c.name === 'vertical')) {
        const row = db.prepare('SELECT COUNT(*) as n FROM hunts').get() as { n: number };
        return row.n;
      }
    } catch {
      // table may not exist yet
    }
    return 0;
  })();

  ensureSchema(db);

  if (preCount > 0) {
    logger.info(
      { count: preCount },
      "Migrated legacy hunts to vertical='computers', sources=[\"ebay\"]",
    );
  }

  syncVerticals(db);

  logger.info({ dbPath }, 'Database ready');
  return db;
}

/**
 * Mirror resolved vertical capabilities from config/verticals.yml into the `verticals` table
 * so the container agent (which can't read verticals.yml) can resolve them via the DB MCP.
 * Idempotent: replaces all rows each startup and prunes verticals removed from the config.
 * Defensive: a missing/invalid verticals.yml logs a warning and leaves the table untouched.
 */
export function syncVerticals(db: Database.Database): void {
  let verticals: Map<string, VerticalConfig>;
  try {
    verticals = getVerticals();
  } catch (err) {
    logger.warn({ err }, 'Could not load verticals.yml — leaving verticals table unchanged');
    return;
  }

  const upsert = db.prepare(
    `INSERT INTO verticals (name, config_json, synced_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET config_json = excluded.config_json, synced_at = excluded.synced_at`,
  );
  const names = [...verticals.keys()];
  const sync = db.transaction(() => {
    for (const [name, cfg] of verticals) {
      upsert.run(name, JSON.stringify(cfg));
    }
    // Prune verticals that no longer exist in the config.
    const placeholders = names.map(() => '?').join(',');
    if (names.length > 0) {
      db.prepare(`DELETE FROM verticals WHERE name NOT IN (${placeholders})`).run(...names);
    } else {
      db.prepare('DELETE FROM verticals').run();
    }
  });
  sync();
  logger.info({ count: names.length, verticals: names }, 'Synced vertical capabilities to DB');
}

// --- Read operations ---

export function getActiveHunts(db: Database.Database): Hunt[] {
  const rows = db.prepare("SELECT * FROM hunts WHERE status = 'active' AND monitoring = 1").all() as Array<Omit<Hunt, 'sources'> & { sources: string }>;
  return rows.map((row) => ({
    ...row,
    sources: parseSourcesFromRow(row),
    poll_interval_minutes: row.poll_interval_minutes ?? null,
  }));
}

export function getSegmentCount(db: Database.Database, huntId: number): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM market_segments WHERE hunt_id = ?').get(huntId) as { count: number };
  return row.count;
}

export function getWatchedOffers(db: Database.Database): Offer[] {
  return db.prepare("SELECT * FROM offers WHERE watching = 1 AND status = 'active'").all() as Offer[];
}

/** Count queued-for-triage offers (hunt_offers.status='new') for a hunt. */
export function countNewHuntOffers(db: Database.Database, huntId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM hunt_offers WHERE hunt_id = ? AND status = 'new'")
    .get(huntId) as { count: number };
  return row.count;
}

/**
 * Pending triage queues per ACTIVE monitored hunt, ordered by oldest queued offer first.
 * Announcement budget is allocated in this order so a noisy hunt can't starve a quiet
 * hunt's ageing backlog into the stale flush.
 */
export function getHuntsWithPendingNew(
  db: Database.Database,
): Array<{ hunt_id: number; pending: number; oldest_queued_at: string }> {
  return db
    .prepare(
      `SELECT ho.hunt_id, COUNT(*) as pending, MIN(ho.first_associated_at) as oldest_queued_at
       FROM hunt_offers ho
       JOIN hunts h ON h.id = ho.hunt_id
       WHERE ho.status = 'new' AND h.status = 'active' AND h.monitoring = 1
       GROUP BY ho.hunt_id
       ORDER BY oldest_queued_at ASC`,
    )
    .all() as Array<{ hunt_id: number; pending: number; oldest_queued_at: string }>;
}

/**
 * Auto-dismiss queued (status='new') offers of ACTIVE monitored hunts older than `days`.
 * Token-burn protection: after a long watcher outage the triage backlog is mostly
 * dead listings; dismissing them prevents a single agent run from being asked to
 * evaluate weeks of history. Paused/draft/closed hunts are excluded — their queues are
 * frozen while dormant (dismissal is irreversible: hunt_offers is INSERT OR IGNORE, so
 * a dismissed row never returns to 'new'), and flushed on the first tick after resume.
 * Returns the number of rows dismissed.
 */
export function dismissStaleHuntOffers(db: Database.Database, days: number): number {
  const result = db
    .prepare(
      `UPDATE hunt_offers SET status = 'dismissed'
       WHERE status = 'new'
         AND datetime(first_associated_at) < datetime('now', '-' || ? || ' days')
         AND hunt_id IN (SELECT id FROM hunts WHERE status = 'active' AND monitoring = 1)`,
    )
    .run(days);
  return result.changes;
}

export function getStaleOffers(db: Database.Database, staleHours: number): Offer[] {
  return db
    .prepare(
      `SELECT * FROM offers
       WHERE status = 'active' AND watching = 0
         AND datetime(last_seen_at) < datetime('now', '-' || ? || ' hours')
       ORDER BY last_seen_at ASC`,
    )
    .all(staleHours) as Offer[];
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

/**
 * Price the agent last judged: the latest observation at or before the offer's most recent
 * evaluation. Undefined when the offer has never been evaluated.
 */
export function getPriceAtLastEvaluation(db: Database.Database, offerId: number): number | undefined {
  const row = db
    .prepare(
      `SELECT p.price FROM prices p
       WHERE p.offer_id = ?
         AND p.observed_at <= (SELECT MAX(evaluated_at) FROM evaluations WHERE offer_id = ?)
       ORDER BY p.observed_at DESC, p.id DESC LIMIT 1`,
    )
    .get(offerId, offerId) as { price: number } | undefined;
  return row?.price;
}

export interface OfferRequirementCheckRow {
  requirement: string;
  verdict: 'verified' | 'unverified' | 'contradicted';
  evidence: string | null;
  confidence: number;
  probabilities: Array<{ label: string; p: number }>;
}

export function upsertOfferRequirementChecks(
  db: Database.Database,
  offerId: number,
  huntId: number,
  model: string,
  checks: OfferRequirementCheckRow[],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO offer_requirement_checks
      (offer_id, hunt_id, requirement, verdict, evidence, confidence, probabilities, model, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const run = db.transaction(() => {
    for (const c of checks) {
      stmt.run(offerId, huntId, c.requirement, c.verdict, c.evidence, c.confidence, JSON.stringify(c.probabilities), model);
    }
  });
  run();
}

export function getLastSearchTime(
  db: Database.Database,
  huntId: number,
  source: string,
  terms: string,
): string | undefined {
  // search_queries records the source per row, so we scope by (hunt_id, source, terms)
  // to match the scheduler's per-(hunt:source:terms) cadence keying. Without the source
  // filter, a never-searched source would inherit another source's recent searched_at and
  // be wrongly skipped on restart.
  const row = db
    .prepare('SELECT MAX(searched_at) as last FROM search_queries WHERE hunt_id = ? AND source = ? AND terms = ?')
    .get(huntId, source, terms) as { last: string | null } | undefined;
  return row?.last ?? undefined;
}

export function getHuntIdsForOffer(db: Database.Database, offerId: number): number[] {
  const rows = db
    .prepare('SELECT hunt_id FROM hunt_offers WHERE offer_id = ?')
    .all(offerId) as Array<{ hunt_id: number }>;
  return rows.map((r) => r.hunt_id);
}

export function getHunt(db: Database.Database, huntId: number): Hunt | undefined {
  const row = db.prepare('SELECT * FROM hunts WHERE id = ?').get(huntId) as (Omit<Hunt, 'sources'> & { sources: string }) | undefined;
  if (!row) return undefined;
  return { ...row, sources: parseSourcesFromRow(row), poll_interval_minutes: row.poll_interval_minutes ?? null };
}

// --- Write operations ---

/**
 * Upsert a NormalisedListing into the offers table.
 * Used by all source adapters (eBay, AutoTrader, future sources).
 * Returns the offer row id and whether the row was newly inserted.
 */
export function upsertNormalisedListing(
  db: Database.Database,
  listing: NormalisedListing,
  vertical: string,
): UpsertResult {
  const existing = db.prepare('SELECT id FROM offers WHERE source = ? AND source_id = ?').get(
    listing.source, listing.sourceId,
  ) as { id: number } | undefined;

  // Fold the top-level sellerType into the attributes JSON under `seller_type` so it
  // survives a DB round-trip (there is no dedicated seller_type column). The uppercase
  // value ('TRADE'/'PRIVATE') is preserved. Only set when present, so an enrichment-supplied
  // attributes.seller_type isn't clobbered by a null top-level value.
  const attributesObj: Record<string, unknown> = { ...(listing.attributes ?? {}) };
  if (listing.sellerType != null) {
    attributesObj['seller_type'] = listing.sellerType;
  }
  const attributesJson = JSON.stringify(attributesObj);

  if (existing) {
    const sets: string[] = ["last_seen_at = datetime('now')"];
    const params: unknown[] = [];

    sets.push('title = ?'); params.push(listing.title);
    sets.push('url = ?'); params.push(listing.url || null);
    sets.push('vertical = ?'); params.push(vertical);
    sets.push('attributes = ?'); params.push(attributesJson);
    if (listing.thumbnailUrl != null) { sets.push('thumbnail_url = ?'); params.push(listing.thumbnailUrl); }
    if (listing.condition != null) { sets.push('condition = ?'); params.push(listing.condition); }
    if (listing.buyingFormat != null) { sets.push('buying_format = ?'); params.push(listing.buyingFormat); }
    if (listing.auctionEndTime != null) { sets.push('auction_end_time = ?'); params.push(listing.auctionEndTime); }
    if (listing.bidCount != null) { sets.push('bid_count = ?'); params.push(listing.bidCount); }

    params.push(existing.id);
    db.prepare(`UPDATE offers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return { offerId: existing.id, isNew: false };
  }

  const result = db
    .prepare(
      `INSERT INTO offers
         (source, source_id, title, url, vertical, attributes,
          condition, buying_format, auction_end_time, bid_count, thumbnail_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      listing.source,
      listing.sourceId,
      listing.title,
      listing.url || null,
      vertical,
      attributesJson,
      listing.condition ?? null,
      listing.buyingFormat ?? null,
      listing.auctionEndTime ?? null,
      listing.bidCount ?? null,
      listing.thumbnailUrl ?? null,
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

/**
 * Length of the run of consecutive zero-result searches ending at the most
 * recent run for (hunt, source, terms). Inspects at most `limit` recent rows.
 * Used to surface silently-dead searches: some sources (AutoTrader) return
 * 0 results — not an error — for an invalid filter value such as a model
 * name that doesn't exactly match their catalogue ("2" vs "Polestar 2").
 */
export function getZeroResultStreak(
  db: Database.Database,
  huntId: number,
  source: string,
  terms: string,
  limit = 10,
): number {
  const rows = db
    .prepare(
      'SELECT result_count FROM search_queries WHERE hunt_id = ? AND source = ? AND terms = ? ORDER BY id DESC LIMIT ?',
    )
    .all(huntId, source, terms, limit) as Array<{ result_count: number }>;
  let streak = 0;
  for (const row of rows) {
    if (row.result_count !== 0) break;
    streak++;
  }
  return streak;
}

/** Append a watcher-generated warning to a hunt's activity log (hunt_log). */
export function logHuntWarning(db: Database.Database, huntId: number, summary: string): void {
  db.prepare(
    "INSERT INTO hunt_log (hunt_id, trigger, summary) VALUES (?, 'watcher_warning', ?)",
  ).run(huntId, summary);
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
  // A gone listing can't be watched — clearing it keeps dead offers out of every watched list.
  db.prepare(
    "UPDATE offers SET status = ?, last_status_change = datetime('now'), watching = CASE WHEN ? = 'active' THEN watching ELSE 0 END WHERE id = ?",
  ).run(status, status, offerId);
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

/**
 * Merge-update the attributes JSON for an offer identified by (source, source_id).
 * Incoming fields are merged on top of the existing attributes — existing fields
 * not in the update are preserved. Used by the scheduler's fetchDetail enrichment.
 */
export function mergeOfferAttributes(
  db: Database.Database,
  source: string,
  sourceId: string,
  attrs: Record<string, unknown>,
): void {
  const row = db.prepare('SELECT id, attributes FROM offers WHERE source = ? AND source_id = ?').get(source, sourceId) as
    | { id: number; attributes: string }
    | undefined;
  if (!row) return;

  const existing = parseAttributes(row.attributes);
  const merged = { ...existing, ...attrs };
  db.prepare("UPDATE offers SET attributes = ?, last_seen_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(merged),
    row.id,
  );
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

/**
 * Run a full search result write as a transaction.
 * Upserts NormalisedListings, records prices, associates with hunt.
 * Used by all sources (eBay, AutoTrader, etc.).
 */
export function applyNormalisedResults(
  db: Database.Database,
  huntId: number,
  source: string,
  vertical: string,
  terms: string,
  listings: NormalisedListing[],
): { newCount: number; totalCount: number; searchQueryId: number; newSourceIds: string[] } {
  let newCount = 0;
  const newSourceIds: string[] = [];

  const run = db.transaction(() => {
    const searchQueryId = recordSearch(db, huntId, source, terms, listings.length, 0);

    for (const listing of listings) {
      const { offerId, isNew } = upsertNormalisedListing(db, listing, vertical);
      if (isNew) {
        newCount++;
        newSourceIds.push(listing.sourceId);
      }

      if (listing.priceGbp != null) {
        recordPrice(db, offerId, listing.priceGbp, null, listing.currency ?? 'GBP');
      }

      associateOfferWithHunt(db, huntId, offerId, searchQueryId);
    }

    db.prepare('UPDATE search_queries SET new_offer_count = ? WHERE id = ?').run(newCount, searchQueryId);

    return searchQueryId;
  });

  const searchQueryId = run();
  return { newCount, totalCount: listings.length, searchQueryId, newSourceIds };
}
