/**
 * AutoTrader source adapter — HTTP-only implementation.
 *
 * Implements SourceAdapter using:
 *   - search(): POST /at-gateway (GraphQL) → NormalisedListing[]
 *   - fetchDetail(): GET /car-details/<id> → enriched NormalisedListing (price tier etc.)
 *   - getState(): GET /car-details/<id> → active / removed / sold + updated price/tier
 *
 * All requests go through the rate-limit guard in rate-limit.ts (6s ± 30% jitter).
 */

import { registerAdapter } from '../index.js';
import type {
  SourceAdapter,
  SearchOutcome,
  DetailOutcome,
  StateOutcome,
} from '../types.js';
import type { AutotraderSearchParams } from './types.js';
import { searchAutotrader } from './search.js';
import { fetchDetailPage, getListingState } from './detail.js';
import { AutoTraderDisabledError, BASE_INTERVAL_MS } from './rate-limit.js';

class AutoTraderAdapter implements SourceAdapter {
  readonly id = 'autotrader';
  readonly capabilities = {
    hasAuctions: false,
    richSearch: false,
    // Cars are bought on attributes that only the detail page carries (mileage, fuel,
    // transmission, body type, price tier). The search row alone is too sparse for the
    // notifications/dashboard, so the watcher's enrichment block calls fetchDetail() for
    // new listings. This is rate-safe: the scheduler caps detail fetches per tick
    // (MAX_DETAIL_FETCHES_PER_TICK) and cars only poll every few hours. The agent can
    // still pull the detail page on demand via the autotrader_detail MCP tool for survivors.
    needsDetailFetch: true,
  };
  /** 6 000 ms base; actual intervals are ± 30% jitter applied inside rate-limit.ts */
  readonly minIntervalMs = BASE_INTERVAL_MS;

  async search(nativeParams: unknown): Promise<SearchOutcome> {
    const params = nativeParams as AutotraderSearchParams;
    try {
      return await searchAutotrader(params);
    } catch (err) {
      if (err instanceof AutoTraderDisabledError) {
        return {
          listings: [],
          apiCalls: 0,
          errors: [{ scope: 'disabled', error: err.message }],
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        listings: [],
        apiCalls: 0,
        errors: [{ scope: 'search', error: msg }],
      };
    }
  }

  async fetchDetail(sourceId: string): Promise<DetailOutcome> {
    try {
      return await fetchDetailPage(sourceId);
    } catch (err) {
      if (err instanceof AutoTraderDisabledError) {
        return { listing: null, apiCalls: 0, error: err.message };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { listing: null, apiCalls: 1, error: msg };
    }
  }

  async getState(sourceId: string): Promise<StateOutcome> {
    try {
      const result = await getListingState(sourceId);
      return {
        status: result.status,
        priceGbp: result.priceGbp ?? undefined,
        attributes: result.attributes,
        apiCalls: result.apiCalls,
        error: result.error,
      };
    } catch (err) {
      if (err instanceof AutoTraderDisabledError) {
        return { status: 'active', apiCalls: 0, error: err.message };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'active', apiCalls: 1, error: msg };
    }
  }
}

const autotraderAdapter = new AutoTraderAdapter();
registerAdapter(autotraderAdapter);

export { autotraderAdapter };
export type { AutotraderSearchParams } from './types.js';
