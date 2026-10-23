import { Hono } from 'hono';
import { getDealDb } from '../db.js';
import { checkOfferStatusBySource, pendingRefreshJobs } from '../sources/index.js';
import { parseJsonField } from '../parse.js';
import { randomUUID } from 'crypto';

/**
 * Per-offer deduplication of active async refresh jobs.
 * Maps offerId → { refreshId, promise } so that a double-click (or concurrent
 * requests from the hunt's "Refresh Watching" bulk action) for the same offer
 * returns the existing job rather than firing a duplicate AT request.
 *
 * Entry is removed when the job settles.
 */
const activeRefreshByOffer = new Map<number, { refreshId: string; promise: Promise<{ status: string; error?: string }> }>();

export const offerRoutes = new Hono();

// All watched offers across hunts
offerRoutes.get('/watched', (c) => {
  const db = getDealDb();

  const rows = db
    .prepare(
      `SELECT o.*, ho.hunt_id, h.name as hunt_name, ho.status as pipeline_status,
        (SELECT COALESCE(total_landed_gbp, price) FROM prices WHERE offer_id = o.id ORDER BY observed_at DESC LIMIT 1) as current_price,
        (SELECT COALESCE(total_landed_gbp, price) FROM prices WHERE offer_id = o.id ORDER BY observed_at ASC LIMIT 1) as first_price,
        (SELECT shipping FROM prices WHERE offer_id = o.id ORDER BY observed_at DESC LIMIT 1) as current_shipping
      FROM offers o
      JOIN hunt_offers ho ON ho.offer_id = o.id AND ho.status = 'watching'
      JOIN hunts h ON h.id = ho.hunt_id
      WHERE o.watching = 1
      ORDER BY
        CASE WHEN o.auction_end_time IS NOT NULL AND o.auction_end_time > datetime('now') THEN 0 ELSE 1 END,
        o.auction_end_time ASC NULLS LAST`,
    )
    .all() as Record<string, unknown>[];

  // Parse the JSON `attributes` column so the frontend receives an object
  // (cars Year/Mileage columns) rather than a raw JSON string. Matches the
  // single-offer endpoint below. `watch_conditions` likewise (price keys +
  // optional verify_required list); null stays null.
  const offers = rows.map((row) => ({
    ...row,
    attributes: parseJsonField(row.attributes as string | null, {}),
    watch_conditions: parseJsonField<Record<string, unknown> | null>(
      row.watch_conditions as string | null,
      null,
    ),
  }));

  return c.json(offers);
});

// Single offer detail
offerRoutes.get('/offers/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  const db = getDealDb();

  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(id);
  if (!offer) return c.json({ error: 'Offer not found' }, 404);

  const huntAssociations = db
    .prepare(
      `SELECT ho.hunt_id, ho.status, h.name as hunt_name
      FROM hunt_offers ho
      JOIN hunts h ON h.id = ho.hunt_id
      WHERE ho.offer_id = ?`,
    )
    .all(id);

  const evaluations = db
    .prepare(
      `SELECT e.*, h.name as hunt_name
      FROM evaluations e
      JOIN hunts h ON h.id = e.hunt_id
      WHERE e.offer_id = ?
      ORDER BY e.evaluated_at DESC`,
    )
    .all(id) as Record<string, unknown>[];

  // Parse the JSON `requirement_checks` column to an array (null stays null).
  const parsedEvaluations = evaluations.map((row) => ({
    ...row,
    requirement_checks: parseJsonField<unknown[] | null>(
      row.requirement_checks as string | null,
      null,
    ),
  }));

  const alerts = db
    .prepare(
      `SELECT a.*, h.name as hunt_name
      FROM alerts a
      JOIN hunts h ON h.id = a.hunt_id
      WHERE a.offer_id = ?
      ORDER BY a.alerted_at DESC`,
    )
    .all(id);

  // Jev must-have verdicts (watcher shadow mode). The table is created by the watcher's
  // ensureSchema(); tolerate its absence on a DB the watcher hasn't migrated yet.
  let jevChecks: Record<string, unknown>[] = [];
  try {
    jevChecks = (
      db
        .prepare(
          `SELECT c.*, h.name as hunt_name
          FROM offer_requirement_checks c
          JOIN hunts h ON h.id = c.hunt_id
          WHERE c.offer_id = ?
          ORDER BY c.hunt_id, c.rowid`,
        )
        .all(id) as Record<string, unknown>[]
    ).map((row) => ({
      ...row,
      probabilities: parseJsonField<unknown[]>(row.probabilities as string | null, []),
    }));
  } catch {
    jevChecks = [];
  }

  const offerRow = offer as Record<string, unknown>;
  return c.json({
    ...offerRow,
    attributes: parseJsonField(offerRow.attributes as string | null, {}),
    hunt_associations: huntAssociations,
    evaluations: parsedEvaluations,
    alerts,
    jev_checks: jevChecks,
  });
});

// Price history for offer
offerRoutes.get('/offers/:id/prices', (c) => {
  const id = parseInt(c.req.param('id'));
  const db = getDealDb();

  const prices = db
    .prepare(
      'SELECT * FROM prices WHERE offer_id = ? ORDER BY observed_at ASC',
    )
    .all(id);

  return c.json(prices);
});

// Toggle watching / update watch conditions
offerRoutes.put('/offers/:id/watch', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const db = getDealDb();

  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.watching !== undefined) {
    sets.push('watching = ?');
    params.push(body.watching ? 1 : 0);
  }
  if (body.watch_conditions !== undefined) {
    sets.push('watch_conditions = ?');
    params.push(
      typeof body.watch_conditions === 'string'
        ? body.watch_conditions
        : JSON.stringify(body.watch_conditions),
    );
  }

  if (sets.length > 0) {
    params.push(id);
    db.prepare(`UPDATE offers SET ${sets.join(', ')} WHERE id = ?`).run(
      ...params,
    );
  }

  // Also update hunt_offers status
  if (body.watching !== undefined && body.hunt_id) {
    const newStatus = body.watching ? 'watching' : 'evaluated';
    db.prepare(
      'UPDATE hunt_offers SET status = ? WHERE offer_id = ? AND hunt_id = ?',
    ).run(newStatus, id, body.hunt_id);
  }

  return c.json({ success: true });
});

// Dismiss offer from hunt
offerRoutes.post('/offers/:id/dismiss', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const db = getDealDb();

  if (!body.hunt_id) {
    return c.json({ error: 'hunt_id required' }, 400);
  }

  db.prepare(
    "UPDATE hunt_offers SET status = 'dismissed' WHERE offer_id = ? AND hunt_id = ?",
  ).run(id, body.hunt_id);

  // If no other hunts are watching this offer, stop watching
  const stillWatching = db
    .prepare(
      "SELECT COUNT(*) as count FROM hunt_offers WHERE offer_id = ? AND status = 'watching'",
    )
    .get(id) as { count: number };

  if (stillWatching.count === 0) {
    db.prepare('UPDATE offers SET watching = 0 WHERE id = ?').run(id);
  }

  return c.json({ success: true });
});

// Refresh a single offer's status from its source
offerRoutes.post('/offers/:id/refresh', async (c) => {
  const id = parseInt(c.req.param('id'));
  const db = getDealDb();

  const offer = db.prepare('SELECT id, source, source_id, status FROM offers WHERE id = ?').get(id) as
    | { id: number; source: string; source_id: string; status: string }
    | undefined;
  if (!offer) return c.json({ error: 'Offer not found' }, 404);
  if (!offer.source_id) return c.json({ error: 'No source ID available' }, 400);

  // AutoTrader fetches are slow (~1.5s) — kick off async, return 202 + refresh_id.
  // Deduplicate: if a refresh is already in-flight for this offer, return the
  // existing refresh_id rather than firing a duplicate AT request (Issue 8).
  if (offer.source === 'autotrader') {
    const existing = activeRefreshByOffer.get(id);
    if (existing) {
      return c.json({ status: 'pending', refresh_id: existing.refreshId }, 202);
    }

    const refreshId = randomUUID();
    const job = checkOfferStatusBySource(offer.source, offer.source_id).then((result) => {
      if (!result.error && (result.status === 'removed' || result.status === 'ended' || result.status === 'sold')) {
        db.prepare("UPDATE offers SET status = ?, last_status_change = datetime('now') WHERE id = ?").run(result.status, id);
      } else if (!result.error) {
        db.prepare("UPDATE offers SET last_seen_at = datetime('now') WHERE id = ?").run(id);
      }
      pendingRefreshJobs.delete(refreshId);
      activeRefreshByOffer.delete(id);
      return result;
    }).catch((err: unknown) => {
      pendingRefreshJobs.delete(refreshId);
      activeRefreshByOffer.delete(id);
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'active' as const, error: msg };
    });

    pendingRefreshJobs.set(refreshId, job);
    activeRefreshByOffer.set(id, { refreshId, promise: job });
    return c.json({ status: 'pending', refresh_id: refreshId }, 202);
  }

  // eBay and other fast sources: synchronous path
  let result;
  try {
    result = await checkOfferStatusBySource(offer.source, offer.source_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 502);
  }

  if (result.error) {
    return c.json({ error: result.error }, 502);
  }

  if (result.status === 'removed' || result.status === 'ended' || result.status === 'sold') {
    db.prepare("UPDATE offers SET status = ?, last_status_change = datetime('now') WHERE id = ?").run(result.status, id);
    return c.json({ status: result.status });
  }

  // Still live — bump last_seen_at
  db.prepare("UPDATE offers SET last_seen_at = datetime('now') WHERE id = ?").run(id);
  return c.json({ status: 'active', refreshed: true });
});

// Poll the result of an async refresh job (for AutoTrader and other slow sources)
offerRoutes.get('/offers/:id/refresh/:refreshId', async (c) => {
  const refreshId = c.req.param('refreshId');
  const job = pendingRefreshJobs.get(refreshId);

  if (!job) {
    // Job not found — either it completed and was cleaned up, or it never existed.
    // The client should re-fetch offer detail to get the updated status.
    return c.json({ status: 'completed' });
  }

  // Check if the promise is settled (non-blocking peek)
  let resolved = false;
  let result: { status: string; error?: string } | undefined;
  await Promise.race([
    job.then((r) => { resolved = true; result = r; }),
    Promise.resolve(),
  ]);

  if (resolved && result) {
    return c.json({ status: result.status, error: result.error });
  }

  return c.json({ status: 'pending' });
});
