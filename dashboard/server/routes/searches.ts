import { Hono } from 'hono';
import { getDealDb } from '../db.js';

export const searchRoutes = new Hono();

searchRoutes.get('/searches/effectiveness', (c) => {
  const db = getDealDb();
  const huntId = c.req.query('hunt_id');

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (huntId) {
    conditions.push('sq.hunt_id = ?');
    params.push(parseInt(huntId));
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Aggregate stats per term+hunt
  const aggregates = db
    .prepare(
      `SELECT sq.terms, sq.hunt_id, h.name as hunt_name,
        COUNT(*) as total_searches,
        SUM(sq.result_count) as total_results,
        SUM(sq.new_offer_count) as total_new_offers,
        ROUND(AVG(sq.new_offer_count), 2) as avg_new_per_search,
        MAX(sq.searched_at) as last_searched
      FROM search_queries sq
      JOIN hunts h ON h.id = sq.hunt_id
      ${whereClause}
      GROUP BY sq.terms, sq.hunt_id
      ORDER BY total_new_offers DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  // Get sparkline data (last 10 per term) and stale detection
  const termData = aggregates.map((agg) => {
    const recent = db
      .prepare(
        `SELECT new_offer_count FROM search_queries
        WHERE terms = ? AND hunt_id = ?
        ORDER BY searched_at DESC
        LIMIT 10`,
      )
      .all(agg.terms, agg.hunt_id) as Array<{ new_offer_count: number }>;

    const sparkline = recent.map((r) => r.new_offer_count).reverse();
    const lastFive = recent.slice(0, 5);
    const stale =
      lastFive.length >= 5 && lastFive.every((r) => r.new_offer_count === 0);

    return { ...agg, sparkline, stale };
  });

  return c.json({ data: termData });
});

searchRoutes.get('/searches', (c) => {
  const db = getDealDb();
  const page = parseInt(c.req.query('page') || '1');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const huntId = c.req.query('hunt_id');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (huntId) {
    conditions.push('sq.hunt_id = ?');
    params.push(parseInt(huntId));
  }
  if (from) {
    conditions.push('sq.searched_at >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('sq.searched_at <= ?');
    params.push(to);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = db
    .prepare(
      `SELECT COUNT(*) as count FROM search_queries sq ${whereClause}`,
    )
    .get(...params) as { count: number };

  const searches = db
    .prepare(
      `SELECT sq.*, h.name as hunt_name
      FROM search_queries sq
      JOIN hunts h ON h.id = sq.hunt_id
      ${whereClause}
      ORDER BY sq.searched_at DESC
      LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  return c.json({ data: searches, total: total.count, page, limit });
});

searchRoutes.get('/evaluations', (c) => {
  const db = getDealDb();
  const page = parseInt(c.req.query('page') || '1');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const huntId = c.req.query('hunt_id');
  const decision = c.req.query('decision');
  const search = c.req.query('search');
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (huntId) {
    conditions.push('e.hunt_id = ?');
    params.push(parseInt(huntId));
  }
  if (decision) {
    conditions.push('e.decision = ?');
    params.push(decision);
  }
  if (search) {
    conditions.push('e.reasoning LIKE ?');
    params.push(`%${search}%`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = db
    .prepare(
      `SELECT COUNT(*) as count FROM evaluations e ${whereClause}`,
    )
    .get(...params) as { count: number };

  const evaluations = db
    .prepare(
      `SELECT e.*, o.title as offer_title, h.name as hunt_name
      FROM evaluations e
      JOIN offers o ON o.id = e.offer_id
      JOIN hunts h ON h.id = e.hunt_id
      ${whereClause}
      ORDER BY e.evaluated_at DESC
      LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  // Decision distribution
  const distribution = db
    .prepare(
      `SELECT decision, COUNT(*) as count FROM evaluations e ${whereClause} GROUP BY decision`,
    )
    .all(...params) as Array<{ decision: string; count: number }>;

  // Daily trend (last 30 days)
  const trend = db
    .prepare(
      `SELECT date(evaluated_at) as day, decision, COUNT(*) as count
      FROM evaluations
      WHERE evaluated_at >= datetime('now', '-30 days')
      GROUP BY day, decision
      ORDER BY day`,
    )
    .all() as Array<{ day: string; decision: string; count: number }>;

  return c.json({
    data: evaluations,
    total: total.count,
    page,
    limit,
    distribution: Object.fromEntries(
      distribution.map((d) => [d.decision, d.count]),
    ),
    trend,
  });
});
