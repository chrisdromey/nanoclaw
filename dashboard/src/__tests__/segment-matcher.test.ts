/**
 * Segment matcher tests — pinned on the real hunt-11 (family-ev) segment set
 * that produced the misclassification bugs: AutoTrader titles carry no trim
 * ("Hyundai IONIQ 5"), so title-only matching filed every Ioniq 5 as
 * "SE Connect" and every EV6 as "Air" (first segment wins on a tie).
 */

import { describe, it, expect } from 'vitest';
import type { SegmentWithStats } from '@shared/types';
import {
  matchToSegment,
  offerMatchText,
} from '../lib/segment-matcher';

let nextId = 1;
function segment(name: string, tags: string[], filterPatterns = '{}'): SegmentWithStats {
  return {
    id: nextId++,
    hunt_id: 11,
    name,
    description: null,
    tags: JSON.stringify(tags),
    filter_patterns: filterPatterns,
    price_low: 10000,
    price_mid: 15000,
    price_high: 20000,
    sample_size: 10,
    confidence: 'MEDIUM',
    notes: null,
    created_at: '2026-07-01 00:00:00',
    updated_at: '2026-07-01 00:00:00',
    data_point_count: 10,
    sold_count: 5,
    active_count: 5,
    earliest_data: null,
    latest_data: null,
  };
}

// Real hunt-11 segments (ids differ; tags verbatim from the DB).
const ioniq5Segments = [
  segment('Ioniq 5 SE Connect 58kWh (2021-2023)', ['Hyundai Ioniq 5', 'IONIQ 5', 'ioniq 5', 'ioniq5', 'SE Connect', '58kWh']),
  segment('Ioniq 5 Premium 73/77kWh (2021-2023)', ['Hyundai Ioniq 5', 'IONIQ 5', 'ioniq 5', 'ioniq5', 'Premium', '73kWh', '77kWh']),
  segment('Ioniq 5 Ultimate 73/77kWh (2021-2023)', ['Hyundai Ioniq 5', 'IONIQ 5', 'ioniq 5', 'ioniq5', 'Ultimate', '73kWh', '77kWh']),
];

const ev6Segments = [
  segment('EV6 Air 77kWh (2022-2023)', ['Kia EV6', 'EV6', 'ev6', 'Air', '77kWh', '77.4kWh']),
  segment('EV6 GT-Line 77kWh RWD (2021-2023)', ['Kia EV6', 'EV6', 'ev6', 'GT-Line', 'GT Line', '77kWh', '77.4kWh', 'RWD']),
  segment('EV6 GT-Line S 77kWh (2021-2023)', ['Kia EV6', 'EV6', 'ev6', 'GT-Line S', 'GT Line S', '77kWh', '77.4kWh']),
];

describe('offerMatchText', () => {
  it('appends AutoTrader subTitle to the title', () => {
    expect(
      offerMatchText({
        title: 'Hyundai IONIQ 5',
        attributes: { subTitle: '73kWh Ultimate Auto 5dr' },
      }),
    ).toBe('Hyundai IONIQ 5 73kWh Ultimate Auto 5dr');
  });

  it('handles missing/empty attributes (eBay offers)', () => {
    expect(offerMatchText({ title: 'AMD Ryzen 9 5900X CPU' })).toBe('AMD Ryzen 9 5900X CPU');
    expect(offerMatchText({ title: 'x', attributes: {} })).toBe('x');
    expect(offerMatchText({ title: 'x', attributes: { subTitle: '  ' } })).toBe('x');
  });
});

describe('matchToSegment — trim discrimination via subTitle (bug: Ultimate shown as SE)', () => {
  it('files an Ultimate Ioniq 5 under Ultimate, not SE Connect', () => {
    const text = offerMatchText({
      title: 'Hyundai IONIQ 5',
      attributes: { subTitle: '73kWh Ultimate Auto 5dr' },
    });
    const m = matchToSegment(text, ioniq5Segments);
    expect(m?.segment.name).toBe('Ioniq 5 Ultimate 73/77kWh (2021-2023)');
  });

  it('files a Premium Ioniq 5 under Premium', () => {
    const text = offerMatchText({
      title: 'Hyundai IONIQ 5',
      attributes: { subTitle: '77kWh Premium Auto 5dr' },
    });
    const m = matchToSegment(text, ioniq5Segments);
    expect(m?.segment.name).toBe('Ioniq 5 Premium 73/77kWh (2021-2023)');
  });

  it('files an EV6 GT-Line under GT-Line, not Air (bug: all EV6 shown as Air)', () => {
    const text = offerMatchText({
      title: 'Kia EV6',
      attributes: { subTitle: '77.4kWh GT-Line Auto RWD 5dr' },
    });
    const m = matchToSegment(text, ev6Segments);
    expect(m?.segment.name).toBe('EV6 GT-Line 77kWh RWD (2021-2023)');
  });

  it('files an EV6 GT-Line S under GT-Line S, not plain GT-Line', () => {
    const text = offerMatchText({
      title: 'Kia EV6',
      attributes: { subTitle: '77.4kWh GT-Line S Auto AWD 5dr' },
    });
    const m = matchToSegment(text, ev6Segments);
    expect(m?.segment.name).toBe('EV6 GT-Line S 77kWh (2021-2023)');
  });

  it('files an EV6 Air under Air', () => {
    const text = offerMatchText({
      title: 'Kia EV6',
      attributes: { subTitle: '77.4kWh Air Auto 5dr' },
    });
    const m = matchToSegment(text, ev6Segments);
    expect(m?.segment.name).toBe('EV6 Air 77kWh (2022-2023)');
  });
});

describe('matchToSegment — ambiguity returns unmatched instead of first-wins', () => {
  it('returns null when the text has no trim token to separate segments', () => {
    // Title-only AT row (no subTitle): all Ioniq 5 segments tie on generic tags.
    const m = matchToSegment('Hyundai IONIQ 5', ioniq5Segments);
    expect(m).toBeNull();
  });

  it('still matches when only one segment fits', () => {
    const m = matchToSegment('AMD Ryzen 9 5900X 12-core AM4', [
      segment('Ryzen 9 5900X used', ['5900X', 'AM4', 'Zen3', '12-core', 'used']),
      segment('Ryzen 9 5950X used', ['5950X', 'AM4', 'Zen3', '16-core', 'used']),
    ]);
    expect(m?.segment.name).toBe('Ryzen 9 5900X used');
  });
});

describe('matchToSegment — filter_patterns require/exclude', () => {
  // AutoTrader labels AWD explicitly but RWD is the unlabelled default, so the
  // GT-Line RWD/AWD pair is undecidable from tags alone. filter_patterns break
  // the tie: exclude AWD-tokens on the RWD segment, require them on the AWD one.
  const gtLinePair = () => [
    segment(
      'EV6 GT-Line 77kWh RWD (2021-2023)',
      ['Kia EV6', 'EV6', 'ev6', 'GT-Line', 'GT Line', '77kWh', '77.4kWh', 'RWD'],
      '{"exclude": ["AWD", "4WD", "Dual Motor"]}',
    ),
    segment(
      'EV6 GT-Line 77kWh AWD (2022)',
      ['Kia EV6', 'EV6', 'ev6', 'GT-Line', 'GT Line', '77kWh', '77.4kWh', 'AWD'],
      '{"require": ["AWD", "4WD", "Dual Motor"]}',
    ),
  ];

  it('files a GT-Line with no drivetrain token under RWD (the unlabelled default)', () => {
    const m = matchToSegment('kia ev6 77.4kWh GT-Line Auto 5dr', gtLinePair());
    expect(m?.segment.name).toBe('EV6 GT-Line 77kWh RWD (2021-2023)');
  });

  it('files a GT-Line AWD under the AWD segment', () => {
    const m = matchToSegment('Kia EV6 77.4kWh GT-Line Auto AWD 5dr', gtLinePair());
    expect(m?.segment.name).toBe('EV6 GT-Line 77kWh AWD (2022)');
  });

  it('ignores malformed filter_patterns', () => {
    const m = matchToSegment('Kia EV6 Air', [
      segment('EV6 Air', ['EV6', 'Air'], 'not-json'),
    ]);
    expect(m?.segment.name).toBe('EV6 Air');
  });
});

describe('matchToSegment — token boundaries', () => {
  it('does not let short tags match inside words ("SE" vs "diesel")', () => {
    const m = matchToSegment('Ford Focus 1.5 diesel Titanium', [
      segment('I-Pace SE', ['SE', 'S']),
    ]);
    expect(m).toBeNull();
  });

  it('matches short tags as whole tokens', () => {
    const m = matchToSegment('Jaguar I-Pace EV400 SE Auto', [
      segment('I-Pace SE/S (2019-2020)', ['Jaguar I-Pace', 'I-Pace', 'SE', 'S', '90kWh']),
      segment('I-Pace HSE/Black (2021-2023)', ['Jaguar I-Pace', 'I-Pace', 'HSE', 'Black', '90kWh']),
    ]);
    expect(m?.segment.name).toBe('I-Pace SE/S (2019-2020)');
  });

  it('does not treat "HSE" as containing "SE"', () => {
    const m = matchToSegment('Jaguar I-Pace EV400 HSE Auto', [
      segment('I-Pace SE/S (2019-2020)', ['Jaguar I-Pace', 'I-Pace', 'SE', 'S', '90kWh']),
      segment('I-Pace HSE/Black (2021-2023)', ['Jaguar I-Pace', 'I-Pace', 'HSE', 'Black', '90kWh']),
    ]);
    expect(m?.segment.name).toBe('I-Pace HSE/Black (2021-2023)');
  });

  it('escapes regex specials in tags', () => {
    const m = matchToSegment('Kia e-Niro 4+ 64kWh', [
      segment('Kia Niro EV 64kWh (2019-2022)', ['Kia', 'Niro', '64kWh', 'EV', 'First Edition', '4+']),
    ]);
    expect(m).not.toBeNull();
  });
});
