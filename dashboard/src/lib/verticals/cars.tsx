/**
 * Cars vertical UI profile. Wires the cars-specific Market-tab panels
 * (price/mileage scatter, source-opinion cross-check) into the registry.
 */

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
});
