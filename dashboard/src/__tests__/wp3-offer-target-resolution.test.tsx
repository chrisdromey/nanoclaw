/**
 * WP3 — unit tests for resolveOfferTarget (exported from the OfferDetail page):
 * which hunt target does an offer belong to, for the "Spec sheet →" link.
 * Primary: parsed make+model vs target criteria (case-insensitive contains).
 * Fallback: the single target whose target_key appears in the offer title.
 */

import { describe, it, expect } from 'vitest';
import type { TargetInfo } from '@shared/types';

import { resolveOfferTarget } from '../pages/OfferDetail';

const targets: TargetInfo[] = [
  {
    target_key: 'Kia EV6',
    criteria: { make: 'Kia', model: 'EV6', year_min: 2021 },
    kb: null,
    verifications: [],
  },
  {
    target_key: 'Skoda Enyaq',
    criteria: { make: 'Skoda', model: 'Enyaq' },
    kb: null,
    verifications: [],
  },
  {
    target_key: 'Hyundai Ioniq 5',
    criteria: null, // no criteria — only reachable via the title fallback
    kb: null,
    verifications: [],
  },
];

describe('resolveOfferTarget — attribute matching', () => {
  it('matches make+model against criteria case-insensitively', () => {
    expect(
      resolveOfferTarget({ make: 'kia', model: 'ev6' }, 'Some listing', targets),
    ).toBe('Kia EV6');
  });

  it('matches when the parsed model contains the criteria model', () => {
    expect(
      resolveOfferTarget(
        { make: 'Kia', model: 'EV6 GT-Line S' },
        '2022 electric SUV',
        targets,
      ),
    ).toBe('Kia EV6');
  });

  it('requires both make and model to match', () => {
    expect(
      resolveOfferTarget(
        { make: 'Kia', model: 'Niro' },
        'Kia Niro 2 1.6 GDi', // title mentions neither target_key
        targets,
      ),
    ).toBeNull();
  });
});

describe('resolveOfferTarget — overlapping model names (order independence)', () => {
  const ev6 : TargetInfo = {
    target_key: 'Kia EV6',
    criteria: { make: 'Kia', model: 'EV6' },
    kb: null,
    verifications: [],
  };
  const ev6gt: TargetInfo = {
    target_key: 'Kia EV6 GT',
    criteria: { make: 'Kia', model: 'EV6 GT' },
    kb: null,
    verifications: [],
  };

  it('prefers exact model equality regardless of target order (GT listed first)', () => {
    expect(
      resolveOfferTarget({ make: 'Kia', model: 'EV6' }, 'Kia listing', [ev6gt, ev6]),
    ).toBe('Kia EV6');
  });

  it('prefers exact model equality regardless of target order (plain listed first)', () => {
    expect(
      resolveOfferTarget({ make: 'Kia', model: 'EV6 GT' }, 'Kia listing', [ev6, ev6gt]),
    ).toBe('Kia EV6 GT');
  });

  it('exact equality is case-insensitive and trims whitespace', () => {
    expect(
      resolveOfferTarget({ make: 'KIA', model: ' ev6 gt ' }, 'Kia listing', [ev6, ev6gt]),
    ).toBe('Kia EV6 GT');
  });

  it('returns null on an ambiguous contains-match with no exact winner', () => {
    // "EV6 GT-Line" contains-matches both "EV6" and "EV6 GT" but equals neither
    expect(
      resolveOfferTarget(
        { make: 'Kia', model: 'EV6 GT-Line' },
        'plain listing title', // no target_key in title either
        [ev6, ev6gt],
      ),
    ).toBeNull();
  });
});

describe('resolveOfferTarget — title fallback', () => {
  it('falls back to the single target whose target_key appears in the title', () => {
    expect(
      resolveOfferTarget({}, '2022 Hyundai Ioniq 5 Ultimate 73kWh', targets),
    ).toBe('Hyundai Ioniq 5');
  });

  it('is case-insensitive on the title fallback', () => {
    expect(
      resolveOfferTarget({}, 'SKODA ENYAQ 80 SPORTLINE', targets),
    ).toBe('Skoda Enyaq');
  });

  it('returns null when multiple target_keys appear in the title', () => {
    expect(
      resolveOfferTarget(
        {},
        'Comparing the Kia EV6 vs Skoda Enyaq — which is better?',
        targets,
      ),
    ).toBeNull();
  });

  it('returns null when nothing resolves', () => {
    expect(resolveOfferTarget({}, 'Tesla Model 3 Long Range', targets)).toBeNull();
  });

  it('returns null for empty targets', () => {
    expect(resolveOfferTarget({ make: 'Kia', model: 'EV6' }, 'Kia EV6', [])).toBeNull();
  });
});
