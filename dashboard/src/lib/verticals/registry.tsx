/**
 * Frontend vertical UI registry — keyed by `hunt.vertical` (a plain string on
 * the hunt row; NOT the watcher-owned verticals DB table). Components ask
 * `getVerticalUI(vertical)` how to render instead of hard-coding
 * per-vertical branches. A future vertical adds one entry here; a future
 * source for an existing vertical adds nothing.
 */

import type { ComponentType, ReactNode } from 'react';
import type {
  CarAttributes,
  HuntBaselineData,
  NormalisedFeatureCategory,
  OfferWithPrices,
  SegmentWithStats,
} from '@shared/types';
import { carsVerticalUI } from './cars';

/**
 * A baseline active-offer row optionally enriched with parsed, typed
 * attributes (via lib/attributes.ts). Parse once in the tab, pass down.
 */
export type ParsedBaselineOffer =
  HuntBaselineData['active_offer_prices'][number] & {
    carAttrs?: CarAttributes;
    features?: NormalisedFeatureCategory[];
  };

/** Props for a vertical's per-segment analytics panel (expanded SegmentCard slot). */
export interface SegmentAnalyticsPanelProps {
  segment: SegmentWithStats;
  offers: ParsedBaselineOffer[];
  budget: number | null;
  mustHaves: string[];
}

/** Props for a vertical's hunt-wide extra Market-tab panel. */
export interface MarketExtraPanelProps {
  huntId: number;
  segments: SegmentWithStats[];
  offersBySegment: Map<number, ParsedBaselineOffer[]>;
}

/**
 * Per-vertical metadata columns for the hunt offers table (OffersTab) —
 * rendered between the shared price/change columns and the auction/decision
 * columns. `renderCells` must emit exactly one <td> per header, matching the
 * header order.
 */
export interface OfferTableColumns {
  headers: Array<{ key: string; label: string }>;
  renderCells: (offer: OfferWithPrices) => ReactNode;
}

export interface VerticalUI {
  key: string;
  /** Which deal signal leads the summary strip and offer annotations. */
  primaryDealSignal: 'band' | 'trend-residual';
  showConditionBreakdown: boolean;
  showAuctionUrgency: boolean;
  /** Source may publish its own price opinion (render when present). */
  supportsSourcePriceOpinion: boolean;
  /** Must-have chips / verification badges apply to this vertical. */
  supportsMustHaveVerification: boolean;
  /** Hunt-scoped Spec Explorer pages (targets strip, KB views). */
  supportsSpecExplorer: boolean;
  /** Rendered inside an expanded SegmentCard when provided. */
  SegmentAnalyticsPanel?: ComponentType<SegmentAnalyticsPanelProps>;
  /** Rendered once on the Market tab when provided. */
  MarketExtraPanel?: ComponentType<MarketExtraPanelProps>;
  /** Vertical-specific offers-table columns (default: Condition/Format). */
  offerTableColumns?: OfferTableColumns;
}

/**
 * Default profile — exactly the current computers/eBay behaviour: band-based
 * deal signal, condition breakdown, auction urgency, no extra capabilities,
 * no panels. Unknown future verticals fall back here.
 */
const defaultVerticalUI: VerticalUI = Object.freeze({
  key: 'default',
  primaryDealSignal: 'band',
  showConditionBreakdown: true,
  showAuctionUrgency: true,
  supportsSourcePriceOpinion: false,
  supportsMustHaveVerification: false,
  supportsSpecExplorer: false,
  offerTableColumns: {
    headers: [
      { key: 'condition', label: 'Condition' },
      { key: 'format', label: 'Format' },
    ],
    renderCells: (offer: OfferWithPrices) => (
      <>
        <td className="py-2.5 px-3 text-zinc-400 text-xs">
          {offer.condition || '—'}
        </td>
        <td className="py-2.5 px-3 text-zinc-400 text-xs">
          {offer.buying_format?.includes('AUCTION')
            ? 'Auc.'
            : offer.buying_format?.includes('FIXED')
              ? 'BIN'
              : offer.buying_format || '—'}
        </td>
      </>
    ),
  },
});

const registry: Record<string, VerticalUI> = {
  cars: carsVerticalUI,
};

/** Resolve the UI profile for a hunt's vertical (default for missing/unknown). */
export function getVerticalUI(vertical?: string | null): VerticalUI {
  if (!vertical) return defaultVerticalUI;
  return registry[vertical] ?? defaultVerticalUI;
}
