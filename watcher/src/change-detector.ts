/**
 * Change detector — compares new API observations against DB state.
 * Produces typed Change objects with urgency flags.
 */

import type Database from 'better-sqlite3';
import { AUCTION_THRESHOLDS, PRICE_CHANGE_MIN_PCT, priceChangeMinGbp } from './config.js';
import { getLatestPrice, getPriceAtLastEvaluation, type Offer } from './db.js';
import type { ItemDetail } from './sources/ebay/types.js';

export type ChangeType =
  | 'offer_ended'
  | 'price_drop'
  | 'price_increase'
  | 'auction_ending'
  | 'bid_count_change'
  | 'watch_condition_met';

export interface Change {
  type: ChangeType;
  offerId: number;
  source: string;
  sourceId: string;
  title: string;
  urgent: boolean;
  details: Record<string, unknown>;
}

/** Detect changes on a watched offer after a getItem poll. */
export function detectWatchChanges(
  db: Database.Database,
  offer: Offer,
  item: ItemDetail | null,
  removed: boolean,
): Change[] {
  const changes: Change[] = [];

  // Offer confirmed removed by API (404)
  if (removed) {
    changes.push({
      type: 'offer_ended',
      offerId: offer.id,
      source: offer.source,
      sourceId: offer.source_id,
      title: offer.title,
      urgent: true,
      details: { previousStatus: offer.status },
    });
    return changes;
  }

  // API error — no item data but not confirmed removed; skip detection
  if (!item) {
    return changes;
  }

  // Price change — materiality gate (handoff #1A). Fires only when the price moved since the
  // last observation AND is materially different from the price the agent last judged (basis).
  // Measuring against the basis lets a slow drift accumulate instead of being re-suppressed
  // poll after poll; measuring "moved" against the last observation stops a stable price from
  // re-firing every poll when the agent never recorded a fresh evaluation.
  const latestPrice = getLatestPrice(db, offer.id);
  const currentPriceStr = item.currentBidPrice?.value || item.price?.value;
  const currentPrice = currentPriceStr ? parseFloat(currentPriceStr) : undefined;
  if (latestPrice && currentPrice != null) {
    const moved = Math.abs(currentPrice - latestPrice.price) > 0.01;
    const basis = getPriceAtLastEvaluation(db, offer.id) ?? latestPrice.price;
    const delta = currentPrice - basis;
    const material =
      (basis > 0 && Math.abs(delta) / basis >= PRICE_CHANGE_MIN_PCT / 100) ||
      Math.abs(delta) >= priceChangeMinGbp(offer.vertical);
    if (moved && material) {
      changes.push({
        type: delta < 0 ? 'price_drop' : 'price_increase',
        offerId: offer.id,
        source: offer.source,
        sourceId: offer.source_id,
        title: offer.title,
        urgent: false, // may be upgraded by watch condition check below
        details: {
          previousPrice: basis,
          currentPrice,
          currency: item.price?.currency || 'GBP',
        },
      });
    }
  }

  // Bid count change
  if (item.bidCount != null && offer.bid_count != null && item.bidCount > offer.bid_count) {
    changes.push({
      type: 'bid_count_change',
      offerId: offer.id,
      source: offer.source,
      sourceId: offer.source_id,
      title: offer.title,
      urgent: false,
      details: { previousBids: offer.bid_count, currentBids: item.bidCount },
    });
  }

  // Auction ending — graduated thresholds (24h, 12h, 6h)
  if (item.itemEndDate) {
    const endTime = new Date(item.itemEndDate).getTime();
    const hoursLeft = (endTime - Date.now()) / (1000 * 60 * 60);
    if (hoursLeft > 0) {
      // Find the tightest threshold that has been crossed
      for (const threshold of AUCTION_THRESHOLDS) {
        if (hoursLeft < threshold) {
          changes.push({
            type: 'auction_ending',
            offerId: offer.id,
            source: offer.source,
            sourceId: offer.source_id,
            title: offer.title,
            urgent: threshold <= 6,
            details: {
              endsAt: item.itemEndDate,
              hoursLeft: Math.round(hoursLeft * 10) / 10,
              currentBid: item.currentBidPrice?.value || item.price?.value,
              bidCount: item.bidCount,
              threshold,
            },
          });
          break; // Only fire the tightest applicable threshold
        }
      }
    }
  }

  // Watch condition checks — fire on the crossing only: met now and not met at the previous
  // observation. Without this, an offer sitting below its threshold spawned an evaluator every
  // poll (600+ watch-condition runs on one hunt).
  // ponytail: a condition that is already satisfied when the agent sets it never fires; the
  // agent should have alerted instead of watching, and record_evaluation can lint that later.
  if (offer.watch_conditions) {
    try {
      const conditions = JSON.parse(offer.watch_conditions) as Record<string, unknown>;
      if (currentPrice != null) {
        const newlyMet = (met: (p: number) => boolean): boolean =>
          met(currentPrice) && (latestPrice == null || !met(latestPrice.price));
        const below = conditions.alert_if_price_below_gbp;
        const maxPrice = conditions.max_price;

        if (typeof below === 'number' && newlyMet((p) => p < below)) {
          changes.push({
            type: 'watch_condition_met',
            offerId: offer.id,
            source: offer.source,
            sourceId: offer.source_id,
            title: offer.title,
            urgent: true,
            details: {
              condition: 'price_below_threshold',
              threshold: conditions.alert_if_price_below_gbp,
              currentPrice,
            },
          });
        }

        if (typeof maxPrice === 'number' && newlyMet((p) => p <= maxPrice)) {
          changes.push({
            type: 'watch_condition_met',
            offerId: offer.id,
            source: offer.source,
            sourceId: offer.source_id,
            title: offer.title,
            urgent: true,
            details: {
              condition: 'price_at_or_below_max',
              threshold: conditions.max_price,
              currentPrice,
            },
          });
        }
      }
    } catch {
      // Invalid JSON in watch_conditions — skip
    }
  }

  return changes;
}
