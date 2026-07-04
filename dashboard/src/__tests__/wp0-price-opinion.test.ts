/**
 * WP0 — price verdict mapping and our-vs-source disagreement logic.
 */

import { describe, it, expect } from 'vitest';
import type { SourcePriceOpinion } from '@shared/types';
import {
  sourceVerdict,
  ourVerdictFromResidual,
  ourVerdictFromBand,
  isDisagreement,
  type PriceVerdict,
} from '../lib/price-opinion';

function opinion(tier: string): SourcePriceOpinion {
  return { source: 'autotrader', tier, label: null, deviation_gbp: null };
}

describe('sourceVerdict', () => {
  it('maps the full tier matrix', () => {
    expect(sourceVerdict(opinion('LOW'))).toBe('below');
    expect(sourceVerdict(opinion('GREAT'))).toBe('below');
    expect(sourceVerdict(opinion('GOOD'))).toBe('below');
    expect(sourceVerdict(opinion('FAIR'))).toBe('fair');
    expect(sourceVerdict(opinion('HIGH'))).toBe('above');
  });

  it('is case-insensitive', () => {
    expect(sourceVerdict(opinion('good'))).toBe('below');
    expect(sourceVerdict(opinion('High'))).toBe('above');
  });

  it('returns null for unknown tiers', () => {
    expect(sourceVerdict(opinion('NOANALYSIS'))).toBeNull();
    expect(sourceVerdict(opinion('WEIRD_FUTURE_TIER'))).toBeNull();
    expect(sourceVerdict(opinion(''))).toBeNull();
  });
});

describe('ourVerdictFromResidual', () => {
  it('classifies by threshold (negative residual = under trend = below)', () => {
    expect(ourVerdictFromResidual(-500, 300)).toBe('below');
    expect(ourVerdictFromResidual(500, 300)).toBe('above');
    expect(ourVerdictFromResidual(0, 300)).toBe('fair');
    expect(ourVerdictFromResidual(-299, 300)).toBe('fair');
    expect(ourVerdictFromResidual(299, 300)).toBe('fair');
  });

  it('treats the threshold itself as significant (inclusive)', () => {
    expect(ourVerdictFromResidual(-300, 300)).toBe('below');
    expect(ourVerdictFromResidual(300, 300)).toBe('above');
  });

  it('degenerate inputs are fair, never a signal', () => {
    expect(ourVerdictFromResidual(0, 0)).toBe('fair');
    expect(ourVerdictFromResidual(-500, 0)).toBe('fair');
    expect(ourVerdictFromResidual(-500, -100)).toBe('fair');
    expect(ourVerdictFromResidual(NaN, 300)).toBe('fair');
  });
});

describe('ourVerdictFromBand', () => {
  it('maps band assessments to verdicts', () => {
    expect(ourVerdictFromBand('good')).toBe('below');
    expect(ourVerdictFromBand('fair')).toBe('fair');
    expect(ourVerdictFromBand('high')).toBe('above');
    expect(ourVerdictFromBand(null)).toBeNull();
  });
});

describe('isDisagreement', () => {
  it('is true only for opposite directions', () => {
    expect(isDisagreement('below', 'above')).toBe(true);
    expect(isDisagreement('above', 'below')).toBe(true);
  });

  it('agreement is not a disagreement', () => {
    const verdicts: PriceVerdict[] = ['below', 'fair', 'above'];
    for (const v of verdicts) expect(isDisagreement(v, v)).toBe(false);
  });

  it('fair vs anything is not a disagreement', () => {
    expect(isDisagreement('fair', 'below')).toBe(false);
    expect(isDisagreement('fair', 'above')).toBe(false);
    expect(isDisagreement('below', 'fair')).toBe(false);
    expect(isDisagreement('above', 'fair')).toBe(false);
  });

  it('null vs anything is not a disagreement', () => {
    expect(isDisagreement(null, 'above')).toBe(false);
    expect(isDisagreement('below', null)).toBe(false);
    expect(isDisagreement(null, null)).toBe(false);
  });
});
