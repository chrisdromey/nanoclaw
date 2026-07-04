/**
 * Verdict mapping and cross-check logic between OUR price signal
 * (trend residual or segment band) and a SOURCE's own price opinion
 * (e.g. AutoTrader's price tier). Pure — no I/O, no React.
 */

import type { SourcePriceOpinion } from '@shared/types';

export type PriceVerdict = 'below' | 'fair' | 'above';

/**
 * Map a source's price-opinion tier onto a direction verdict.
 * LOW/GREAT/GOOD → below market; FAIR → fair; HIGH → above market;
 * anything else (unknown tiers) → null.
 */
export function sourceVerdict(op: SourcePriceOpinion): PriceVerdict | null {
  switch (op.tier.toUpperCase()) {
    case 'LOW':
    case 'GREAT':
    case 'GOOD':
      return 'below';
    case 'FAIR':
      return 'fair';
    case 'HIGH':
      return 'above';
    default:
      return null;
  }
}

/**
 * Our verdict from a trend residual (price - predicted; negative = under
 * trend) and the deal threshold for that predicted price.
 */
export function ourVerdictFromResidual(
  residualGbp: number,
  threshold: number,
): PriceVerdict {
  // Thresholds come from residualDealThreshold, which floors at £300 — a
  // non-positive threshold (or non-finite residual) carries no signal, so
  // report 'fair' rather than letting 0 <= -0 classify as 'below'.
  if (threshold <= 0 || !Number.isFinite(residualGbp)) return 'fair';
  if (residualGbp <= -threshold) return 'below';
  if (residualGbp >= threshold) return 'above';
  return 'fair';
}

/** Our verdict from a segment band assessment (fallback when no trend fit). */
export function ourVerdictFromBand(
  assessment: 'good' | 'fair' | 'high' | null,
): PriceVerdict | null {
  switch (assessment) {
    case 'good':
      return 'below';
    case 'fair':
      return 'fair';
    case 'high':
      return 'above';
    default:
      return null;
  }
}

/**
 * True only when the two verdicts point in OPPOSITE directions
 * (below vs above). Fair-vs-anything and null-vs-anything are not
 * disagreements — only direct contradictions get highlighted.
 */
export function isDisagreement(
  ours: PriceVerdict | null,
  source: PriceVerdict | null,
): boolean {
  if (ours === null || source === null) return false;
  return (
    (ours === 'below' && source === 'above') ||
    (ours === 'above' && source === 'below')
  );
}
