/**
 * Deal Hunter DB Tool Server (MCP)
 *
 * SQLite-backed MCP server for structured deal-hunting operations.
 * Provides the agent with hunt management, offer tracking, price history,
 * evaluations, and alert operations.
 *
 * DB file persists in the group folder at /workspace/group/deal-hunter.db
 * (also accessible by the host for the future watcher service).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';

// --- DB Initialization ---

const DB_PATH =
  process.env.DEAL_HUNTER_DB_PATH || '/workspace/group/deal-hunter.db';
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS hunts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'closed')),
    criteria TEXT NOT NULL DEFAULT '{}',
    search_terms TEXT NOT NULL DEFAULT '[]',
    cadence_minutes INTEGER NOT NULL DEFAULT 60,
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

  CREATE INDEX IF NOT EXISTS idx_offers_source ON offers(source, source_id);
  CREATE INDEX IF NOT EXISTS idx_offers_watching ON offers(watching) WHERE watching = 1;
  CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
  CREATE INDEX IF NOT EXISTS idx_hunt_offers_status ON hunt_offers(hunt_id, status);
  CREATE INDEX IF NOT EXISTS idx_prices_offer ON prices(offer_id, observed_at);
  CREATE INDEX IF NOT EXISTS idx_evaluations_hunt ON evaluations(hunt_id);
  CREATE INDEX IF NOT EXISTS idx_evaluations_offer ON evaluations(offer_id);
  CREATE INDEX IF NOT EXISTS idx_alerts_hunt ON alerts(hunt_id, alerted_at);
  CREATE INDEX IF NOT EXISTS idx_search_queries_hunt ON search_queries(hunt_id, searched_at);
`);

// --- Helpers ---

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

// --- MCP Server ---

const server = new McpServer({
  name: 'deal-hunter-db',
  version: '1.0.0',
});

// ============================================================
// Tool 1: manage_hunt
// ============================================================
server.tool(
  'manage_hunt',
  'Create, update, pause, resume, or close a hunt. Close cascades: dismisses hunt_offers and clears watches on associated offers.',
  {
    action: z.enum(['create', 'update', 'pause', 'resume', 'close']),
    hunt_id: z.number().optional().describe('Required for update/pause/resume/close'),
    name: z.string().optional().describe('Hunt name (required for create)'),
    criteria: z.string().optional().describe('JSON string of criteria object'),
    search_terms: z.string().optional().describe('JSON string of search terms array'),
    cadence_minutes: z.number().optional(),
    close_reason: z.string().optional().describe('Reason for closing (bought, changed_mind, etc.)'),
  },
  async ({ action, hunt_id, name, criteria, search_terms, cadence_minutes, close_reason }) => {
    if (action === 'create') {
      if (!name) return errorResult('name is required for create');
      const result = db.prepare(`
        INSERT INTO hunts (name, criteria, search_terms, cadence_minutes)
        VALUES (?, ?, ?, ?)
      `).run(
        name,
        criteria || '{}',
        search_terms || '[]',
        cadence_minutes || 60,
      );
      const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(result.lastInsertRowid);
      return jsonResult({ action: 'created', hunt });
    }

    if (!hunt_id) return errorResult('hunt_id is required for ' + action);
    const existing = db.prepare('SELECT * FROM hunts WHERE id = ?').get(hunt_id);
    if (!existing) return errorResult('Hunt not found: ' + hunt_id);

    if (action === 'update') {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined) { sets.push('name = ?'); params.push(name); }
      if (criteria !== undefined) { sets.push('criteria = ?'); params.push(criteria); }
      if (search_terms !== undefined) { sets.push('search_terms = ?'); params.push(search_terms); }
      if (cadence_minutes !== undefined) { sets.push('cadence_minutes = ?'); params.push(cadence_minutes); }
      if (sets.length === 0) return errorResult('Nothing to update');
      params.push(hunt_id);
      db.prepare(`UPDATE hunts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    } else if (action === 'pause') {
      db.prepare("UPDATE hunts SET status = 'paused' WHERE id = ?").run(hunt_id);
    } else if (action === 'resume') {
      db.prepare("UPDATE hunts SET status = 'active' WHERE id = ?").run(hunt_id);
    } else if (action === 'close') {
      const closeHunt = db.transaction(() => {
        db.prepare(
          "UPDATE hunts SET status = 'closed', closed_at = datetime('now'), close_reason = ? WHERE id = ?",
        ).run(close_reason || null, hunt_id);
        // Dismiss all non-dismissed hunt_offers
        db.prepare(
          "UPDATE hunt_offers SET status = 'dismissed' WHERE hunt_id = ? AND status != 'dismissed'",
        ).run(hunt_id);
        // Clear watches on offers that were watched for this hunt
        db.prepare(`
          UPDATE offers SET watching = 0, watch_conditions = NULL
          WHERE id IN (
            SELECT offer_id FROM hunt_offers WHERE hunt_id = ?
          ) AND watching = 1
        `).run(hunt_id);
      });
      closeHunt();
    }

    const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(hunt_id);
    return jsonResult({ action, hunt });
  },
);

// ============================================================
// Tool 2: get_hunt
// ============================================================
server.tool(
  'get_hunt',
  'Get a single hunt with detail, or list all active hunts with summary counts. Omit hunt_id to list all active hunts.',
  {
    hunt_id: z.number().optional(),
    include_closed: z.boolean().optional().describe('Include closed hunts in list mode'),
  },
  async ({ hunt_id, include_closed }) => {
    if (hunt_id) {
      const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(hunt_id);
      if (!hunt) return errorResult('Hunt not found: ' + hunt_id);
      const counts = db.prepare(`
        SELECT status, COUNT(*) as count FROM hunt_offers WHERE hunt_id = ? GROUP BY status
      `).all(hunt_id);
      const lastSearch = db.prepare(`
        SELECT * FROM search_queries WHERE hunt_id = ? ORDER BY searched_at DESC LIMIT 1
      `).get(hunt_id);
      return jsonResult({ hunt, offer_counts: counts, last_search: lastSearch });
    }

    const whereClause = include_closed ? '' : "WHERE status != 'closed'";
    const hunts = db.prepare(`SELECT * FROM hunts ${whereClause} ORDER BY created_at DESC`).all();
    const result = hunts.map((h: any) => {
      const counts = db.prepare(
        'SELECT status, COUNT(*) as count FROM hunt_offers WHERE hunt_id = ? GROUP BY status',
      ).all(h.id);
      return { ...h, offer_counts: counts };
    });
    return jsonResult({ hunts: result });
  },
);

// ============================================================
// Tool 3: get_hunt_summary
// ============================================================
server.tool(
  'get_hunt_summary',
  'Comprehensive session startup summary for a hunt: active watches, new unevaluated offers, recent price changes, search stats, and recent feedback.',
  {
    hunt_id: z.number(),
  },
  async ({ hunt_id }) => {
    const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(hunt_id);
    if (!hunt) return errorResult('Hunt not found: ' + hunt_id);

    const newOffers = db.prepare(`
      SELECT COUNT(*) as count FROM hunt_offers WHERE hunt_id = ? AND status = 'new'
    `).get(hunt_id) as any;

    const watchedOffers = db.prepare(`
      SELECT o.*, ho.status as hunt_offer_status,
        (SELECT p.total_landed_gbp FROM prices p WHERE p.offer_id = o.id ORDER BY p.observed_at DESC LIMIT 1) as latest_price_gbp
      FROM offers o
      JOIN hunt_offers ho ON ho.offer_id = o.id
      WHERE ho.hunt_id = ? AND o.watching = 1
    `).all(hunt_id);

    const recentPriceChanges = db.prepare(`
      SELECT o.id, o.title, o.source, o.source_id,
        p1.total_landed_gbp as current_price,
        p2.total_landed_gbp as previous_price,
        p1.observed_at as current_observed,
        p2.observed_at as previous_observed
      FROM offers o
      JOIN hunt_offers ho ON ho.offer_id = o.id
      JOIN prices p1 ON p1.offer_id = o.id
      LEFT JOIN prices p2 ON p2.offer_id = o.id AND p2.observed_at < p1.observed_at
      WHERE ho.hunt_id = ?
        AND p1.observed_at = (SELECT MAX(observed_at) FROM prices WHERE offer_id = o.id)
        AND p2.observed_at = (SELECT MAX(observed_at) FROM prices WHERE offer_id = o.id AND observed_at < p1.observed_at)
        AND p1.total_landed_gbp != p2.total_landed_gbp
        AND p1.observed_at > datetime('now', '-7 days')
      ORDER BY p1.observed_at DESC
      LIMIT 20
    `).all(hunt_id);

    const recentSearches = db.prepare(`
      SELECT * FROM search_queries WHERE hunt_id = ? ORDER BY searched_at DESC LIMIT 5
    `).all(hunt_id);

    const recentFeedback = db.prepare(`
      SELECT a.*, o.title as offer_title
      FROM alerts a
      JOIN offers o ON o.id = a.offer_id
      WHERE a.hunt_id = ? AND a.user_response IS NOT NULL
      ORDER BY a.responded_at DESC LIMIT 5
    `).all(hunt_id);

    const offerCounts = db.prepare(`
      SELECT status, COUNT(*) as count FROM hunt_offers WHERE hunt_id = ? GROUP BY status
    `).all(hunt_id);

    return jsonResult({
      hunt,
      new_offer_count: (newOffers as any).count,
      watched_offers: watchedOffers,
      recent_price_changes: recentPriceChanges,
      recent_searches: recentSearches,
      recent_feedback: recentFeedback,
      offer_counts: offerCounts,
    });
  },
);

// ============================================================
// Tool 4: get_market_overview
// ============================================================
server.tool(
  'get_market_overview',
  'Price aggregates and trends for offers associated with a hunt or filtered by source/condition. Returns median, min, max, volume, and trend.',
  {
    hunt_id: z.number().optional(),
    source: z.string().optional(),
    condition: z.string().optional(),
    days: z.number().optional().describe('Lookback period in days (default 30)'),
  },
  async ({ hunt_id, source, condition, days }) => {
    const lookback = days || 30;
    const conditions: string[] = [`p.observed_at > datetime('now', '-${lookback} days')`];
    const params: unknown[] = [];

    if (hunt_id) {
      conditions.push('ho.hunt_id = ?');
      params.push(hunt_id);
    }
    if (source) {
      conditions.push('o.source = ?');
      params.push(source);
    }
    if (condition) {
      conditions.push('o.condition = ?');
      params.push(condition);
    }

    const joinHuntOffers = hunt_id ? 'JOIN hunt_offers ho ON ho.offer_id = o.id' : '';
    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const stats = db.prepare(`
      SELECT
        COUNT(DISTINCT o.id) as offer_count,
        COUNT(p.id) as observation_count,
        MIN(p.total_landed_gbp) as min_price,
        MAX(p.total_landed_gbp) as max_price,
        AVG(p.total_landed_gbp) as avg_price
      FROM prices p
      JOIN offers o ON o.id = p.offer_id
      ${joinHuntOffers}
      ${whereClause}
      AND p.total_landed_gbp IS NOT NULL
    `).get(...params);

    // Median calculation
    const allPrices = db.prepare(`
      SELECT p.total_landed_gbp as price
      FROM prices p
      JOIN offers o ON o.id = p.offer_id
      ${joinHuntOffers}
      ${whereClause}
      AND p.total_landed_gbp IS NOT NULL
      ORDER BY p.total_landed_gbp
    `).all(...params) as any[];

    let median = null;
    if (allPrices.length > 0) {
      const mid = Math.floor(allPrices.length / 2);
      median = allPrices.length % 2 !== 0
        ? allPrices[mid].price
        : (allPrices[mid - 1].price + allPrices[mid].price) / 2;
    }

    // Trend: compare first half vs second half average
    let trend = 'insufficient_data';
    if (allPrices.length >= 4) {
      const half = Math.floor(allPrices.length / 2);
      // Re-query ordered by time for trend analysis
      const byTime = db.prepare(`
        SELECT p.total_landed_gbp as price
        FROM prices p
        JOIN offers o ON o.id = p.offer_id
        ${joinHuntOffers}
        ${whereClause}
        AND p.total_landed_gbp IS NOT NULL
        ORDER BY p.observed_at
      `).all(...params) as any[];

      const firstHalf = byTime.slice(0, half);
      const secondHalf = byTime.slice(half);
      const avgFirst = firstHalf.reduce((s: number, r: any) => s + r.price, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s: number, r: any) => s + r.price, 0) / secondHalf.length;
      const changePct = ((avgSecond - avgFirst) / avgFirst) * 100;

      if (changePct > 5) trend = 'rising';
      else if (changePct < -5) trend = 'falling';
      else trend = 'stable';
    }

    return jsonResult({
      period_days: lookback,
      stats,
      median_price: median,
      trend,
    });
  },
);

// ============================================================
// Tool 5: record_offer
// ============================================================
server.tool(
  'record_offer',
  'Upsert an offer (by source + source_id). Optionally record a price observation and associate with a hunt — all in one call.',
  {
    source: z.string(),
    source_id: z.string(),
    title: z.string(),
    url: z.string().optional(),
    seller: z.string().optional(),
    seller_rating: z.number().optional(),
    condition: z.string().optional(),
    specs_extracted: z.string().optional().describe('JSON string'),
    buying_format: z.string().optional(),
    auction_end_time: z.string().optional(),
    bid_count: z.number().optional(),
    price: z.number().optional().describe('If provided, records a price observation'),
    shipping: z.number().optional(),
    currency: z.string().optional().describe('Default GBP'),
    total_landed_gbp: z.number().optional(),
    hunt_id: z.number().optional().describe('If provided, associates offer with this hunt'),
    search_query_id: z.number().optional(),
  },
  async (args) => {
    const recordOffer = db.transaction(() => {
      // Upsert offer
      const existing = db.prepare(
        'SELECT id FROM offers WHERE source = ? AND source_id = ?',
      ).get(args.source, args.source_id) as any;

      let offerId: number;
      if (existing) {
        const sets: string[] = ["last_seen_at = datetime('now')"];
        const params: unknown[] = [];
        if (args.title) { sets.push('title = ?'); params.push(args.title); }
        if (args.url !== undefined) { sets.push('url = ?'); params.push(args.url); }
        if (args.seller !== undefined) { sets.push('seller = ?'); params.push(args.seller); }
        if (args.seller_rating !== undefined) { sets.push('seller_rating = ?'); params.push(args.seller_rating); }
        if (args.condition !== undefined) { sets.push('condition = ?'); params.push(args.condition); }
        if (args.specs_extracted !== undefined) { sets.push('specs_extracted = ?'); params.push(args.specs_extracted); }
        if (args.buying_format !== undefined) { sets.push('buying_format = ?'); params.push(args.buying_format); }
        if (args.auction_end_time !== undefined) { sets.push('auction_end_time = ?'); params.push(args.auction_end_time); }
        if (args.bid_count !== undefined) { sets.push('bid_count = ?'); params.push(args.bid_count); }
        params.push(existing.id);
        db.prepare(`UPDATE offers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        offerId = existing.id;
      } else {
        const result = db.prepare(`
          INSERT INTO offers (source, source_id, title, url, seller, seller_rating, condition,
            specs_extracted, buying_format, auction_end_time, bid_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          args.source, args.source_id, args.title, args.url || null,
          args.seller || null, args.seller_rating ?? null, args.condition || null,
          args.specs_extracted || '{}', args.buying_format || null,
          args.auction_end_time || null, args.bid_count ?? null,
        );
        offerId = result.lastInsertRowid as number;
      }

      // Record price if provided
      let priceId: number | null = null;
      if (args.price !== undefined) {
        const priceResult = db.prepare(`
          INSERT INTO prices (offer_id, price, shipping, currency, total_landed_gbp)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          offerId, args.price, args.shipping ?? null,
          args.currency || 'GBP', args.total_landed_gbp ?? null,
        );
        priceId = priceResult.lastInsertRowid as number;
      }

      // Associate with hunt if provided
      if (args.hunt_id) {
        db.prepare(`
          INSERT OR IGNORE INTO hunt_offers (hunt_id, offer_id, search_query_id)
          VALUES (?, ?, ?)
        `).run(args.hunt_id, offerId, args.search_query_id ?? null);
      }

      const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
      return { offer, price_id: priceId, is_new: !existing };
    });

    const result = recordOffer();
    return jsonResult(result);
  },
);

// ============================================================
// Tool 6: update_offer
// ============================================================
server.tool(
  'update_offer',
  'Update an offer\'s status or watch settings. Can also update the hunt_offer status for a specific hunt.',
  {
    offer_id: z.number().optional(),
    source: z.string().optional().describe('Alternative to offer_id: lookup by source + source_id'),
    source_id: z.string().optional(),
    status: z.enum(['active', 'ended', 'removed', 'sold']).optional(),
    watching: z.boolean().optional(),
    watch_conditions: z.string().optional().describe('JSON string'),
    hunt_id: z.number().optional().describe('If provided with hunt_offer_status, updates the hunt_offer'),
    hunt_offer_status: z.enum(['new', 'evaluated', 'watching', 'dismissed']).optional(),
  },
  async (args) => {
    let offerId = args.offer_id;
    if (!offerId && args.source && args.source_id) {
      const row = db.prepare('SELECT id FROM offers WHERE source = ? AND source_id = ?').get(args.source, args.source_id) as any;
      if (!row) return errorResult(`Offer not found: ${args.source}/${args.source_id}`);
      offerId = row.id;
    }
    if (!offerId) return errorResult('Provide offer_id or source + source_id');

    const sets: string[] = [];
    const params: unknown[] = [];
    if (args.status) { sets.push('status = ?'); params.push(args.status); }
    if (args.watching !== undefined) { sets.push('watching = ?'); params.push(args.watching ? 1 : 0); }
    if (args.watch_conditions !== undefined) { sets.push('watch_conditions = ?'); params.push(args.watch_conditions); }

    if (sets.length > 0) {
      params.push(offerId);
      db.prepare(`UPDATE offers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }

    if (args.hunt_id && args.hunt_offer_status) {
      db.prepare('UPDATE hunt_offers SET status = ? WHERE hunt_id = ? AND offer_id = ?')
        .run(args.hunt_offer_status, args.hunt_id, offerId);
    }

    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
    return jsonResult({ offer });
  },
);

// ============================================================
// Tool 7: get_offer
// ============================================================
server.tool(
  'get_offer',
  'Get a single offer by ID or source+source_id (with optional full history), or search offers by attributes.',
  {
    offer_id: z.number().optional(),
    source: z.string().optional(),
    source_id: z.string().optional(),
    include_history: z.boolean().optional().describe('Include all prices, evaluations, alerts'),
    // Search mode params
    hunt_id: z.number().optional().describe('Filter by hunt association'),
    hunt_offer_status: z.string().optional().describe('Filter by hunt_offer status (new, evaluated, watching, dismissed)'),
    condition: z.string().optional(),
    min_price: z.number().optional().describe('Min latest total_landed_gbp'),
    max_price: z.number().optional().describe('Max latest total_landed_gbp'),
    watching_only: z.boolean().optional(),
    limit: z.number().optional().describe('Max results (default 50)'),
  },
  async (args) => {
    // Single offer mode
    if (args.offer_id || (args.source && args.source_id)) {
      let offer: any;
      if (args.offer_id) {
        offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(args.offer_id);
      } else {
        offer = db.prepare('SELECT * FROM offers WHERE source = ? AND source_id = ?').get(args.source, args.source_id);
      }
      if (!offer) return errorResult('Offer not found');

      if (args.include_history) {
        const prices = db.prepare('SELECT * FROM prices WHERE offer_id = ? ORDER BY observed_at DESC').all(offer.id);
        const evaluations = db.prepare('SELECT * FROM evaluations WHERE offer_id = ? ORDER BY evaluated_at DESC').all(offer.id);
        const alerts = db.prepare('SELECT * FROM alerts WHERE offer_id = ? ORDER BY alerted_at DESC').all(offer.id);
        const huntAssociations = db.prepare(`
          SELECT ho.*, h.name as hunt_name FROM hunt_offers ho
          JOIN hunts h ON h.id = ho.hunt_id WHERE ho.offer_id = ?
        `).all(offer.id);
        return jsonResult({ offer, prices, evaluations, alerts, hunt_associations: huntAssociations });
      }

      return jsonResult({ offer });
    }

    // Search mode
    const conditions: string[] = [];
    const params: unknown[] = [];
    const joins: string[] = [];

    if (args.hunt_id) {
      joins.push('JOIN hunt_offers ho ON ho.offer_id = o.id');
      conditions.push('ho.hunt_id = ?');
      params.push(args.hunt_id);
      if (args.hunt_offer_status) {
        conditions.push('ho.status = ?');
        params.push(args.hunt_offer_status);
      }
    }
    if (args.condition) {
      conditions.push('o.condition = ?');
      params.push(args.condition);
    }
    if (args.watching_only) {
      conditions.push('o.watching = 1');
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = args.limit || 50;

    let query = `SELECT o.* FROM offers o ${joins.join(' ')} ${whereClause} ORDER BY o.last_seen_at DESC LIMIT ?`;
    params.push(limit);

    let offers = db.prepare(query).all(...params) as any[];

    // Post-filter by price if needed (requires subquery on latest price)
    if (args.min_price !== undefined || args.max_price !== undefined) {
      offers = offers.filter((o: any) => {
        const latestPrice = db.prepare(
          'SELECT total_landed_gbp FROM prices WHERE offer_id = ? ORDER BY observed_at DESC LIMIT 1',
        ).get(o.id) as any;
        if (!latestPrice?.total_landed_gbp) return false;
        if (args.min_price !== undefined && latestPrice.total_landed_gbp < args.min_price) return false;
        if (args.max_price !== undefined && latestPrice.total_landed_gbp > args.max_price) return false;
        return true;
      });
    }

    // Attach latest price to each result
    const results = offers.map((o: any) => {
      const latestPrice = db.prepare(
        'SELECT * FROM prices WHERE offer_id = ? ORDER BY observed_at DESC LIMIT 1',
      ).get(o.id);
      return { ...o, latest_price: latestPrice || null };
    });

    return jsonResult({ offers: results, count: results.length });
  },
);

// ============================================================
// Tool 8: record_evaluation
// ============================================================
server.tool(
  'record_evaluation',
  'Record an evaluation decision for an offer against a hunt. Updates hunt_offer status accordingly. Watch decision sets offer.watching=1.',
  {
    offer_id: z.number(),
    hunt_id: z.number(),
    decision: z.enum(['alert', 'skip', 'watch']),
    reasoning: z.string(),
  },
  async ({ offer_id, hunt_id, decision, reasoning }) => {
    const recordEval = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO evaluations (offer_id, hunt_id, decision, reasoning)
        VALUES (?, ?, ?, ?)
      `).run(offer_id, hunt_id, decision, reasoning);

      // Update hunt_offer status
      let hoStatus: string;
      if (decision === 'watch') hoStatus = 'watching';
      else if (decision === 'skip') hoStatus = 'dismissed';
      else hoStatus = 'evaluated';

      db.prepare('UPDATE hunt_offers SET status = ? WHERE hunt_id = ? AND offer_id = ?')
        .run(hoStatus, hunt_id, offer_id);

      // If watch, set offer.watching
      if (decision === 'watch') {
        db.prepare('UPDATE offers SET watching = 1 WHERE id = ?').run(offer_id);
      }

      return db.prepare('SELECT * FROM evaluations WHERE id = ?').get(result.lastInsertRowid);
    });

    const evaluation = recordEval();
    return jsonResult({ evaluation });
  },
);

// ============================================================
// Tool 9: record_alert
// ============================================================
server.tool(
  'record_alert',
  'Record that an alert was sent to the user about an offer.',
  {
    offer_id: z.number(),
    hunt_id: z.number(),
    urgency: z.enum(['high', 'medium', 'low']),
    message_sent: z.string(),
  },
  async ({ offer_id, hunt_id, urgency, message_sent }) => {
    const result = db.prepare(`
      INSERT INTO alerts (offer_id, hunt_id, urgency, message_sent)
      VALUES (?, ?, ?, ?)
    `).run(offer_id, hunt_id, urgency, message_sent);
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(result.lastInsertRowid);
    return jsonResult({ alert });
  },
);

// ============================================================
// Tool 10: record_alert_response
// ============================================================
server.tool(
  'record_alert_response',
  'Record the user\'s response to an alert and any extracted feedback/preferences.',
  {
    alert_id: z.number(),
    user_response: z.string(),
    feedback_extracted: z.string().optional().describe('Structured preference extracted from the response'),
  },
  async ({ alert_id, user_response, feedback_extracted }) => {
    db.prepare(`
      UPDATE alerts SET user_response = ?, feedback_extracted = ?, responded_at = datetime('now')
      WHERE id = ?
    `).run(user_response, feedback_extracted || null, alert_id);
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert_id);
    if (!alert) return errorResult('Alert not found: ' + alert_id);
    return jsonResult({ alert });
  },
);

// ============================================================
// Tool 11: get_prices
// ============================================================
server.tool(
  'get_prices',
  'Get price data. Modes: "history" (for a single offer), "aggregates" (median/range/trend across offers), "changes" (offers with price changes since a timestamp).',
  {
    mode: z.enum(['history', 'aggregates', 'changes']),
    offer_id: z.number().optional().describe('Required for history mode'),
    hunt_id: z.number().optional().describe('Filter by hunt (aggregates/changes modes)'),
    source: z.string().optional(),
    condition: z.string().optional(),
    days: z.number().optional().describe('Lookback period (default 30)'),
    since: z.string().optional().describe('ISO timestamp for changes mode'),
  },
  async (args) => {
    if (args.mode === 'history') {
      if (!args.offer_id) return errorResult('offer_id required for history mode');
      const prices = db.prepare(
        'SELECT * FROM prices WHERE offer_id = ? ORDER BY observed_at DESC',
      ).all(args.offer_id);
      return jsonResult({ prices });
    }

    if (args.mode === 'changes') {
      const since = args.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const huntJoin = args.hunt_id ? 'JOIN hunt_offers ho ON ho.offer_id = o.id AND ho.hunt_id = ?' : '';
      const huntParams = args.hunt_id ? [args.hunt_id] : [];

      const changes = db.prepare(`
        SELECT o.id, o.title, o.source, o.source_id, o.url,
          p_new.total_landed_gbp as new_price,
          p_new.observed_at as new_observed,
          p_prev.total_landed_gbp as prev_price,
          p_prev.observed_at as prev_observed
        FROM offers o
        ${huntJoin}
        JOIN prices p_new ON p_new.offer_id = o.id
        LEFT JOIN prices p_prev ON p_prev.offer_id = o.id
          AND p_prev.observed_at = (
            SELECT MAX(observed_at) FROM prices
            WHERE offer_id = o.id AND observed_at < p_new.observed_at
          )
        WHERE p_new.observed_at > ?
          AND p_new.observed_at = (SELECT MAX(observed_at) FROM prices WHERE offer_id = o.id)
          AND (p_prev.total_landed_gbp IS NULL OR p_new.total_landed_gbp != p_prev.total_landed_gbp)
        ORDER BY p_new.observed_at DESC
      `).all(...huntParams, since);
      return jsonResult({ changes, since });
    }

    // Aggregates mode — delegate to get_market_overview logic
    const lookback = args.days || 30;
    const conditions: string[] = [`p.observed_at > datetime('now', '-${lookback} days')`, 'p.total_landed_gbp IS NOT NULL'];
    const params: unknown[] = [];
    const joins: string[] = ['JOIN offers o ON o.id = p.offer_id'];

    if (args.hunt_id) {
      joins.push('JOIN hunt_offers ho ON ho.offer_id = o.id');
      conditions.push('ho.hunt_id = ?');
      params.push(args.hunt_id);
    }
    if (args.source) { conditions.push('o.source = ?'); params.push(args.source); }
    if (args.condition) { conditions.push('o.condition = ?'); params.push(args.condition); }

    const stats = db.prepare(`
      SELECT COUNT(DISTINCT o.id) as offer_count, COUNT(p.id) as observations,
        MIN(p.total_landed_gbp) as min_price, MAX(p.total_landed_gbp) as max_price,
        AVG(p.total_landed_gbp) as avg_price
      FROM prices p ${joins.join(' ')}
      WHERE ${conditions.join(' AND ')}
    `).get(...params);

    return jsonResult({ aggregates: stats, period_days: lookback });
  },
);

// ============================================================
// Tool 12: record_search
// ============================================================
server.tool(
  'record_search',
  'Record a search execution and its result counts. Returns the search_query ID for use when associating offers.',
  {
    hunt_id: z.number(),
    source: z.string(),
    terms: z.string(),
    result_count: z.number(),
    new_offer_count: z.number(),
    relevant_count: z.number(),
  },
  async ({ hunt_id, source, terms, result_count, new_offer_count, relevant_count }) => {
    const result = db.prepare(`
      INSERT INTO search_queries (hunt_id, source, terms, result_count, new_offer_count, relevant_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hunt_id, source, terms, result_count, new_offer_count, relevant_count);
    const query = db.prepare('SELECT * FROM search_queries WHERE id = ?').get(result.lastInsertRowid);
    return jsonResult({ search_query: query });
  },
);

// ============================================================
// Tool 13: search_evaluations
// ============================================================
server.tool(
  'search_evaluations',
  'Search past evaluations by text (in reasoning), decision type, or hunt. Optionally includes user feedback from alerts.',
  {
    query: z.string().optional().describe('Text search in evaluation reasoning'),
    hunt_id: z.number().optional(),
    decision: z.enum(['alert', 'skip', 'watch']).optional(),
    days: z.number().optional().describe('Lookback period (default 90)'),
    include_feedback: z.boolean().optional().describe('Join with alert user_response data'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async (args) => {
    const lookback = args.days || 90;
    const limit = args.limit || 20;
    const conditions: string[] = [`e.evaluated_at > datetime('now', '-${lookback} days')`];
    const params: unknown[] = [];

    if (args.query) {
      conditions.push('e.reasoning LIKE ?');
      params.push(`%${args.query}%`);
    }
    if (args.hunt_id) {
      conditions.push('e.hunt_id = ?');
      params.push(args.hunt_id);
    }
    if (args.decision) {
      conditions.push('e.decision = ?');
      params.push(args.decision);
    }

    const feedbackJoin = args.include_feedback
      ? 'LEFT JOIN alerts a ON a.offer_id = e.offer_id AND a.hunt_id = e.hunt_id'
      : '';
    const feedbackCols = args.include_feedback
      ? ', a.user_response, a.feedback_extracted, a.urgency as alert_urgency'
      : '';

    const evaluations = db.prepare(`
      SELECT e.*, o.title, o.source, o.source_id, o.condition, o.url,
        h.name as hunt_name${feedbackCols}
      FROM evaluations e
      JOIN offers o ON o.id = e.offer_id
      JOIN hunts h ON h.id = e.hunt_id
      ${feedbackJoin}
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.evaluated_at DESC
      LIMIT ?
    `).all(...params, limit);

    return jsonResult({ evaluations, count: evaluations.length });
  },
);

// --- Start Server ---

const transport = new StdioServerTransport();
await server.connect(transport);
