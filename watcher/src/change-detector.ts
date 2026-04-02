/**
 * Change detector — compares new API observations against DB state.
 * Produces typed Change objects with urgency flags.
 */

import type Database from 'better-sqlite3';
import { AUCTION_THRESHOLDS } from './config.js';
import { getLatestPrice, type Offer } from './db.js';
import type { ItemDetail } from './ebay/types.js';

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

  // Price change
  const latestPrice = getLatestPrice(db, offer.id);
  const currentPriceStr = item.currentBidPrice?.value || item.price?.value;
  if (latestPrice && currentPriceStr) {
    const currentPrice = parseFloat(currentPriceStr);
    if (Math.abs(currentPrice - latestPrice.price) > 0.01) {
      const type: ChangeType = currentPrice < latestPrice.price ? 'price_drop' : 'price_increase';
      changes.push({
        type,
        offerId: offer.id,
        sourceId: offer.source_id,
        title: offer.title,
        urgent: false, // may be upgraded by watch condition check below
        details: {
          previousPrice: latestPrice.price,
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

  // Watch condition checks
  if (offer.watch_conditions) {
    try {
      const conditions = JSON.parse(offer.watch_conditions) as Record<string, unknown>;
      const priceLandedStr = currentPriceStr;
      if (priceLandedStr) {
        const currentPrice = parseFloat(priceLandedStr);

        if (typeof conditions.alert_if_price_below_gbp === 'number' && currentPrice < conditions.alert_if_price_below_gbp) {
          changes.push({
            type: 'watch_condition_met',
            offerId: offer.id,
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

        if (typeof conditions.max_price === 'number' && currentPrice <= conditions.max_price) {
          changes.push({
            type: 'watch_condition_met',
            offerId: offer.id,
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
