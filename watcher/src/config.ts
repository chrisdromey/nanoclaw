import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(PROJECT_ROOT, '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  const wanted = new Set(keys);
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }
  return result;
}

const env = readEnvFile(['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'TYPESAFE_API_KEY', 'JEV_MODEL', 'JEV_ENABLED']);

export const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || env.EBAY_CLIENT_ID || '';
export const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || env.EBAY_CLIENT_SECRET || '';
export const EBAY_MARKETPLACE = 'EBAY_GB';

// TypeSafe Jev (System One) — see docs/delhunter/jev-integration-handoff.md.
// Pinned to a versioned model so tuned thresholds don't drift when `jev-latest` moves.
export const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || env.TYPESAFE_API_KEY || '';
export const JEV_MODEL = process.env.JEV_MODEL || env.JEV_MODEL || 'jev-1.13.0';
export const JEV_ENABLED = (process.env.JEV_ENABLED ?? env.JEV_ENABLED ?? '1') !== '0' && TYPESAFE_API_KEY !== '';

export const DB_PATH = path.join(PROJECT_ROOT, 'groups/telegram_main/deal-hunter.db');
export const IPC_DIR = path.join(PROJECT_ROOT, 'data/ipc/telegram_main');
export const CHAT_JID = process.env.CHAT_JID || 'tg:6767009477';

function intFromEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return isNaN(n) ? fallback : n;
}

// Timing
export const SCHEDULER_TICK_MS = 30_000;         // Check hunts every 30s
export const TOKEN_REFRESH_MS = 5_400_000;        // Refresh OAuth token every 90min
export const WATCH_CADENCE_MS = 2 * 60 * 60_000;  // Check watched offers every 2h
export const AUCTION_THRESHOLDS = [24, 12, 6];    // Graduated auction countdown thresholds (hours, descending)
export const STALENESS_SWEEP_CADENCE_MS = 4 * 60 * 60_000; // Sweep stale offers every 4h
export const STALE_OFFER_HOURS = 24;              // Offers unseen for 24h are considered stale
export const DAILY_API_BUDGET = 4500;             // Stop at 4500 (limit is 5000/day)
export const SEARCH_LIMIT_PER_FORMAT = 50;

// Price-change materiality gate (handoff #1A). A watched offer's price move only triggers a
// re-evaluation when it is at least this % OR this many £ away from the price the agent last
// judged. Smaller moves are still recorded in `prices`, just not announced.
export const PRICE_CHANGE_MIN_PCT = Math.max(0, intFromEnv('PRICE_CHANGE_MIN_PCT', 3));
const PRICE_CHANGE_MIN_GBP_DEFAULTS: Record<string, number> = { cars: 250, computers: 10 };
export function priceChangeMinGbp(vertical: string | null): number {
  const v = vertical ?? '';
  return Math.max(0, intFromEnv(`PRICE_CHANGE_MIN_GBP_${v.toUpperCase()}`, PRICE_CHANGE_MIN_GBP_DEFAULTS[v] ?? 10));
}

// New-offer triage queue management (token-burn protection).
// All values are clamped to sane minimums — a zero/negative env override would otherwise
// silently disable notifications (cap=0) or flush the whole queue every sweep (days=0).
//
// Queued (hunt_offers.status='new') offers of ACTIVE monitored hunts older than this are
// auto-dismissed as stale — after a long watcher outage the backlog is mostly dead
// listings, and triaging weeks of history in one agent run is the single biggest token
// sink we've observed. Paused/draft hunts' queues are frozen, not flushed.
export const STALE_QUEUE_DAYS = Math.max(1, intFromEnv('STALE_QUEUE_DAYS', 7));
// Hard cap on how many queued offers a single agent triage run is asked to evaluate,
// summed across all hunts in one notification. The remainder stays status='new' and
// drains on subsequent ticks.
export const MAX_TRIAGE_BATCH_PER_RUN = Math.max(1, intFromEnv('MAX_TRIAGE_BATCH_PER_RUN', 40));
// How often to check for (and announce) a leftover backlog when no fresh offers arrived.
export const TRIAGE_DRAIN_CADENCE_MS = Math.max(60_000, intFromEnv('TRIAGE_DRAIN_CADENCE_MINUTES', 30) * 60_000);
// Don't re-announce a hunt whose pending queue hasn't changed since its last announcement
// until this much time has passed — a sub-agent that fails to triage a batch must not be
// re-spawned every drain tick (that would be a token leak of its own).
export const TRIAGE_REANNOUNCE_BACKOFF_MS = Math.max(
  60_000,
  intFromEnv('TRIAGE_REANNOUNCE_BACKOFF_MINUTES', 240) * 60_000,
);
