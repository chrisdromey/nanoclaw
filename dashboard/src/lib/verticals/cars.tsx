/**
 * Cars vertical UI profile. Wires the cars-specific Market-tab panels
 * (price/mileage scatter, source-opinion cross-check) and offers-table
 * columns (Year/Mileage) into the registry.
 */

import type { OfferWithPrices } from '@shared/types';
import type { VerticalUI } from './registry';
import PriceMileageScatter from '@/components/verticals/cars/PriceMileageScatter';
import SourceOpinionCrossCheck from '@/components/verticals/cars/SourceOpinionCrossCheck';

export const carsVerticalUI: VerticalUI = Object.freeze({
  key: 'cars',
  primaryDealSignal: 'trend-residual',
  showConditionBreakdown: false,
  showAuctionUrgency: false,
  supportsSourcePriceOpinion: true,
  supportsMustHaveVerification: true,
  supportsSpecExplorer: true,
  SegmentAnalyticsPanel: PriceMileageScatter,
  MarketExtraPanel: SourceOpinionCrossCheck,
  offerTableColumns: {
    headers: [
      { key: 'year', label: 'Year' },
      { key: 'mileage', label: 'Mileage' },
    ],
    renderCells: (offer: OfferWithPrices) => {
      const attrs = (offer.attributes as Record<string, unknown>) ?? {};
      return (
        <>
          <td className="py-2.5 px-3 text-zinc-400 text-xs font-mono">
            {attrs.year != null ? String(attrs.year) : '—'}
          </td>
          <td className="py-2.5 px-3 text-zinc-400 text-xs">
            {attrs.mileage_text != null ? String(attrs.mileage_text) : '—'}
          </td>
        </>
      );
    },
  },
});
