/**
 * Least-squares linear trend fitting for price-vs-mileage (or any x/y) data.
 * Pure — no I/O, no React. Used by the cars Market tab for the
 * residual-vs-depreciation-trend deal signal.
 */

/** Minimum points required before a trend line is fitted/shown. */
export const MIN_TREND_POINTS = 4;

export interface LinearTrendFit {
  slope: number;
  intercept: number;
  /** Number of (finite) points used in the fit. */
  n: number;
  /** Coefficient of determination; 1 when the fit is perfect. */
  r2: number;
  predict(x: number): number;
}

/**
 * Ordinary least-squares fit. Returns null when there are fewer than
 * MIN_TREND_POINTS finite points or zero x-variance (vertical/degenerate).
 */
export function fitLinearTrend(
  points: Array<{ x: number; y: number }>,
): LinearTrendFit | null {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pts.length;
  if (n < MIN_TREND_POINTS) return null;

  let sumX = 0;
  let sumY = 0;
  for (const p of pts) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - meanX;
    sxx += dx * dx;
    sxy += dx * (p.y - meanY);
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const predict = (x: number) => slope * x + intercept;

  let ssRes = 0;
  let ssTot = 0;
  for (const p of pts) {
    ssRes += (p.y - predict(p.x)) ** 2;
    ssTot += (p.y - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return { slope, intercept, n, r2, predict };
}

/**
 * Signed distance from the trend: price - predicted-price-at-mileage.
 * Negative = under trend = good for a buyer.
 */
export function residual(price: number, mileage: number, fit: LinearTrendFit): number {
  return price - fit.predict(mileage);
}

/**
 * How far under trend a price must be before it counts as a deal:
 * max(£300, 4% of the trend-predicted price).
 */
export function residualDealThreshold(predicted: number): number {
  return Math.max(300, 0.04 * predicted);
}
