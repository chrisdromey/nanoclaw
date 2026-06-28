/**
 * Main scheduler loop.
 * Manages search polls (per-hunt, per-source cadence) and watch polls (every 2h).
 * All source dispatch goes through the SourceAdapter registry — no hard-coded eBay calls.
 */

// Side-effect: registers the eBay adapter in the registry
import './sources/ebay/index.js';
// Side-effect: registers the AutoTrader adapter in the registry
import './sources/autotrader/index.js';
import type { ItemDetail } from './sources/ebay/types.js';

import type Database from 'better-sqlite3';
import { logger } from './logger.js';
import {
  DAILY_API_BUDGET,
  WATCH_CADENCE_MS,
  STALENESS_SWEEP_CADENCE_MS,
  STALE_OFFER_HOURS,
} from './config.js';
import { getAdapter, hasAdapter } from './sources/index.js';
import { isAuthError, invalidateToken } from './sources/ebay/auth.js';
import { getTranslator } from './translators/index.js';
import { getVertical } from './verticals.js';
import {
  getActiveHunts,
  getWatchedOffers,
  getStaleOffers,
  getLastSearchTime,
  getHunt,
  getHuntIdsForOffer,
  getSegmentCount,
  applyNormalisedResults,
  mergeOfferAttributes,
  updateOfferStatus,
  updateOfferWatchFields,
  recordPrice,
  parseSearchTerms,
  type Hunt,
} from './db.js';
import { detectWatchChanges } from './change-detector.js';
import { sendUrgentNotification, sendNewOffersNotification, sendPriceChangeNotification } from './notifier.js';
import { getNotifiedThresholds, addNotifiedThreshold } from './db.js';

// --- Per-source daily API budget ---

const DEFAULT_BUDGET = DAILY_API_BUDGET;

function getSourceBudget(sourceId: string): number {
  const key = `DAILY_API_BUDGET_${sourceId.toUpperCase()}`;
  const override = process.env[key];
  if (override) {
    const n = parseInt(override, 10);
    if (!isNaN(n)) return n;
  }
  return DEFAULT_BUDGET;
}

export interface SchedulerState {
  lastSearchTime: Map<string, number>;
  lastWatchPollTime: number;
  lastStalenessSweepTime: number;
  /** Per-source daily API call counts, keyed by source id. */
  dailyApiCalls: Map<string, number>;
  dailyApiCallsResetAt: number;
  /**
   * Consecutive failure counter per (huntId:source:terms).
   * Auto-pauses a (hunt, source, terms) after 10 consecutive failures.
   * Resets to 0 on success. Written to search_queries.consecutive_failures in DB on each failure.
   * Format: `${huntId}:${sourceId}:${terms}` → count
   */
  consecutiveFailures: Map<string, number>;
}

function nextMidnight(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function getSourceCalls(state: SchedulerState, sourceId: string): number {
  return state.dailyApiCalls.get(sourceId) ?? 0;
}

function addSourceCalls(state: SchedulerState, sourceId: string, n: number): void {
  state.dailyApiCalls.set(sourceId, getSourceCalls(state, sourceId) + n);
}

/** Seed lastSearchTime from DB so we respect cadence after restart. */
export function initState(db: Database.Database): SchedulerState {
  const state: SchedulerState = {
    lastSearchTime: new Map(),
    lastWatchPollTime: Date.now(),  // defer first watch poll to avoid stale-token errors on restart
    lastStalenessSweepTime: Date.now(),  // defer first sweep similarly
    dailyApiCalls: new Map(),
    dailyApiCallsResetAt: nextMidnight(),
    consecutiveFailures: new Map(),
  };

  const hunts = getActiveHunts(db);
  for (const hunt of hunts) {
    const entries = parseSearchTerms(hunt.search_terms);
    for (const sourceId of hunt.sources) {
      for (const entry of entries) {
        const last = getLastSearchTime(db, hunt.id, sourceId, entry.terms);
        if (last) {
          // Key now includes source to avoid cadence collisions across sources
          state.lastSearchTime.set(`${hunt.id}:${sourceId}:${entry.terms}`, new Date(last).getTime());
        }
      }
    }
  }

  logger.info({ huntCount: hunts.length, seededSearchTimes: state.lastSearchTime.size }, 'Scheduler state initialized');
  return state;
}

const CONSECUTIVE_FAILURE_PAUSE_THRESHOLD = 10;

/** Max detail fetches per tick per hunt (per source with needsDetailFetch). */
const MAX_DETAIL_FETCHES_PER_TICK = (() => {
  const n = parseInt(process.env['MAX_DETAIL_FETCHES_PER_TICK'] ?? '10', 10);
  return isNaN(n) ? 10 : n;
})();

/**
 * Increment consecutive_failures for (huntId, sourceId, terms) in SchedulerState.
 * Also writes the count to the most-recent search_queries row for observability.
 * Returns true if the source should be skipped (paused after 10+ failures).
 * Seam: hunt_source_status table (Phase 4 suggestion) could replace this in-memory tracking.
 */
function recordSourceFailure(
  state: SchedulerState,
  db: Database.Database,
  huntId: number,
  sourceId: string,
  terms: string,
): boolean {
  const key = `${huntId}:${sourceId}:${terms}`;
  const prev = state.consecutiveFailures.get(key) ?? 0;
  const next = prev + 1;
  state.consecutiveFailures.set(key, next);

  // Write to the latest search_queries row for dashboard/log observability
  db.prepare(`
    UPDATE search_queries
    SET consecutive_failures = ?
    WHERE id = (SELECT MAX(id) FROM search_queries WHERE hunt_id = ? AND source = ? AND terms = ?)
  `).run(next, huntId, sourceId, terms);

  if (next >= CONSECUTIVE_FAILURE_PAUSE_THRESHOLD) {
    logger.warn(
      { huntId, sourceId, terms, consecutiveFailures: next },
      'Source auto-paused after 10 consecutive failures — fix the adapter or re-enable manually by restarting the watcher',
    );
    return true;
  }
  return false;
}

/** Reset consecutive_failures after a successful search. */
function clearSourceFailures(
  state: SchedulerState,
  db: Database.Database,
  huntId: number,
  sourceId: string,
  terms: string,
): void {
  const key = `${huntId}:${sourceId}:${terms}`;
  state.consecutiveFailures.set(key, 0);

  // Clear in DB for observability
  db.prepare(`
    UPDATE search_queries
    SET consecutive_failures = 0
    WHERE id = (SELECT MAX(id) FROM search_queries WHERE hunt_id = ? AND source = ? AND terms = ?)
  `).run(huntId, sourceId, terms);
}

/** Returns true if source has been auto-paused (consecutive_failures >= threshold in state). */
function isSourcePaused(state: SchedulerState, huntId: number, sourceId: string, terms: string): boolean {
  const key = `${huntId}:${sourceId}:${terms}`;
  return (state.consecutiveFailures.get(key) ?? 0) >= CONSECUTIVE_FAILURE_PAUSE_THRESHOLD;
}

export async function tick(state: SchedulerState, db: Database.Database): Promise<void> {
  // Reset daily counters at midnight
  if (Date.now() > state.dailyApiCallsResetAt) {
    state.dailyApiCalls = new Map();
    state.dailyApiCallsResetAt = nextMidnight();
  }

  // --- Search polls (batch new offer notifications across the tick) ---
  const hunts = getActiveHunts(db);
  const newOffersByHunt = new Map<number, {
    huntName: string;
    newCount: number;
    vertical: string;
    newListings: import('./sources/types.js').NormalisedListing[];
  }>();

  for (const hunt of hunts) {
    let searchTermEntries;
    try {
      searchTermEntries = parseSearchTerms(hunt.search_terms);
    } catch {
      logger.error({ huntId: hunt.id }, 'Invalid search_terms JSON, skipping hunt');
      continue;
    }

    // Effective poll interval precedence:
    //   per-hunt override → per-vertical default → hunt cadence → 60.
    // Protects slow-moving verticals (e.g. cars=360) from over-polling.
    let verticalDefaultMinutes: number | undefined;
    try {
      verticalDefaultMinutes = getVertical(hunt.vertical).default_poll_minutes;
    } catch (err) {
      logger.warn(
        { huntId: hunt.id, vertical: hunt.vertical, err },
        'Unknown vertical — falling back to cadence_minutes for poll interval',
      );
    }
    const effectiveMinutes =
      hunt.poll_interval_minutes ?? verticalDefaultMinutes ?? hunt.cadence_minutes ?? 60;
    const cadenceMs = effectiveMinutes * 60_000;

    for (const sourceId of hunt.sources) {
      // Per-source budget check
      if (getSourceCalls(state, sourceId) > getSourceBudget(sourceId)) {
        logger.warn({ sourceId, calls: getSourceCalls(state, sourceId) }, 'Daily API budget exceeded for source, skipping');
        continue;
      }

      // Validate adapter is registered
      if (!hasAdapter(sourceId)) {
        logger.error({ sourceId, huntId: hunt.id }, 'No adapter registered for source, skipping');
        continue;
      }
      const adapter = getAdapter(sourceId);

      for (const entry of searchTermEntries) {
        const terms = entry.terms;
        const key = `${hunt.id}:${sourceId}:${terms}`;
        const lastRun = state.lastSearchTime.get(key) ?? 0;

        if (Date.now() - lastRun < cadenceMs) continue;

        // Skip if auto-paused
        if (isSourcePaused(state, hunt.id, sourceId, terms)) {
          logger.warn({ huntId: hunt.id, sourceId, terms }, 'Source paused for this hunt/term — skipping');
          continue;
        }

        try {
          // Load the per-(vertical, source) translator from the registry.
          const translator = getTranslator(hunt.vertical, sourceId);
          if (!translator) {
            logger.warn(
              { huntId: hunt.id, vertical: hunt.vertical, sourceId },
              'No translator registered for vertical/source pair — skipping',
            );
            continue;
          }

          const nativeParams = translator(hunt, terms);
          const outcome = await adapter.search(nativeParams);
          addSourceCalls(state, sourceId, outcome.apiCalls);

          // Issue 9: treat errors with zero listings as a search failure for consecutive_failures.
          if (outcome.errors.length > 0) {
            logger.warn({ huntId: hunt.id, sourceId, terms, errors: outcome.errors }, 'Source search returned errors');
            if (outcome.listings.length === 0) {
              // No listings + errors = silent failure; escalate to consecutive_failures accounting.
              const paused = recordSourceFailure(state, db, hunt.id, sourceId, terms);
              if (paused) {
                logger.warn({ huntId: hunt.id, sourceId }, 'Source auto-paused due to repeated failures (errors with zero listings)');
              }
              state.lastSearchTime.set(key, Date.now());
              continue;
            }
          }

          const { newCount, newSourceIds } = applyNormalisedResults(
            db, hunt.id, sourceId, hunt.vertical, terms, outcome.listings,
          );

          clearSourceFailures(state, db, hunt.id, sourceId, terms);
          state.lastSearchTime.set(key, Date.now());

          // Issue 3: for sources that need detail fetches, enrich new listings.
          if (adapter.capabilities.needsDetailFetch && adapter.fetchDetail && newSourceIds.length > 0) {
            const toFetch = newSourceIds.slice(0, MAX_DETAIL_FETCHES_PER_TICK);
            logger.info(
              { huntId: hunt.id, sourceId, fetchCount: toFetch.length, cap: MAX_DETAIL_FETCHES_PER_TICK },
              'Fetching detail pages for new listings',
            );
            for (const listingSourceId of toFetch) {
              // Each detail fetch counts against the per-source budget.
              if (getSourceCalls(state, sourceId) > getSourceBudget(sourceId)) {
                logger.warn({ sourceId }, 'Daily API budget exceeded during detail fetches, stopping early');
                break;
              }
              try {
                const detail = await adapter.fetchDetail(listingSourceId);
                addSourceCalls(state, sourceId, detail.apiCalls);
                if (!detail.error && detail.listing) {
                  // Merge enriched attributes onto the offer row (don't replace search-level fields).
                  mergeOfferAttributes(db, sourceId, listingSourceId, detail.listing.attributes);
                } else if (detail.error) {
                  logger.warn({ sourceId, listingSourceId, error: detail.error }, 'fetchDetail returned error');
                }
              } catch (detailErr) {
                logger.error({ huntId: hunt.id, sourceId, listingSourceId, detailErr }, 'fetchDetail threw unexpectedly');
              }
            }
          }

          if (newCount > 0) {
            // Collect the actual new listing objects (by sourceId) for the notification formatter.
            const newListingObjs = outcome.listings.filter((l) => newSourceIds.includes(l.sourceId));
            const existing = newOffersByHunt.get(hunt.id);
            if (existing) {
              existing.newCount += newCount;
              existing.newListings.push(...newListingObjs);
            } else {
              newOffersByHunt.set(hunt.id, {
                huntName: hunt.name,
                newCount,
                vertical: hunt.vertical,
                newListings: newListingObjs,
              });
            }
            logger.info({ huntId: hunt.id, huntName: hunt.name, sourceId, terms, newCount, totalCount: outcome.listings.length }, 'New offers found');
          } else {
            logger.debug({ huntId: hunt.id, sourceId, terms, totalCount: outcome.listings.length }, 'Search complete, no new offers');
          }
        } catch (err) {
          if (sourceId === 'ebay' && isAuthError(err)) invalidateToken();
          logger.error({ huntId: hunt.id, sourceId, terms, err }, 'Search failed');
          const paused = recordSourceFailure(state, db, hunt.id, sourceId, terms);
          if (paused) {
            logger.warn({ huntId: hunt.id, sourceId }, 'Source auto-paused due to repeated failures');
          }
        }
      }
    }
  }

  // Send batched new-offer notification (one per tick, not per search term)
  if (newOffersByHunt.size > 0) {
    sendNewOffersNotification(
      Array.from(newOffersByHunt.entries()).map(([huntId, { huntName, newCount, vertical, newListings }]) => ({
        huntId,
        huntName,
        newCount,
        vertical,
        newListings,
        hasBaseline: getSegmentCount(db, huntId) > 0,
      })),
    );
  }

  // --- Watch polls ---
  if (Date.now() - state.lastWatchPollTime < WATCH_CADENCE_MS) return;

  const watchedOffers = getWatchedOffers(db);
  if (watchedOffers.length === 0) {
    state.lastWatchPollTime = Date.now();
    return;
  }

  logger.info({ count: watchedOffers.length }, 'Starting watch poll');

  for (const offer of watchedOffers) {
    const sourceId = offer.source;

    if (!hasAdapter(sourceId)) {
      logger.warn({ offerId: offer.id, sourceId }, 'No adapter registered for offer source, skipping watch');
      continue;
    }

    const adapter = getAdapter(sourceId);

    // Per-source budget check for watch polls
    if (getSourceCalls(state, sourceId) > getSourceBudget(sourceId)) {
      logger.warn({ sourceId }, 'Daily API budget exceeded for source, skipping watch poll');
      continue;
    }

    try {
      const stateOutcome = await adapter.getState(offer.source_id);
      addSourceCalls(state, sourceId, stateOutcome.apiCalls);

      // API error — skip this offer, don't update DB or detect changes
      if (stateOutcome.error) {
        logger.warn({ offerId: offer.id, sourceId: offer.source_id, error: stateOutcome.error }, 'Watch poll API error, skipping offer');
        continue;
      }

      // For change detection, reconstruct a minimal synthetic ItemDetail from StateOutcome.
      // The detector only reads: currentBidPrice, price, bidCount, itemEndDate, watch_conditions.
      const syntheticItem: ItemDetail | null = stateOutcome.status === 'active' ? {
        itemId: offer.source_id,
        title: offer.title,
        price: stateOutcome.priceGbp != null ? { value: String(stateOutcome.priceGbp), currency: 'GBP' } : undefined,
        bidCount: stateOutcome.bidCount ?? undefined,
        itemEndDate: stateOutcome.auctionEndTime ?? undefined,
      } : null;

      const changes = detectWatchChanges(db, offer, syntheticItem, stateOutcome.status === 'removed');

      // Apply DB updates
      if (stateOutcome.status === 'removed') {
        updateOfferStatus(db, offer.id, 'removed');
      } else if (stateOutcome.status === 'ended' || stateOutcome.status === 'sold') {
        updateOfferStatus(db, offer.id, 'ended');
      } else if (stateOutcome.status === 'active') {
        updateOfferWatchFields(db, offer.id, {
          bid_count: stateOutcome.bidCount ?? undefined,
          auction_end_time: stateOutcome.auctionEndTime ?? undefined,
        });

        if (stateOutcome.priceGbp != null) {
          recordPrice(db, offer.id, stateOutcome.priceGbp, null);
        }
      }

      // Route changes by type
      const priceChanges = changes.filter((c) => c.type === 'price_drop' || c.type === 'price_increase');
      const auctionChanges = changes.filter((c) => c.type === 'auction_ending');
      const watchConditionChanges = changes.filter((c) => c.type === 'watch_condition_met');

      if (priceChanges.length > 0) {
        const huntIds = getHuntIdsForOffer(db, offer.id);
        for (const huntId of huntIds) {
          const hunt = getHunt(db, huntId);
          if (hunt && hunt.status === 'active') {
            sendPriceChangeNotification(hunt.id, hunt.name, priceChanges, hunt.vertical);
          }
        }
      }

      for (const change of auctionChanges) {
        const threshold = change.details.threshold as number;
        const alreadyNotified = getNotifiedThresholds(db, offer.id);
        if (!alreadyNotified.includes(threshold)) {
          addNotifiedThreshold(db, offer.id, threshold);
          const huntIds = getHuntIdsForOffer(db, offer.id);
          for (const huntId of huntIds) {
            const hunt = getHunt(db, huntId);
            if (hunt && hunt.status === 'active') {
              sendUrgentNotification(hunt.id, hunt.name, [change], hunt.vertical);
            }
          }
        }
      }

      if (watchConditionChanges.length > 0) {
        const huntIds = getHuntIdsForOffer(db, offer.id);
        for (const huntId of huntIds) {
          const hunt = getHunt(db, huntId);
          if (hunt && hunt.status === 'active') {
            sendUrgentNotification(hunt.id, hunt.name, watchConditionChanges, hunt.vertical);
          }
        }
      }

      if (changes.length > 0) {
        logger.info(
          { offerId: offer.id, title: offer.title, changes: changes.map((c) => c.type) },
          'Watch changes detected',
        );
      }
    } catch (err) {
      if (sourceId === 'ebay' && isAuthError(err)) invalidateToken();
      logger.error({ offerId: offer.id, sourceId: offer.source_id, err }, 'Watch poll failed');
    }
  }

  state.lastWatchPollTime = Date.now();

  // --- Staleness sweep (check unwatched offers that haven't appeared in searches recently) ---
  if (Date.now() - state.lastStalenessSweepTime < STALENESS_SWEEP_CADENCE_MS) return;

  const staleOffers = getStaleOffers(db, STALE_OFFER_HOURS);
  if (staleOffers.length === 0) {
    state.lastStalenessSweepTime = Date.now();
    return;
  }

  logger.info({ count: staleOffers.length }, 'Starting staleness sweep');
  let checkedCount = 0;
  let removedCount = 0;

  for (const offer of staleOffers) {
    const sourceId = offer.source;

    if (getSourceCalls(state, sourceId) >= getSourceBudget(sourceId)) {
      logger.warn('API budget hit during staleness sweep, stopping early');
      break;
    }

    if (!hasAdapter(sourceId)) {
      logger.warn({ offerId: offer.id, sourceId }, 'No adapter for source, skipping staleness check');
      continue;
    }

    const adapter = getAdapter(sourceId);

    try {
      const stateOutcome = await adapter.getState(offer.source_id);
      addSourceCalls(state, sourceId, stateOutcome.apiCalls);
      checkedCount++;

      if (stateOutcome.error) {
        logger.warn({ offerId: offer.id, error: stateOutcome.error }, 'Staleness check API error, skipping');
        continue;
      }

      if (stateOutcome.status === 'removed') {
        updateOfferStatus(db, offer.id, 'removed');
        removedCount++;
      } else if (stateOutcome.status === 'ended' || stateOutcome.status === 'sold') {
        updateOfferStatus(db, offer.id, 'ended');
        removedCount++;
      } else {
        // Still live — bump last_seen_at so it won't be re-checked next sweep
        updateOfferWatchFields(db, offer.id, {});
      }
    } catch (err) {
      if (sourceId === 'ebay' && isAuthError(err)) invalidateToken();
      logger.error({ offerId: offer.id, err }, 'Staleness check failed');
    }
  }

  logger.info({ checked: checkedCount, removed: removedCount }, 'Staleness sweep complete');
  state.lastStalenessSweepTime = Date.now();
}
