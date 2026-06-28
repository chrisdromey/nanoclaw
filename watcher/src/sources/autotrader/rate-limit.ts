/**
 * Rate-limit guard for all AutoTrader HTTP requests.
 *
 * Enforces:
 *   - Minimum interval between requests: minIntervalMs ± 30% jitter
 *   - Exponential backoff on 429, 503, or cf-mitigated responses
 *   - Backoff state persisted to disk so restarts don't bypass it
 *   - Kill switch: AUTOTRADER_DISABLED=1 → throws AutoTraderDisabledError
 *
 * Cross-process contract (Issue 2):
 *   The dashboard imports from the watcher's compiled dist/:
 *     import { rateLimitedFetch, isAutoTraderDisabled, RATE_LIMIT_STATE_PATH }
 *       from '/opt/nanoclaw/watcher/dist/sources/autotrader/rate-limit.js';
 *   Both processes share the same state file at RATE_LIMIT_STATE_PATH.
 *   Option A (shared compiled module) is chosen — see multi-vertical-rollout.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// ─── Kill switch ────────────────────────────────────────────────────────────

export class AutoTraderDisabledError extends Error {
  constructor() {
    super('AutoTrader adapter is disabled (AUTOTRADER_DISABLED=1)');
    this.name = 'AutoTraderDisabledError';
  }
}

/** Returns true when AUTOTRADER_DISABLED=1 is set in the environment. Exported for Fix-D / dashboard. */
export function isAutoTraderDisabled(): boolean {
  return process.env.AUTOTRADER_DISABLED === '1';
}

// ─── State ──────────────────────────────────────────────────────────────────

/**
 * Absolute path to the persisted rate-limit state file. Exported for Fix-D / dashboard use.
 * Overridable via AUTOTRADER_RATE_LIMIT_STATE_PATH (defaults to the shared path the
 * dashboard also imports — both processes must agree on this location).
 */
export const RATE_LIMIT_STATE_PATH = path.resolve(
  process.env.AUTOTRADER_RATE_LIMIT_STATE_PATH || '/opt/nanoclaw/data/rate-limit-state.json',
);

const BASE_INTERVAL_MS = 6_000;

interface RateLimitState {
  lastCallAt: number;            // epoch ms
  backoffUntil: number;          // epoch ms — 0 means no backoff
  backoffStep: number;           // current backoff multiplier (doubles each hit)
}

let state: RateLimitState = {
  lastCallAt: 0,
  backoffUntil: 0,
  backoffStep: 0,
};

// Load persisted state at module import time
function loadState(): void {
  if (!fs.existsSync(RATE_LIMIT_STATE_PATH)) {
    // No state file yet — first run, start fresh silently
    return;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(RATE_LIMIT_STATE_PATH, 'utf8');
  } catch (err) {
    // Read error (e.g. permissions) — start fresh
    process.stderr.write(
      `[autotrader-rate-limit] WARN: Could not read state file ${RATE_LIMIT_STATE_PATH}: ${String(err)} — starting fresh\n`,
    );
    return;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RateLimitState>;
    state = {
      lastCallAt: parsed.lastCallAt ?? 0,
      backoffUntil: parsed.backoffUntil ?? 0,
      backoffStep: parsed.backoffStep ?? 0,
    };
  } catch (err) {
    // JSON parse error — log a warning but do NOT overwrite the file; leave it for inspection
    process.stderr.write(
      `[autotrader-rate-limit] WARN: State file ${RATE_LIMIT_STATE_PATH} contains invalid JSON (${String(err)}) — starting fresh without overwriting\n`,
    );
  }
}

function saveState(): void {
  try {
    const dir = path.dirname(RATE_LIMIT_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RATE_LIMIT_STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // Non-fatal — we still function, just won't persist state
  }
}

loadState();

// ─── Jitter ─────────────────────────────────────────────────────────────────

function jitteredInterval(baseMs: number = BASE_INTERVAL_MS): number {
  // ±30% random jitter
  return Math.round(baseMs * (0.7 + Math.random() * 0.6));
}

// ─── Backoff ────────────────────────────────────────────────────────────────

// Backoff sequence (60s * 2^(step-1)): 60s, 120s, 240s, 480s, 960s, 1920s, … capped at 3600s (1h)
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 3_600_000;

function enterBackoff(reason: string): void {
  const step = state.backoffStep + 1;
  const durationMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, step - 1), BACKOFF_CAP_MS);
  const until = Date.now() + durationMs;
  state = { ...state, backoffUntil: until, backoffStep: step };
  saveState();
  const untilStr = new Date(until).toISOString();
  process.stderr.write(
    `[autotrader-rate-limit] BACKOFF_START reason=${reason} step=${step} duration=${durationMs}ms until=${untilStr}\n`
  );
}

function clearBackoff(): void {
  if (state.backoffStep > 0) {
    process.stderr.write(`[autotrader-rate-limit] BACKOFF_END step=${state.backoffStep}\n`);
  }
  state = { ...state, backoffUntil: 0, backoffStep: 0 };
  saveState();
}

// ─── Main guard ─────────────────────────────────────────────────────────────

/**
 * Promise-chain mutex. Each call appends its ENTIRE critical section
 * (wait → fetch → record completion/backoff) to the chain, so the next queued
 * request does not begin its wait until the previous request's fetch has fully
 * settled and any backoff has been recorded.
 *
 * Why the previous version was broken (Fix 3):
 *   Only `waitForJitteredInterval()` was chained; the real `fetch()` ran AFTER
 *   acquireSlot() resolved, outside the chain. So a slow response from request N
 *   would overlap request N+1's wait/fetch, and a 429 backoff entered by request N
 *   was recorded too late to protect the already-running request N+1.
 *
 * The fix: `runCriticalSection()` (wait + fetch + backoff bookkeeping) is the unit
 * appended to the chain. Errors in one link don't break the chain — `inflightChain`
 * swallows rejections so subsequent callers still get their turn.
 */
let inflightChain: Promise<unknown> = Promise.resolve();

/** Wait for one jittered interval, honouring any active backoff. */
async function waitForJitteredInterval(): Promise<void> {
  // Check for active backoff
  const now = Date.now();
  if (state.backoffUntil > now) {
    const wait = state.backoffUntil - now;
    process.stderr.write(`[autotrader-rate-limit] waiting for backoff (${wait}ms remaining)\n`);
    await sleep(wait);
  }

  // Enforce minimum interval since last call
  const sinceLastCall = Date.now() - state.lastCallAt;
  const interval = jitteredInterval();
  if (state.lastCallAt > 0 && sinceLastCall < interval) {
    await sleep(interval - sinceLastCall);
  }
}

/**
 * The full serialised critical section for one request: wait for the rate-limit
 * slot, perform the fetch, then record completion (lastCallAt) and any backoff.
 */
async function runCriticalSection(url: string, init?: RequestInit): Promise<Response> {
  await waitForJitteredInterval();

  state.lastCallAt = Date.now();
  saveState();

  const res = await fetch(url, init);

  // Detect throttling — recorded before the chain advances to the next caller,
  // so the next request's wait observes the backoff window.
  const cfMitigated = res.headers.get('cf-mitigated');
  if (res.status === 429 || res.status === 503 || cfMitigated) {
    const reason = cfMitigated ? `cf-mitigated=${cfMitigated}` : `HTTP ${res.status}`;
    enterBackoff(reason);
  } else {
    // Successful response — clear backoff
    if (state.backoffStep > 0) clearBackoff();
  }

  return res;
}

/**
 * Wraps an outbound AT HTTP request with rate-limit and backoff enforcement.
 * All requests in search.ts, detail.ts, and getState() must go through this.
 *
 * Exported for Fix-D (dashboard) to import directly from watcher/dist/. See module-level comment.
 */
export async function rateLimitedFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  // Kill switch is checked BEFORE joining the chain so it throws immediately and
  // never occupies a serialisation slot. Callers (index.ts) handle this error
  // with apiCalls:0 and the disabled scope/status.
  if (isAutoTraderDisabled()) throw new AutoTraderDisabledError();

  const run = inflightChain.then(() => runCriticalSection(url, init));
  // Never let one rejection break the chain — subsequent callers must still get their turn.
  inflightChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Exposed for testing — reset in-memory state and the promise chain mutex */
export function _resetStateForTest(overrides: Partial<RateLimitState> = {}): void {
  state = { lastCallAt: 0, backoffUntil: 0, backoffStep: 0, ...overrides };
  inflightChain = Promise.resolve();
}

export { BASE_INTERVAL_MS };
