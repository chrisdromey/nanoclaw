/**
 * WP0 — linear trend fitting (price vs mileage) tests.
 */

import { describe, it, expect } from 'vitest';
import {
  fitLinearTrend,
  residual,
  residualDealThreshold,
  MIN_TREND_POINTS,
} from '../lib/regression';

describe('fitLinearTrend — degenerate cases', () => {
  it('exports MIN_TREND_POINTS = 4', () => {
    expect(MIN_TREND_POINTS).toBe(4);
  });

  it('returns null with fewer than MIN_TREND_POINTS points', () => {
    expect(fitLinearTrend([])).toBeNull();
    expect(
      fitLinearTrend([
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ]),
    ).toBeNull();
  });

  it('returns null with zero x-variance (all same mileage)', () => {
    expect(
      fitLinearTrend([
        { x: 50000, y: 10000 },
        { x: 50000, y: 11000 },
        { x: 50000, y: 12000 },
        { x: 50000, y: 13000 },
      ]),
    ).toBeNull();
  });

  it('ignores non-finite points (and nulls out if too few remain)', () => {
    expect(
      fitLinearTrend([
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
        { x: NaN, y: 4 },
      ]),
    ).toBeNull();
    const fit = fitLinearTrend([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: Infinity, y: 99 },
      { x: 4, y: NaN },
    ]);
    expect(fit).not.toBeNull();
    expect(fit!.n).toBe(4);
  });
});

describe('fitLinearTrend — fitting', () => {
  it('recovers a perfect line exactly (r2 = 1)', () => {
    // price = 20000 - 0.1 * mileage
    const points = [10000, 30000, 50000, 70000].map((x) => ({
      x,
      y: 20000 - 0.1 * x,
    }));
    const fit = fitLinearTrend(points);
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(-0.1, 10);
    expect(fit!.intercept).toBeCloseTo(20000, 6);
    expect(fit!.r2).toBeCloseTo(1, 10);
    expect(fit!.n).toBe(4);
    expect(fit!.predict(40000)).toBeCloseTo(16000, 6);
  });

  it('horizontal data (zero y-variance) fits with r2 = 1', () => {
    const fit = fitLinearTrend([
      { x: 1, y: 5000 },
      { x: 2, y: 5000 },
      { x: 3, y: 5000 },
      { x: 4, y: 5000 },
    ]);
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(0, 10);
    expect(fit!.r2).toBe(1);
  });

  it('noisy data yields 0 < r2 < 1', () => {
    const fit = fitLinearTrend([
      { x: 10000, y: 19200 },
      { x: 30000, y: 16700 },
      { x: 50000, y: 15400 },
      { x: 70000, y: 12800 },
      { x: 90000, y: 11500 },
    ]);
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeLessThan(0);
    expect(fit!.r2).toBeGreaterThan(0.9);
    expect(fit!.r2).toBeLessThan(1);
  });
});

describe('residual', () => {
  const fit = fitLinearTrend([
    { x: 10000, y: 19000 },
    { x: 30000, y: 17000 },
    { x: 50000, y: 15000 },
    { x: 70000, y: 13000 },
  ])!;

  it('is negative when the price is under the trend (good for buyer)', () => {
    expect(residual(14000, 40000, fit)).toBeCloseTo(-2000, 6);
  });

  it('is positive when the price is above the trend', () => {
    expect(residual(17500, 40000, fit)).toBeCloseTo(1500, 6);
  });

  it('is ~zero on the trend line', () => {
    expect(residual(fit.predict(40000), 40000, fit)).toBeCloseTo(0, 6);
  });
});

describe('residualDealThreshold', () => {
  it('applies the £300 floor for cheap cars (4% would be less)', () => {
    expect(residualDealThreshold(5000)).toBe(300); // 4% = 200
    expect(residualDealThreshold(0)).toBe(300);
  });

  it('uses 4% of the predicted price when that exceeds £300', () => {
    expect(residualDealThreshold(20000)).toBeCloseTo(800, 10);
    expect(residualDealThreshold(7500)).toBe(300); // exactly at the crossover
    expect(residualDealThreshold(10000)).toBeCloseTo(400, 10);
  });
});
