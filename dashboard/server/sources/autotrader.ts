/**
 * AutoTrader source adapter for the dashboard.
 * Checks individual car listing status via HTTP GET to the detail page.
 *
 * This is async-friendly: the caller should use the async path (202 + polling)
 * since AT page fetches can take ~1.5s.
 *
 * IMPORTANT — shared rate-limit dependency:
 *   This module imports `rateLimitedFetch` and `isAutoTraderDisabled` from the
 *   watcher's compiled output at:
 *     /opt/nanoclaw/watcher/dist/sources/autotrader/rate-limit.js
 *
 *   Both the watcher process and the dashboard process share the same rate-limit
 *   state file (RATE_LIMIT_STATE_PATH = /opt/nanoclaw/data/rate-limit-state.json),
 *   so all AT requests from both processes are serialised through the same backoff
 *   envelope and the kill switch (AUTOTRADER_DISABLED=1) is honoured here too.
 *
 *   If you add a new AT endpoint to this file, use `rateLimitedFetch` — never raw
 *   `fetch()` — so the cross-process rate-limit contract is maintained.
 *
 *   Rollout note: the watcher must be compiled (`cd watcher && npx tsc`) before
 *   starting the dashboard, otherwise this import will fail at runtime with
 *   ERR_MODULE_NOT_FOUND.
 */

// @ts-ignore — importing from watcher/dist/ (outside rootDir). This is the
// agreed Option A cross-process rate-limit contract; see multi-vertical-rollout.md §Issue-2.
// Uses @ts-ignore (not @ts-expect-error) because whether this import type-errors
// depends on the watcher build shipping declarations (rate-limit.d.ts) — which it
// may or may not, depending on compile order — so the suppression must tolerate
// both the erroring and non-erroring states.
import { rateLimitedFetch, isAutoTraderDisabled } from '/opt/nanoclaw/watcher/dist/sources/autotrader/rate-limit.js';

import type { StatusResult } from './index.js';

const AT_DETAIL_BASE = 'https://www.autotrader.co.uk/car-details';

/**
 * Check the status of an AutoTrader listing.
 * - AUTOTRADER_DISABLED=1 env var → throws with a descriptive error (caller returns 503)
 * - Goes through `rateLimitedFetch` to honour the shared rate-limit and backoff state
 * - 404 response → removed
 * - HTML containing a "sold" banner → sold
 * - otherwise → active
 */
export async function checkOfferStatus(sourceId: string): Promise<StatusResult> {
  // Kill-switch check: AUTOTRADER_DISABLED=1 blocks all dashboard AT requests too.
  if (isAutoTraderDisabled()) {
    throw new Error('AutoTrader integration disabled by AUTOTRADER_DISABLED env var');
  }

  const url = `${AT_DETAIL_BASE}/${encodeURIComponent(sourceId)}`;

  let resp: Response;
  try {
    resp = await (rateLimitedFetch as typeof fetch)(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      // 10s timeout via signal
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'active', error: `Fetch failed: ${msg}` };
  }

  if (resp.status === 404) return { status: 'removed' };

  if (!resp.ok) {
    return { status: 'active', error: `HTTP ${resp.status}` };
  }

  // Check for sold banner in HTML (case-insensitive substring match is cheap and robust)
  try {
    const html = await resp.text();
    const lower = html.toLowerCase();
    if (
      lower.includes('this car has been sold') ||
      lower.includes('"issold":true') ||
      lower.includes('"sold":true') ||
      lower.includes('data-gui="advert-sold"')
    ) {
      return { status: 'sold' };
    }
  } catch {
    return { status: 'active', error: 'Failed to read response body' };
  }

  return { status: 'active' };
}
