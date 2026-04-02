import { Hono } from 'hono';
import { getDealDb } from '../db.js';

export const overviewRoutes = new Hono();

overviewRoutes.get('/dashboard/overview', (c) => {
  const db = getDealDb();

  // Active hunts with pipeline counts
  const hunts = db
    .prepare(
      `SELECT h.*,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'new') as new_count,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'evaluated') as evaluated_count,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'watching') as watching_count,
        (SELECT COUNT(*) FROM hunt_offers ho WHERE ho.hunt_id = h.id AND ho.status = 'dismissed') as dismissed_count
      FROM hunts h
      WHERE h.status IN ('active', 'paused')
      ORDER BY CASE h.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 END, h.created_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  // Per-hunt price ranges (latest price for watching offers)
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

  // Per-hunt last search
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

  // Merge hunt data
  const enrichedHunts = hunts.map((h) => {
    const id = h.id as number;
    const prices = priceMap.get(id);
    const search = searchMap.get(id);
    return {
      ...h,
      min_price: prices?.min_price ?? null,
      max_price: prices?.max_price ?? null,
      last_searched: search?.last_searched ?? null,
      last_result_count: search?.last_result_count ?? null,
      last_new_count: search?.last_new_count ?? null,
    };
  });

  // Quick stats
  const activeOffers = db
    .prepare("SELECT COUNT(*) as count FROM offers WHERE status = 'active'")
    .get() as { count: number };
  const watchingCount = db
    .prepare('SELECT COUNT(*) as count FROM offers WHERE watching = 1')
    .get() as { count: number };
  const searchesToday = db
    .prepare(
      "SELECT COUNT(*) as count FROM search_queries WHERE searched_at >= date('now')",
    )
    .get() as { count: number };
  const evalsToday = db
    .prepare(
      "SELECT COUNT(*) as count FROM evaluations WHERE evaluated_at >= date('now')",
    )
    .get() as { count: number };

  // Attention items
  const auctionsEndingSoon = db
    .prepare(
      `SELECT COUNT(*) as count FROM offers
      WHERE watching = 1 AND auction_end_time IS NOT NULL
        AND auction_end_time <= datetime('now', '+24 hours')
        AND status = 'active'`,
    )
    .get() as { count: number };
  const unevaluated = db
    .prepare(
      "SELECT COUNT(*) as count FROM hunt_offers WHERE status = 'new'",
    )
    .get() as { count: number };

  // Recent activity (last 10 mixed events)
  const recentActivity = db
    .prepare(
      `SELECT * FROM (
        SELECT 'search' as type,
          'Searched "' || sq.terms || '" — ' || sq.new_offer_count || ' new' as description,
          sq.searched_at as timestamp,
          h.name as hunt_name
        FROM search_queries sq
        JOIN hunts h ON h.id = sq.hunt_id
        ORDER BY sq.searched_at DESC
        LIMIT 5
      )
      UNION ALL
      SELECT * FROM (
        SELECT 'evaluation' as type,
          'Evaluated ' || o.title || ' → ' || e.decision as description,
          e.evaluated_at as timestamp,
          h.name as hunt_name
        FROM evaluations e
        JOIN offers o ON o.id = e.offer_id
        JOIN hunts h ON h.id = e.hunt_id
        ORDER BY e.evaluated_at DESC
        LIMIT 5
      )
      UNION ALL
      SELECT * FROM (
        SELECT 'alert' as type,
          a.urgency || ': ' || COALESCE(o.title, 'Unknown') as description,
          a.alerted_at as timestamp,
          h.name as hunt_name
        FROM alerts a
        JOIN offers o ON o.id = a.offer_id
        JOIN hunts h ON h.id = a.hunt_id
        ORDER BY a.alerted_at DESC
        LIMIT 5
      )
      ORDER BY timestamp DESC
      LIMIT 10`,
    )
    .all();

  return c.json({
    hunts: enrichedHunts,
    quick_stats: {
      active_offers: activeOffers.count,
      watching_count: watchingCount.count,
      searches_today: searchesToday.count,
      evaluations_today: evalsToday.count,
    },
    attention: {
      auctions_ending_soon: auctionsEndingSoon.count,
      price_drops: (
        db
          .prepare(
            `SELECT COUNT(*) as count FROM (
              SELECT o.id,
                (SELECT COALESCE(total_landed_gbp, price) FROM prices WHERE offer_id = o.id ORDER BY observed_at DESC LIMIT 1) as latest,
                (SELECT COALESCE(total_landed_gbp, price) FROM prices WHERE offer_id = o.id ORDER BY observed_at DESC LIMIT 1 OFFSET 1) as previous
              FROM offers o
              WHERE o.watching = 1 AND o.status = 'active'
            ) WHERE latest < previous AND previous IS NOT NULL`,
          )
          .get() as { count: number }
      ).count,
      unevaluated: unevaluated.count,
    },
    recent_activity: recentActivity,
  });
});
