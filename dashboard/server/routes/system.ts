import { Hono } from 'hono';
import { getDealDb, getNanoclawDb } from '../db.js';
import { DAILY_API_BUDGET } from '../config.js';

export const systemRoutes = new Hono();

systemRoutes.get('/system/health', (c) => {
  const dealDb = getDealDb();

  // Watcher status: last search timestamp
  const lastSearch = dealDb
    .prepare('SELECT MAX(searched_at) as last_search FROM search_queries')
    .get() as { last_search: string | null } | undefined;

  // API budget: searches today
  const searchesToday = dealDb
    .prepare(
      "SELECT COUNT(*) as count FROM search_queries WHERE searched_at >= date('now')",
    )
    .get() as { count: number };

  // Watcher status logic
  let watcherStatus: 'running' | 'slow' | 'stale' = 'stale';
  if (lastSearch?.last_search) {
    const lastSearchTime = new Date(lastSearch.last_search + 'Z').getTime();
    const ageMs = Date.now() - lastSearchTime;
    if (ageMs < 2 * 60 * 60_000) watcherStatus = 'running';
    else if (ageMs < 5 * 60 * 60_000) watcherStatus = 'slow';
  }

  // Last agent run from nanoclaw.db
  let agentData: {
    last_run: string | null;
    last_duration_ms: number | null;
    last_status: string | null;
  } = { last_run: null, last_duration_ms: null, last_status: null };

  try {
    const nanoclawDb = getNanoclawDb();
    const lastRun = nanoclawDb
      .prepare(
        'SELECT run_at, duration_ms, status FROM task_run_logs ORDER BY run_at DESC LIMIT 1',
      )
      .get() as
      | { run_at: string; duration_ms: number; status: string }
      | undefined;
    if (lastRun) {
      agentData = {
        last_run: lastRun.run_at,
        last_duration_ms: lastRun.duration_ms,
        last_status: lastRun.status,
      };
    }
  } catch {
    // nanoclaw.db may not exist or be accessible
  }

  // Search schedule per hunt
  const searchSchedule = dealDb
    .prepare(
      `SELECT h.id as hunt_id, h.name as hunt_name, h.cadence_minutes, h.status,
        (SELECT MAX(searched_at) FROM search_queries WHERE hunt_id = h.id) as last_search
      FROM hunts h
      WHERE h.status = 'active'
      ORDER BY h.name`,
    )
    .all() as Array<{
    hunt_id: number;
    hunt_name: string;
    cadence_minutes: number;
    status: string;
    last_search: string | null;
  }>;

  // Daily API usage (last 7 days)
  const dailyUsage = dealDb
    .prepare(
      `SELECT date(searched_at) as day, COUNT(*) as search_count
      FROM search_queries
      WHERE searched_at >= datetime('now', '-7 days')
      GROUP BY day
      ORDER BY day`,
    )
    .all() as Array<{ day: string; search_count: number }>;

  // Recent errors from task_run_logs
  let recentErrors: Array<Record<string, unknown>> = [];
  try {
    const nanoclawDb = getNanoclawDb();
    recentErrors = nanoclawDb
      .prepare(
        "SELECT * FROM task_run_logs WHERE status = 'failed' ORDER BY run_at DESC LIMIT 20",
      )
      .all() as Array<Record<string, unknown>>;
  } catch {}

  return c.json({
    watcher: {
      status: watcherStatus,
      last_search: lastSearch?.last_search || null,
    },
    api: {
      searches_today: searchesToday.count,
      budget: DAILY_API_BUDGET,
    },
    agent: agentData,
    search_schedule: searchSchedule,
    daily_usage: dailyUsage,
    recent_errors: recentErrors,
  });
});
