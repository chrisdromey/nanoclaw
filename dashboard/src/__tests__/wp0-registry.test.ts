/**
 * WP0 — vertical UI registry. The default profile must reproduce current
 * computers behaviour exactly; unknown verticals fall back to it.
 */

import { describe, it, expect } from 'vitest';
import { getVerticalUI } from '../lib/verticals/registry';
import { carsVerticalUI } from '../lib/verticals/cars';

describe('getVerticalUI — default (computers) profile', () => {
  it.each([undefined, null, 'computers'] as const)(
    'returns the current-computers profile for %s',
    (vertical) => {
      const ui = getVerticalUI(vertical);
      expect(ui.primaryDealSignal).toBe('band');
      expect(ui.showConditionBreakdown).toBe(true);
      expect(ui.showAuctionUrgency).toBe(true);
      expect(ui.supportsSourcePriceOpinion).toBe(false);
      expect(ui.supportsMustHaveVerification).toBe(false);
      expect(ui.supportsSpecExplorer).toBe(false);
      expect(ui.SegmentAnalyticsPanel).toBeUndefined();
      expect(ui.MarketExtraPanel).toBeUndefined();
    },
  );

  it('unknown future verticals fall back to the same default profile', () => {
    expect(getVerticalUI('unknown-future')).toBe(getVerticalUI('computers'));
    expect(getVerticalUI(undefined)).toBe(getVerticalUI('unknown-future'));
  });

  it('profiles are frozen — mutation throws and cannot poison later lookups', () => {
    const ui = getVerticalUI('computers');
    expect(Object.isFrozen(ui)).toBe(true);
    expect(() => {
      (ui as { primaryDealSignal: string }).primaryDealSignal = 'trend-residual';
    }).toThrow(TypeError);
    expect(Object.isFrozen(getVerticalUI('cars'))).toBe(true);
    // A fresh lookup still returns the untouched profile.
    expect(getVerticalUI('computers').primaryDealSignal).toBe('band');
  });
});

describe('getVerticalUI — cars profile', () => {
  it('returns the cars entry from the registry', () => {
    expect(getVerticalUI('cars')).toBe(carsVerticalUI);
  });

  it('cars uses trend-residual and enables the cars capabilities', () => {
    const ui = getVerticalUI('cars');
    expect(ui.key).toBe('cars');
    expect(ui.primaryDealSignal).toBe('trend-residual');
    expect(ui.showConditionBreakdown).toBe(false);
    expect(ui.showAuctionUrgency).toBe(false);
    expect(ui.supportsSourcePriceOpinion).toBe(true);
    expect(ui.supportsMustHaveVerification).toBe(true);
    expect(ui.supportsSpecExplorer).toBe(true);
    // Panels wired by WP2 (PriceMileageScatter / SourceOpinionCrossCheck).
    expect(typeof ui.SegmentAnalyticsPanel).toBe('function');
    expect(typeof ui.MarketExtraPanel).toBe('function');
  });
});
