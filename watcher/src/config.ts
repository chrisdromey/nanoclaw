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

const env = readEnvFile(['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET']);

export const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || env.EBAY_CLIENT_ID || '';
export const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || env.EBAY_CLIENT_SECRET || '';
export const EBAY_MARKETPLACE = 'EBAY_GB';

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

// New-offer triage queue management (token-burn protection).
// Queued (hunt_offers.status='new') offers older than this are auto-dismissed as stale —
// after a long watcher outage the backlog is mostly dead listings, and triaging weeks of
// history in one agent run is the single biggest token sink we've observed.
export const STALE_QUEUE_DAYS = intFromEnv('STALE_QUEUE_DAYS', 7);
// Hard cap on how many queued offers a single agent triage run is asked to evaluate,
// summed across all hunts in one notification. The remainder stays status='new' and
// drains on subsequent ticks.
export const MAX_TRIAGE_BATCH_PER_RUN = intFromEnv('MAX_TRIAGE_BATCH_PER_RUN', 40);
// How often to check for (and announce) a leftover backlog when no fresh offers arrived.
export const TRIAGE_DRAIN_CADENCE_MS = intFromEnv('TRIAGE_DRAIN_CADENCE_MINUTES', 30) * 60_000;
