/**
 * Per-source dispatcher for offer status checks.
 * Routes to the appropriate source adapter based on offer.source.
 */

import { checkOfferStatus as checkEbay } from './ebay.js';
import { checkOfferStatus as checkAutoTrader } from './autotrader.js';

export interface StatusResult {
  status: 'active' | 'ended' | 'removed' | 'sold';
  error?: string;
}

/**
 * In-memory map of async AT refresh jobs.
 * Key: refresh_id (UUID string)
 * Value: promise resolving to StatusResult
 */
export const pendingRefreshJobs = new Map<string, Promise<StatusResult>>();

/**
 * Dispatch a status check to the appropriate source adapter.
 * Throws if the source is unknown.
 */
export async function checkOfferStatusBySource(
  source: string,
  sourceId: string,
): Promise<StatusResult> {
  switch (source) {
    case 'ebay':
      return checkEbay(sourceId);
    case 'autotrader':
      return checkAutoTrader(sourceId);
    default:
      throw new Error(`Unknown source: ${source}`);
  }
}
