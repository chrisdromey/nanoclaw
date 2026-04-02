import { Hono } from 'hono';
import { getDealDb } from '../db.js';

export const baselineRoutes = new Hono();

// List segments for a hunt with aggregate stats
baselineRoutes.get('/hunts/:id/segments', (c) => {
  const db = getDealDb();
  const huntId = parseInt(c.req.param('id'));

  const segments = db
    .prepare(
      `SELECT ms.*,
        COALESCE(bp.data_point_count, 0) as data_point_count,
        COALESCE(bp.sold_count, 0) as sold_count,
        COALESCE(bp.active_count, 0) as active_count,
        bp.earliest_data,
        bp.latest_data
      FROM market_segments ms
      LEFT JOIN (
        SELECT segment_id,
          COUNT(*) as data_point_count,
          SUM(CASE WHEN source_type = 'sold' THEN 1 ELSE 0 END) as sold_count,
          SUM(CASE WHEN source_type = 'active' THEN 1 ELSE 0 END) as active_count,
          MIN(observed_at) as earliest_data,
          MAX(observed_at) as latest_data
        FROM baseline_prices
        GROUP BY segment_id
      ) bp ON bp.segment_id = ms.id
      WHERE ms.hunt_id = ?
      ORDER BY ms.created_at ASC`,
    )
    .all(huntId);

  return c.json(segments);
});

// Baseline prices for a specific segment
baselineRoutes.get('/hunts/:id/segments/:segmentId/prices', (c) => {
  const db = getDealDb();
  const huntId = parseInt(c.req.param('id'));
  const segmentId = parseInt(c.req.param('segmentId'));

  const prices = db
    .prepare(
      `SELECT * FROM baseline_prices
      WHERE segment_id = ? AND hunt_id = ?
      ORDER BY COALESCE(total_landed_gbp, price) ASC`,
    )
    .all(segmentId, huntId);

  return c.json(prices);
});

// Combined baseline view: segments + active offer prices for overlay
baselineRoutes.get('/hunts/:id/baseline', (c) => {
  const db = getDealDb();
  const huntId = parseInt(c.req.param('id'));

  const segments = db
    .prepare(
      `SELECT ms.*,
        COALESCE(bp.data_point_count, 0) as data_point_count,
        COALESCE(bp.sold_count, 0) as sold_count,
        COALESCE(bp.active_count, 0) as active_count,
        bp.earliest_data,
        bp.latest_data
      FROM market_segments ms
      LEFT JOIN (
        SELECT segment_id,
          COUNT(*) as data_point_count,
          SUM(CASE WHEN source_type = 'sold' THEN 1 ELSE 0 END) as sold_count,
          SUM(CASE WHEN source_type = 'active' THEN 1 ELSE 0 END) as active_count,
          MIN(observed_at) as earliest_data,
          MAX(observed_at) as latest_data
        FROM baseline_prices
        GROUP BY segment_id
      ) bp ON bp.segment_id = ms.id
      WHERE ms.hunt_id = ?
      ORDER BY ms.created_at ASC`,
    )
    .all(huntId);

  const unclassified = db
    .prepare(
      'SELECT COUNT(*) as count FROM baseline_prices WHERE hunt_id = ? AND segment_id IS NULL',
    )
    .get(huntId) as { count: number };

  // Current active watched offer prices for overlay comparison
  const activeOfferPrices = db
    .prepare(
      `SELECT o.id as offer_id, o.title, o.condition,
        (SELECT COALESCE(p.total_landed_gbp, p.price)
         FROM prices p WHERE p.offer_id = o.id
         ORDER BY p.observed_at DESC LIMIT 1) as current_price
      FROM offers o
      JOIN hunt_offers ho ON ho.offer_id = o.id AND ho.hunt_id = ?
      WHERE o.status = 'active' AND ho.status != 'dismissed'
      ORDER BY current_price ASC`,
    )
    .all(huntId);

  return c.json({
    segments,
    unclassified_count: unclassified.count,
    active_offer_prices: activeOfferPrices,
  });
});
