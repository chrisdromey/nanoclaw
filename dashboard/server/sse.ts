import { getDealDb, getNanoclawDb } from './db.js';

interface SSEState {
  lastSearchId: number;
  lastPriceId: number;
  lastEvalId: number;
  lastHuntOfferAssocAt: string;
  lastTaskRunId: number;
}

let state: SSEState | null = null;

function initState(): SSEState {
  const db = getDealDb();
  const lastSearch = db
    .prepare('SELECT MAX(id) as max_id FROM search_queries')
    .get() as { max_id: number | null };
  const lastPrice = db
    .prepare('SELECT MAX(id) as max_id FROM prices')
    .get() as { max_id: number | null };
  const lastEval = db
    .prepare('SELECT MAX(id) as max_id FROM evaluations')
    .get() as { max_id: number | null };
  const lastAssoc = db
    .prepare('SELECT MAX(first_associated_at) as max_at FROM hunt_offers')
    .get() as { max_at: string | null };

  let lastTaskRunId = 0;
  try {
    const ncDb = getNanoclawDb();
    const lastTask = ncDb
      .prepare('SELECT MAX(id) as max_id FROM task_run_logs')
      .get() as { max_id: number | null };
    lastTaskRunId = lastTask.max_id ?? 0;
  } catch {
    // nanoclaw db may not be accessible
  }

  return {
    lastSearchId: lastSearch.max_id ?? 0,
    lastPriceId: lastPrice.max_id ?? 0,
    lastEvalId: lastEval.max_id ?? 0,
    lastHuntOfferAssocAt: lastAssoc.max_at ?? '1970-01-01',
    lastTaskRunId,
  };
}

export interface SSEEvent {
  type: string;
  data: unknown;
}

export function pollForChanges(): SSEEvent[] {
  if (!state) state = initState();

  const db = getDealDb();
  const events: SSEEvent[] = [];

  // New searches
  const newSearches = db
    .prepare(
      `SELECT sq.*, h.name as hunt_name FROM search_queries sq
      JOIN hunts h ON h.id = sq.hunt_id
      WHERE sq.id > ?
      ORDER BY sq.id ASC`,
    )
    .all(state.lastSearchId) as Array<Record<string, unknown>>;

  for (const s of newSearches) {
    events.push({ type: 'search_completed', data: s });
    state.lastSearchId = s.id as number;
  }

  // New prices
  const newPrices = db
    .prepare(
      `SELECT p.*, o.title as offer_title, o.watching
      FROM prices p
      JOIN offers o ON o.id = p.offer_id
      WHERE p.id > ?
      ORDER BY p.id ASC`,
    )
    .all(state.lastPriceId) as Array<Record<string, unknown>>;

  for (const p of newPrices) {
    events.push({ type: 'price_change', data: p });
    state.lastPriceId = p.id as number;
  }

  // New evaluations
  const newEvals = db
    .prepare(
      `SELECT e.*, o.title as offer_title, h.name as hunt_name
      FROM evaluations e
      JOIN offers o ON o.id = e.offer_id
      JOIN hunts h ON h.id = e.hunt_id
      WHERE e.id > ?
      ORDER BY e.id ASC`,
    )
    .all(state.lastEvalId) as Array<Record<string, unknown>>;

  for (const e of newEvals) {
    events.push({ type: 'new_evaluation', data: e });
    state.lastEvalId = e.id as number;
  }

  // New offers (hunt_offers associations)
  const newOffers = db
    .prepare(
      `SELECT ho.hunt_id, ho.offer_id, ho.status, ho.first_associated_at,
        o.title as offer_title, h.name as hunt_name
      FROM hunt_offers ho
      JOIN offers o ON o.id = ho.offer_id
      JOIN hunts h ON h.id = ho.hunt_id
      WHERE ho.first_associated_at > ?
      ORDER BY ho.first_associated_at ASC`,
    )
    .all(state.lastHuntOfferAssocAt) as Array<Record<string, unknown>>;

  for (const o of newOffers) {
    events.push({ type: 'new_offers', data: o });
    state.lastHuntOfferAssocAt = o.first_associated_at as string;
  }

  // Agent invocations (from nanoclaw.db)
  try {
    const ncDb = getNanoclawDb();
    const newTasks = ncDb
      .prepare(
        `SELECT * FROM task_run_logs WHERE id > ? ORDER BY id ASC`,
      )
      .all(state.lastTaskRunId) as Array<Record<string, unknown>>;

    for (const t of newTasks) {
      events.push({ type: 'agent_invocation', data: t });
      state.lastTaskRunId = t.id as number;
    }
  } catch {
    // nanoclaw db may not be accessible — skip silently
  }

  return events;
}
