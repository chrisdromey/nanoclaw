/**
 * Main scheduler loop.
 * Manages search polls (per-hunt cadence) and watch polls (every 2h).
 */

import type Database from 'better-sqlite3';
import { logger } from './logger.js';
import {
  EBAY_CLIENT_ID,
  EBAY_CLIENT_SECRET,
  DAILY_API_BUDGET,
  WATCH_CADENCE_MS,
} from './config.js';
import { getToken, invalidateToken, isAuthError } from './ebay/auth.js';
import { searchEbay } from './ebay/search.js';
import { getItemState } from './ebay/watch.js';
import {
  getActiveHunts,
  getWatchedOffers,
  getLastSearchTime,
  getHunt,
  getHuntIdsForOffer,
  applySearchResults,
  updateOfferStatus,
  updateOfferWatchFields,
  recordPrice,
  parseSearchTerms,
} from './db.js';
import { detectWatchChanges } from './change-detector.js';
import { sendUrgentNotification, sendNewOffersNotification, sendPriceChangeNotification } from './notifier.js';
import { getNotifiedThresholds, addNotifiedThreshold } from './db.js';

export interface SchedulerState {
  lastSearchTime: Map<string, number>;
  lastWatchPollTime: number;
  dailyApiCalls: number;
  dailyApiCallsResetAt: number;
}

function nextMidnight(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Seed lastSearchTime from DB so we respect cadence after restart. */
export function initState(db: Database.Database): SchedulerState {
  const state: SchedulerState = {
    lastSearchTime: new Map(),
    lastWatchPollTime: Date.now(),  // defer first watch poll to avoid stale-token errors on restart
    dailyApiCalls: 0,
    dailyApiCallsResetAt: nextMidnight(),
  };

  const hunts = getActiveHunts(db);
  for (const hunt of hunts) {
    const entries = parseSearchTerms(hunt.search_terms);
    for (const entry of entries) {
      const last = getLastSearchTime(db, hunt.id, entry.terms);
      if (last) {
        state.lastSearchTime.set(`${hunt.id}:${entry.terms}`, new Date(last).getTime());
      }
    }
  }

  logger.info({ huntCount: hunts.length, seededSearchTimes: state.lastSearchTime.size }, 'Scheduler state initialized');
  return state;
}

export async function tick(state: SchedulerState, db: Database.Database): Promise<void> {
  // Reset daily counter at midnight
  if (Date.now() > state.dailyApiCallsResetAt) {
    state.dailyApiCalls = 0;
    state.dailyApiCallsResetAt = nextMidnight();
  }

  // Budget check
  if (state.dailyApiCalls > DAILY_API_BUDGET) {
    logger.warn({ calls: state.dailyApiCalls }, 'Daily API budget exceeded, skipping tick');
    return;
  }

  const token = await getToken(EBAY_CLIENT_ID, EBAY_CLIENT_SECRET);
  if (!token) {
    logger.error('No eBay access token, skipping tick');
    return;
  }

  // --- Search polls (batch new offer notifications across the tick) ---
  const hunts = getActiveHunts(db);
  const newOffersByHunt = new Map<number, { huntName: string; newCount: number }>();

  for (const hunt of hunts) {
    let searchTermEntries;
    try {
      searchTermEntries = parseSearchTerms(hunt.search_terms);
    } catch {
      logger.error({ huntId: hunt.id }, 'Invalid search_terms JSON, skipping hunt');
      continue;
    }

    const cadenceMs = hunt.cadence_minutes * 60_000;

    for (const entry of searchTermEntries) {
      const terms = entry.terms;
      const key = `${hunt.id}:${terms}`;
      const lastRun = state.lastSearchTime.get(key) || 0;

      if (Date.now() - lastRun < cadenceMs) continue;

      try {
        const effectiveCategoryIds = entry.category_ids || hunt.category_ids || undefined;
        const result = await searchEbay(terms, token, undefined, undefined, effectiveCategoryIds);
        state.dailyApiCalls += result.apiCallCount;

        const { newCount, totalCount } = applySearchResults(db, hunt.id, terms, result.items);
        state.lastSearchTime.set(key, Date.now());

        if (newCount > 0) {
          const existing = newOffersByHunt.get(hunt.id);
          if (existing) {
            existing.newCount += newCount;
          } else {
            newOffersByHunt.set(hunt.id, { huntName: hunt.name, newCount });
          }
          logger.info({ huntId: hunt.id, huntName: hunt.name, terms, newCount, totalCount }, 'New offers found');
        } else {
          logger.debug({ huntId: hunt.id, terms, totalCount }, 'Search complete, no new offers');
        }
      } catch (err) {
        if (isAuthError(err)) invalidateToken();
        logger.error({ huntId: hunt.id, terms, err }, 'Search failed');
      }
    }
  }

  // Send batched new-offer notification (one per tick, not per search term)
  if (newOffersByHunt.size > 0) {
    sendNewOffersNotification(
      Array.from(newOffersByHunt.entries()).map(([huntId, { huntName, newCount }]) => ({
        huntId,
        huntName,
        newCount,
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
    try {
      const result = await getItemState(offer.source_id, token);
      state.dailyApiCalls += result.apiCallCount;

      // API error — skip this offer, don't update DB or detect changes
      if (result.error) {
        logger.warn({ offerId: offer.id, sourceId: offer.source_id, error: result.error }, 'Watch poll API error, skipping offer');
        continue;
      }

      const changes = detectWatchChanges(db, offer, result.item, result.removed);

      // Apply DB updates
      if (result.removed) {
        updateOfferStatus(db, offer.id, 'removed');
      } else if (result.item) {
        const priceStr = result.item.currentBidPrice?.value || result.item.price?.value;
        const shippingStr = result.item.shippingOptions?.[0]?.shippingCost?.value;

        updateOfferWatchFields(db, offer.id, {
          bid_count: result.item.bidCount ?? undefined,
          auction_end_time: result.item.itemEndDate ?? undefined,
        });

        // Record new price observation
        if (priceStr) {
          recordPrice(db, offer.id, parseFloat(priceStr), shippingStr ? parseFloat(shippingStr) : null);
        }
      }

      // Route changes by type
      const priceChanges = changes.filter((c) => c.type === 'price_drop' || c.type === 'price_increase');
      const auctionChanges = changes.filter((c) => c.type === 'auction_ending');
      const watchConditionChanges = changes.filter((c) => c.type === 'watch_condition_met');
      // offer_ended and bid_count_change — NOT notified, picked up in daily review

      // Price changes → dedicated notification
      if (priceChanges.length > 0) {
        const huntIds = getHuntIdsForOffer(db, offer.id);
        for (const huntId of huntIds) {
          const hunt = getHunt(db, huntId);
          if (hunt && hunt.status === 'active') {
            sendPriceChangeNotification(hunt.id, hunt.name, priceChanges);
          }
        }
      }

      // Auction countdown — check threshold dedup before notifying
      for (const change of auctionChanges) {
        const threshold = change.details.threshold as number;
        const alreadyNotified = getNotifiedThresholds(db, offer.id);
        if (!alreadyNotified.includes(threshold)) {
          addNotifiedThreshold(db, offer.id, threshold);
          const huntIds = getHuntIdsForOffer(db, offer.id);
          for (const huntId of huntIds) {
            const hunt = getHunt(db, huntId);
            if (hunt && hunt.status === 'active') {
              sendUrgentNotification(hunt.id, hunt.name, [change]);
            }
          }
        }
      }

      // Watch conditions — always notify
      if (watchConditionChanges.length > 0) {
        const huntIds = getHuntIdsForOffer(db, offer.id);
        for (const huntId of huntIds) {
          const hunt = getHunt(db, huntId);
          if (hunt && hunt.status === 'active') {
            sendUrgentNotification(hunt.id, hunt.name, watchConditionChanges);
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
      if (isAuthError(err)) invalidateToken();
      logger.error({ offerId: offer.id, sourceId: offer.source_id, err }, 'Watch poll failed');
    }
  }

  state.lastWatchPollTime = Date.now();
}
