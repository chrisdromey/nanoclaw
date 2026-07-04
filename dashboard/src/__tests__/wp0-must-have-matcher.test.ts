/**
 * WP0 — must-have fuzzy matcher tests, pinned on known-tricky real strings
 * from hunt 11 (family-ev).
 */

import { describe, it, expect } from 'vitest';
import type { NormalisedFeatureCategory, TargetVerification } from '@shared/types';
import {
  normalizeFeatureText,
  splitMustHaveAlternatives,
  matchMustHaveToFeatures,
  matchMustHaveToVerification,
  FEATURE_ALIASES,
} from '../lib/must-have-matcher';

function verification(feature: string): TargetVerification {
  return {
    feature,
    verdict: 'verified',
    evidence_url: null,
    notes: null,
    checked_at: '2026-07-01T00:00:00Z',
  };
}

function features(
  items: Array<{ name: string; type?: string | null; category?: string }>,
): NormalisedFeatureCategory[] {
  const byCategory = new Map<string, NormalisedFeatureCategory>();
  for (const item of items) {
    const cat = item.category ?? 'Driver Convenience';
    if (!byCategory.has(cat)) byCategory.set(cat, { category: cat, items: [] });
    byCategory.get(cat)!.items.push({ name: item.name, type: item.type ?? 'Standard' });
  }
  return Array.from(byCategory.values());
}

describe('normalizeFeatureText', () => {
  it('lowercases, strips parentheticals and punctuation, drops stopwords', () => {
    expect(normalizeFeatureText('Adaptive Cruise Control (ACC)')).toEqual([
      'adaptive',
      'cruise',
      'control',
    ]);
    expect(normalizeFeatureText('Adaptive Cruise Control with Stop & Go')).toEqual([
      'adaptive',
      'cruise',
      'control',
      'stop',
      'go',
    ]);
    expect(normalizeFeatureText('Sat-Nav, and ISOFIX!')).toEqual(['sat', 'nav', 'isofix']);
  });

  it('returns [] for empty/stopword-only input', () => {
    expect(normalizeFeatureText('')).toEqual([]);
    expect(normalizeFeatureText('with and or (not just)')).toEqual([]);
  });
});

describe('splitMustHaveAlternatives', () => {
  it('splits on " / " and " or " into normalized alternatives', () => {
    expect(
      splitMustHaveAlternatives('Lane keep / lane centering (not just lane departure warning)'),
    ).toEqual([
      ['lane', 'keep'],
      ['lane', 'centering'],
    ]);
    expect(splitMustHaveAlternatives('Apple CarPlay or Android Auto')).toEqual([
      ['apple', 'carplay'],
      ['android', 'auto'],
    ]);
  });

  it('keeps a single alternative for plain must-haves', () => {
    expect(splitMustHaveAlternatives('Adaptive cruise control (ACC)')).toEqual([
      ['adaptive', 'cruise', 'control'],
    ]);
  });

  it('does NOT split a slash without surrounding whitespace (compound wording)', () => {
    expect(splitMustHaveAlternatives('Front/rear parking sensors')).toEqual([
      ['front', 'rear', 'parking', 'sensors'],
    ]);
  });

  it('discards single-token fragments from a split unless the alias table knows them', () => {
    // Spaced slash splits; the junk ["front"] fragment is dropped.
    expect(splitMustHaveAlternatives('Front / rear parking sensors')).toEqual([
      ['rear', 'parking', 'sensors'],
    ]);
    // Alias-known single tokens survive the safety net.
    expect(splitMustHaveAlternatives('ISOFIX or rear parking sensors')).toEqual([
      ['isofix'],
      ['rear', 'parking', 'sensors'],
    ]);
  });
});

describe('matchMustHaveToVerification — CRITICAL real-data pairs', () => {
  it('matches "Adaptive cruise control (ACC)" to "Adaptive Cruise Control (ACC)"', () => {
    const v = verification('Adaptive Cruise Control (ACC)');
    expect(matchMustHaveToVerification('Adaptive cruise control (ACC)', [v])).toBe(v);
  });

  it('matches the lane-keep must-have to "Lane Keep Assist or Lane Centering"', () => {
    const v = verification('Lane Keep Assist or Lane Centering');
    expect(
      matchMustHaveToVerification(
        'Lane keep / lane centering (not just lane departure warning)',
        [v],
      ),
    ).toBe(v);
  });

  it('does NOT match "Lane Departure Warning" alone against the lane-keep must-have', () => {
    expect(
      matchMustHaveToVerification(
        'Lane keep / lane centering (not just lane departure warning)',
        [verification('Lane Departure Warning')],
      ),
    ).toBeNull();
  });

  it('picks the best match among several verifications', () => {
    const ldw = verification('Lane Departure Warning');
    const lka = verification('Lane Keep Assist or Lane Centering');
    const acc = verification('Adaptive Cruise Control (ACC)');
    expect(
      matchMustHaveToVerification(
        'Lane keep / lane centering (not just lane departure warning)',
        [ldw, acc, lka],
      ),
    ).toBe(lka);
  });

  it('returns null on empty verifications or empty must-have', () => {
    expect(matchMustHaveToVerification('Heat pump', [])).toBeNull();
    expect(matchMustHaveToVerification('', [verification('Heat pump')])).toBeNull();
  });

  it('does NOT return a plain "Cruise Control" row for the ACC must-have', () => {
    expect(
      matchMustHaveToVerification('Adaptive cruise control (ACC)', [
        verification('Cruise Control'),
      ]),
    ).toBeNull();
  });
});

describe('matchMustHaveToFeatures', () => {
  it('feature "Adaptive Cruise Control with Stop & Go" matches the ACC must-have', () => {
    const result = matchMustHaveToFeatures(
      'Adaptive cruise control (ACC)',
      features([{ name: 'Adaptive Cruise Control with Stop & Go' }]),
    );
    expect(result.status).toBe('standard');
    expect(result.matchedFeature).toBe('Adaptive Cruise Control with Stop & Go');
    expect(result.category).toBe('Driver Convenience');
  });

  it('matches via the alias table (ACC abbreviation)', () => {
    const result = matchMustHaveToFeatures(
      'Adaptive cruise control (ACC)',
      features([{ name: 'ACC' }]),
    );
    expect(result.status).toBe('standard');
  });

  it('"or" alternatives: Android Auto satisfies "Apple CarPlay or Android Auto"', () => {
    const result = matchMustHaveToFeatures(
      'Apple CarPlay or Android Auto',
      features([{ name: 'Android Auto', category: 'Infotainment' }]),
    );
    expect(result.status).toBe('standard');
    expect(result.matchedFeature).toBe('Android Auto');
    expect(result.category).toBe('Infotainment');
  });

  it('exclusion: "Lane Departure Warning" alone is not_listed for the lane-keep must-have', () => {
    const result = matchMustHaveToFeatures(
      'Lane keep / lane centering (not just lane departure warning)',
      features([{ name: 'Lane Departure Warning' }]),
    );
    expect(result.status).toBe('not_listed');
    expect(result.matchedFeature).toBeUndefined();
  });

  it('lane keep still matches when the item also mentions lane departure', () => {
    const result = matchMustHaveToFeatures(
      'Lane keep / lane centering (not just lane departure warning)',
      features([{ name: 'Lane Departure Warning with Lane Keep Assist' }]),
    );
    expect(result.status).toBe('standard');
  });

  it('Standard beats Optional when both match', () => {
    const result = matchMustHaveToFeatures(
      'Adaptive cruise control (ACC)',
      features([
        { name: 'Adaptive Cruise Control (Pack)', type: 'Optional' },
        { name: 'Adaptive Cruise Control', type: 'Standard' },
      ]),
    );
    expect(result.status).toBe('standard');
    expect(result.matchedFeature).toBe('Adaptive Cruise Control');
  });

  it('Optional-only match reports optional', () => {
    const result = matchMustHaveToFeatures(
      'Heat pump',
      features([{ name: 'Heat Pump', type: 'Optional' }]),
    );
    expect(result.status).toBe('optional');
    expect(result.matchedFeature).toBe('Heat Pump');
  });

  it('null/unknown item type counts as standard (listed as present)', () => {
    const result = matchMustHaveToFeatures(
      'ISOFIX',
      features([{ name: 'Isofix Child Seat Points', type: null }]),
    );
    expect(result.status).toBe('standard');
  });

  it('returns not_listed for no features and unrelated features', () => {
    expect(matchMustHaveToFeatures('Heat pump', []).status).toBe('not_listed');
    expect(
      matchMustHaveToFeatures('Heat pump', features([{ name: 'Alloy Wheels' }])).status,
    ).toBe('not_listed');
  });

  it('sat nav alias family: "Navigation System" satisfies "Sat nav"', () => {
    const result = matchMustHaveToFeatures(
      'Sat nav',
      features([{ name: 'Navigation System', category: 'Infotainment' }]),
    );
    expect(result.status).toBe('standard');
  });

  it('reversing camera alias family: "Rear View Camera" satisfies "Reversing camera"', () => {
    const result = matchMustHaveToFeatures(
      'Reversing camera',
      features([{ name: 'Rear View Camera' }]),
    );
    expect(result.status).toBe('standard');
  });

  it('plain "Cruise Control" does NOT satisfy the adaptive cruise control must-have', () => {
    const result = matchMustHaveToFeatures(
      'Adaptive cruise control (ACC)',
      features([{ name: 'Cruise Control', type: 'Standard' }]),
    );
    expect(result.status).toBe('not_listed');
    expect(result.matchedFeature).toBeUndefined();
  });

  it('feature "Lane" alone does NOT satisfy the lane-keep must-have', () => {
    const result = matchMustHaveToFeatures(
      'Lane keep / lane centering (not just lane departure warning)',
      features([{ name: 'Lane' }]),
    );
    expect(result.status).toBe('not_listed');
  });

  it('"Front/rear parking sensors" does NOT match "Front Fog Lights"', () => {
    const result = matchMustHaveToFeatures(
      'Front/rear parking sensors',
      features([{ name: 'Front Fog Lights' }]),
    );
    expect(result.status).toBe('not_listed');
  });

  it('"Front/rear parking sensors" still matches "Front and Rear Parking Sensors"', () => {
    const result = matchMustHaveToFeatures(
      'Front/rear parking sensors',
      features([{ name: 'Front and Rear Parking Sensors' }]),
    );
    expect(result.status).toBe('standard');
    expect(result.matchedFeature).toBe('Front and Rear Parking Sensors');
  });
});

describe('FEATURE_ALIASES table', () => {
  it('is exported and extensible', () => {
    expect(Array.isArray(FEATURE_ALIASES)).toBe(true);
    const before = FEATURE_ALIASES.length;
    FEATURE_ALIASES.push({ canonical: 'panoramic roof', aliases: ['panoramic roof', 'pano roof'] });
    try {
      const result = matchMustHaveToFeatures(
        'Pano roof',
        features([{ name: 'Panoramic Roof' }]),
      );
      expect(result.status).toBe('standard');
    } finally {
      FEATURE_ALIASES.splice(before);
    }
  });

  it('lane-keep group is exclusion-aware', () => {
    const group = FEATURE_ALIASES.find((g) => g.canonical === 'lane keep');
    expect(group).toBeDefined();
    expect(group!.excludes?.some((e) => e.includes('lane departure'))).toBe(true);
  });
});
