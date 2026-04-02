import { Hono } from 'hono';
import { getDealDb } from '../db.js';

export const offerRoutes = new Hono();

// All watched offers across hunts
offerRoutes.get('/watched', (c) => {
  const db = getDealDb();

  const offers = db
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
    .all();

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
    .all(id);

  const alerts = db
    .prepare(
      `SELECT a.*, h.name as hunt_name
      FROM alerts a
      JOIN hunts h ON h.id = a.hunt_id
      WHERE a.offer_id = ?
      ORDER BY a.alerted_at DESC`,
    )
    .all(id);

  return c.json({
    ...(offer as Record<string, unknown>),
    hunt_associations: huntAssociations,
    evaluations,
    alerts,
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
