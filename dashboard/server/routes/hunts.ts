import { Hono } from 'hono';
import { getDealDb } from '../db.js';
import { checkOfferStatusBySource } from '../sources/index.js';
import { evaluateActivationGate, type HuntRow } from '../deal-hunter-gate.js';
import { computeReadiness } from '../hunt-readiness.js';
import { parseJsonField } from '../parse.js';

// Shared subquery fragment: provenance-gate readiness counts (segments, KB coverage, verifications).
const READINESS_COUNTS_SQL = `
        (SELECT COUNT(*) FROM market_segments ms WHERE ms.hunt_id = h.id) as segment_count,
        (SELECT COUNT(*) FROM knowledge_base kb WHERE kb.hunt_id = h.id) as kb_count,
        (SELECT COUNT(*) FROM claim_verifications cv WHERE cv.hunt_id = h.id AND cv.verdict = 'verified') as verified_count`;

function readinessFor(h: Record<string, unknown>) {
  return computeReadiness(
    { status: h.status as string, criteria: h.criteria as string, gate_version: h.gate_version as number | null },
    {
      segment_count: (h.segment_count as number) ?? 0,
      kb_count: (h.kb_count as number) ?? 0,
      verified_count: (h.verified_count as number) ?? 0,
    },
  );
}

/**
 * Default source list for a hunt whose `sources` column is null (legacy rows).
 * Derived from the hunt's vertical so a cars hunt isn't mislabelled as eBay.
 */
function defaultSources(vertical: unknown): string[] {
  return vertical === 'cars' ? ['autotrader'] : ['ebay'];
}

export const huntRoutes = new Hono();

// List all hunts with summary stats
huntRoutes.get('/hunts', (c) => {
  const db = getDealDb();
  const status = c.req.query('status'); // active, paused, closed, or all
  const vertical = c.req.query('vertical'); // optional filter: computers, cars, etc.

  const conditions: string[] = [];
  if (status === 'all') { /* no status filter */ }
  else if (status === 'closed') conditions.push("h.status = 'closed'");
  else if (status === 'paused') conditions.push("h.status = 'paused'");
  else if (status === 'active') conditions.push("h.status = 'active'");
  else if (status === 'draft') conditions.push("h.status = 'draft'");
  // Default view includes drafts so a hunt stuck pre-activation is visible, not silently missing.
  else conditions.push("h.status IN ('draft', 'active', 'paused')");

  if (vertical) conditions.push(`h.vertical = '${vertical.replace(/'/g, "''")}'`);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const hunts = db
    .prepare(
      `SELECT h.*,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'new') as new_count,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'evaluated') as evaluated_count,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'watching') as watching_count,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'dismissed') as dismissed_count,${READINESS_COUNTS_SQL}
      FROM hunts h
      ${whereClause}
      ORDER BY CASE h.status WHEN 'draft' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2 WHEN 'closed' THEN 3 END, h.created_at DESC`,
    )
    .all();

  // Enrich with price ranges and last search
  const priceRanges = db
    .prepare(
      `SELECT ho.hunt_id,
        MIN(COALESCE(p.total_landed_gbp, p.price)) as min_price,
        MAX(COALESCE(p.total_landed_gbp, p.price)) as max_price
      FROM hunt_offers ho
      JOIN offers o ON o.id = ho.offer_id AND o.watching = 1
      JOIN prices p ON p.offer_id = o.id
        AND p.id = (SELECT id FROM prices WHERE offer_id = o.id ORDER BY observed_at DESC LIMIT 1)
      WHERE COALESCE(p.total_landed_gbp, p.price) IS NOT NULL
      GROUP BY ho.hunt_id`,
    )
    .all() as Array<{ hunt_id: number; min_price: number; max_price: number }>;

  const priceMap = new Map(priceRanges.map((r) => [r.hunt_id, r]));

  const lastSearches = db
    .prepare(
      `SELECT sq.hunt_id, sq.searched_at as last_searched, sq.result_count as last_result_count, sq.new_offer_count as last_new_count
      FROM search_queries sq
      INNER JOIN (
        SELECT hunt_id, MAX(searched_at) as max_at FROM search_queries GROUP BY hunt_id
      ) latest ON sq.hunt_id = latest.hunt_id AND sq.searched_at = latest.max_at`,
    )
    .all() as Array<{
    hunt_id: number;
    last_searched: string;
    last_result_count: number;
    last_new_count: number;
  }>;

  const searchMap = new Map(lastSearches.map((s) => [s.hunt_id, s]));

  const enriched = (hunts as Record<string, unknown>[]).map((h) => {
    const id = h.id as number;
    const prices = priceMap.get(id);
    const search = searchMap.get(id);
    return {
      ...h,
      sources: parseJsonField(h.sources as string | null, defaultSources(h.vertical)),
      // Provenance-gate readiness: a non-closed hunt still blocked by the gate surfaces why —
      // needs_baselining (no segments), and for v2 feature-led hunts needs_kb / needs_verification.
      ...readinessFor(h),
      min_price: prices?.min_price ?? null,
      max_price: prices?.max_price ?? null,
      last_searched: search?.last_searched ?? null,
      last_result_count: search?.last_result_count ?? null,
      last_new_count: search?.last_new_count ?? null,
    };
  });

  return c.json(enriched);
});

// Get single hunt detail
huntRoutes.get('/hunts/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  const db = getDealDb();

  const hunt = db
    .prepare(
      `SELECT h.*,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'new') as new_count,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'evaluated') as evaluated_count,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'watching') as watching_count,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'dismissed') as dismissed_count,${READINESS_COUNTS_SQL}
      FROM hunts h WHERE h.id = ?`,
    )
    .get(id);

  if (!hunt) return c.json({ error: 'Hunt not found' }, 404);
  const h = hunt as Record<string, unknown>;
  return c.json({
    ...h,
    sources: parseJsonField(h.sources as string | null, defaultSources(h.vertical)),
    ...readinessFor(h),
  });
});

// Offers for a hunt, filtered by pipeline status
huntRoutes.get('/hunts/:id/offers', (c) => {
  const id = parseInt(c.req.param('id'));
  const status = c.req.query('status') || 'watching';
  const db = getDealDb();

  const rows = db
    .prepare(
      `SELECT o.*, ho.status as pipeline_status, ho.first_associated_at,
        (SELECT COALESCE(total_landed_gbp, price) FROM prices WHERE offer_id = o.id ORDER BY observed_at DESC LIMIT 1) as current_price,
        (SELECT COALESCE(total_landed_gbp, price) FROM prices WHERE offer_id = o.id ORDER BY observed_at ASC LIMIT 1) as first_price
      FROM hunt_offers ho
      JOIN offers o ON o.id = ho.offer_id
      WHERE ho.hunt_id = ? AND ho.status = ?
      ORDER BY o.last_seen_at DESC`,
    )
    .all(id, status) as Record<string, unknown>[];

  // Parse the JSON `attributes` column so cars Year/Mileage columns render
  // (frontend treats attributes as an object, not a raw JSON string).
  const offers = rows.map((row) => ({
    ...row,
    attributes: parseJsonField(row.attributes as string | null, {}),
  }));

  return c.json(offers);
});

// Search history for a hunt
huntRoutes.get('/hunts/:id/searches', (c) => {
  const id = parseInt(c.req.param('id'));
  const db = getDealDb();

  const searches = db
    .prepare(
      'SELECT * FROM search_queries WHERE hunt_id = ? ORDER BY searched_at DESC LIMIT 100',
    )
    .all(id);

  return c.json(searches);
});

// Evaluations for a hunt
huntRoutes.get('/hunts/:id/evaluations', (c) => {
  const id = parseInt(c.req.param('id'));
  const db = getDealDb();

  const evaluations = db
    .prepare(
      `SELECT e.*, o.title as offer_title
      FROM evaluations e
      JOIN offers o ON o.id = e.offer_id
      WHERE e.hunt_id = ?
      ORDER BY e.evaluated_at DESC
      LIMIT 100`,
    )
    .all(id) as Record<string, unknown>[];

  // Parse the JSON `requirement_checks` column to an array (null stays null).
  const parsed = evaluations.map((row) => ({
    ...row,
    requirement_checks: parseJsonField<unknown[] | null>(
      row.requirement_checks as string | null,
      null,
    ),
  }));

  return c.json(parsed);
});

// Alerts for a hunt
huntRoutes.get('/hunts/:id/alerts', (c) => {
  const id = parseInt(c.req.param('id'));
  const db = getDealDb();

  const alerts = db
    .prepare(
      `SELECT a.*, o.title as offer_title
      FROM alerts a
      JOIN offers o ON o.id = a.offer_id
      WHERE a.hunt_id = ?
      ORDER BY a.alerted_at DESC
      LIMIT 100`,
    )
    .all(id);

  return c.json(alerts);
});

// Update hunt parameters
huntRoutes.put('/hunts/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const db = getDealDb();

  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.search_terms !== undefined) {
    sets.push('search_terms = ?');
    params.push(
      typeof body.search_terms === 'string'
        ? body.search_terms
        : JSON.stringify(body.search_terms),
    );
  }
  if (body.cadence_minutes !== undefined) {
    sets.push('cadence_minutes = ?');
    params.push(body.cadence_minutes);
  }
  if (body.category_ids !== undefined) {
    sets.push('category_ids = ?');
    params.push(body.category_ids);
  }
  if (body.monitoring !== undefined) {
    // Mirror the MCP `update`: monitoring can never be turned ON here — that must go through the
    // activation gate (resume/activate), which verifies valid criteria + at least one market
    // segment. Only an explicit `false` (stop monitoring) is honoured.
    if (body.monitoring === true || body.monitoring === 1) {
      return c.json(
        {
          error:
            'Cannot enable monitoring via update — use resume/activate, which verifies the hunt has valid criteria and at least one market segment.',
        },
        400,
      );
    }
    sets.push('monitoring = ?');
    params.push(0);
  }

  if (sets.length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  params.push(id);
  db.prepare(`UPDATE hunts SET ${sets.join(', ')} WHERE id = ?`).run(
    ...params,
  );

  const updated = db.prepare('SELECT * FROM hunts WHERE id = ?').get(id);
  return c.json(updated);
});

// Pause hunt — mirrors the MCP `pause`: also clears monitoring so the watcher stops polling it
// (getActiveHunts requires status='active' AND monitoring=1). Clearing only status left the row
// `paused, monitoring=1`, which a later ungated resume could flip straight back to monitored.
huntRoutes.post('/hunts/:id/pause', (c) => {
  const id = parseInt(c.req.param('id'));
  const db = getDealDb();

  const result = db
    .prepare(
      "UPDATE hunts SET status = 'paused', monitoring = 0 WHERE id = ? AND status = 'active'",
    )
    .run(id);

  if (result.changes === 0) {
    return c.json({ error: 'Hunt not found or not active' }, 400);
  }

  return c.json({ success: true });
});

// Resume hunt — mirrors the MCP `resume`: re-run the activation gate (valid criteria for the
// vertical AND >=1 market segment) and only then set status='active', monitoring=1. The dashboard
// is a second writer to the same DB, so without this it could re-activate a malformed/unbaselined
// hunt that the watcher would then poll (throwing, auto-pausing the source). On gate failure the
// hunt stays paused and we return 400 with the missing items.
huntRoutes.post('/hunts/:id/resume', (c) => {
  const id = parseInt(c.req.param('id'));
  const db = getDealDb();

  const hunt = db
    .prepare('SELECT id, criteria, vertical, status, search_terms FROM hunts WHERE id = ?')
    .get(id) as HuntRow | undefined;

  if (!hunt) return c.json({ error: 'Hunt not found' }, 404);
  if (hunt.status !== 'paused') {
    return c.json({ error: 'Hunt is not paused' }, 400);
  }

  const gate = evaluateActivationGate(db, hunt);
  if (!gate.ok) {
    return c.json(
      {
        error: 'Cannot resume — activation gate not satisfied. Fix criteria and/or run /price-baselining.',
        missing: gate.errors,
      },
      400,
    );
  }

  db.prepare("UPDATE hunts SET status = 'active', monitoring = 1 WHERE id = ?").run(id);
  return c.json({ success: true });
});

// Close hunt with cascade
huntRoutes.post('/hunts/:id/close', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const db = getDealDb();

  const closeHunt = db.transaction(() => {
    db.prepare(
      "UPDATE hunts SET status = 'closed', closed_at = datetime('now'), close_reason = ? WHERE id = ?",
    ).run(body.reason || null, id);

    // Dismiss all non-dismissed hunt_offers
    db.prepare(
      "UPDATE hunt_offers SET status = 'dismissed' WHERE hunt_id = ? AND status IN ('new', 'evaluated', 'watching')",
    ).run(id);

    // Clear watches for offers only associated with this hunt
    db.prepare(
      `UPDATE offers SET watching = 0 WHERE id IN (
        SELECT offer_id FROM hunt_offers WHERE hunt_id = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM hunt_offers ho2
        WHERE ho2.offer_id = offers.id AND ho2.hunt_id != ? AND ho2.status = 'watching'
      )`,
    ).run(id, id);
  });

  closeHunt();
  return c.json({ success: true });
});

// Price data for a hunt
huntRoutes.get('/hunts/:id/prices', (c) => {
  const id = parseInt(c.req.param('id'));
  const period = c.req.query('period') || '30d';
  const db = getDealDb();

  // Convert period to SQLite date modifier
  const periodMap: Record<string, string> = {
    '7d': '-7 days',
    '14d': '-14 days',
    '30d': '-30 days',
    '90d': '-90 days',
    all: '-100 years',
  };
  const dateModifier = periodMap[period] || '-30 days';

  const observations = db
    .prepare(
      `SELECT p.*, o.title as offer_title, o.condition as offer_condition,
        o.status as offer_status, o.watching as offer_watching
      FROM prices p
      JOIN offers o ON o.id = p.offer_id
      JOIN hunt_offers ho ON ho.offer_id = o.id AND ho.hunt_id = ?
      WHERE p.observed_at >= datetime('now', ?)
        AND COALESCE(p.total_landed_gbp, p.price) IS NOT NULL
      ORDER BY p.observed_at ASC`,
    )
    .all(id, dateModifier) as Array<Record<string, unknown>>;

  // Compute aggregates in JS (including median)
  const prices = observations
    .map((o) => (o.total_landed_gbp ?? o.price) as number)
    .filter((p) => p != null);

  const sorted = [...prices].sort((a, b) => a - b);
  const median =
    sorted.length > 0
      ? sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)]
      : 0;

  const offerIds = new Set(observations.map((o) => o.offer_id));

  const aggregates = {
    observation_count: prices.length,
    offer_count: offerIds.size,
    min_price: sorted.length > 0 ? sorted[0] : 0,
    max_price: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    avg_price:
      prices.length > 0
        ? prices.reduce((a, b) => a + b, 0) / prices.length
        : 0,
    median_price: median,
  };

  return c.json({ aggregates, observations });
});

// Activity / history for a hunt
huntRoutes.get('/hunts/:id/activity', (c) => {
  const id = parseInt(c.req.param('id'));
  const period = c.req.query('period') || '30d';
  const db = getDealDb();

  const periodMap: Record<string, string> = {
    '7d': '-7 days',
    '14d': '-14 days',
    '30d': '-30 days',
    '90d': '-90 days',
    all: '-100 years',
  };
  const dateModifier = periodMap[period] || '-30 days';

  const log_entries = db
    .prepare(
      `SELECT * FROM hunt_log
      WHERE hunt_id = ? AND logged_at >= datetime('now', ?)
      ORDER BY logged_at DESC`,
    )
    .all(id, dateModifier);

  const daily_stats = db
    .prepare(
      `SELECT
        date(logged_at) as date,
        COUNT(*) as runs,
        SUM(offers_evaluated) as evaluated,
        SUM(offers_alerted) as alerted,
        SUM(offers_skipped) as skipped
      FROM hunt_log
      WHERE hunt_id = ? AND logged_at >= datetime('now', ?)
      GROUP BY date(logged_at)
      ORDER BY date ASC`,
    )
    .all(id, dateModifier);

  return c.json({ log_entries, daily_stats });
});

// Refresh all watching offers for a hunt — check each against their source
huntRoutes.post('/hunts/:id/refresh-watching', async (c) => {
  const id = parseInt(c.req.param('id'));
  const db = getDealDb();

  const offers = db
    .prepare(
      `SELECT o.id, o.source, o.source_id
       FROM offers o
       JOIN hunt_offers ho ON ho.offer_id = o.id
       WHERE ho.hunt_id = ? AND ho.status = 'watching' AND o.status = 'active'`,
    )
    .all(id) as { id: number; source: string; source_id: string }[];

  let checked = 0;
  let removed = 0;
  let active = 0;
  let errors = 0;

  for (const offer of offers) {
    if (!offer.source_id) continue;

    let result;
    try {
      result = await checkOfferStatusBySource(offer.source, offer.source_id);
    } catch (err) {
      errors++;
      continue;
    }
    checked++;

    if (result.error) {
      errors++;
      continue;
    }

    if (result.status === 'removed' || result.status === 'ended' || result.status === 'sold') {
      db.prepare("UPDATE offers SET status = ?, last_status_change = datetime('now') WHERE id = ?").run(result.status, offer.id);
      removed++;
    } else {
      db.prepare("UPDATE offers SET last_seen_at = datetime('now') WHERE id = ?").run(offer.id);
      active++;
    }
  }

  return c.json({ checked, removed, active, errors });
});
