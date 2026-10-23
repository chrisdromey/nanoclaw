import type { SegmentWithStats } from '@shared/types';

export interface SegmentMatch {
  segment: SegmentWithStats;
  score: number;
}

/** Minimal offer shape needed to build the segment-match text. */
export interface MatchableOffer {
  title: string;
  attributes?: Record<string, unknown> | null;
}

/**
 * Build the text an offer is matched against. Some sources keep the
 * discriminating trim/derivative outside the title — an AutoTrader title is
 * just "Hyundai IONIQ 5" with the trim in attributes.subTitle ("73kWh
 * Ultimate Auto 5dr") — so matching the title alone collapses every listing
 * of a model into whichever of its segments is listed first.
 */
export function offerMatchText(offer: MatchableOffer): string {
  const attrs = (offer.attributes ?? {}) as Record<string, unknown>;
  const parts: string[] = [offer.title];
  for (const key of ['subTitle', 'derivative', 'trim']) {
    const v = attrs[key];
    if (typeof v === 'string' && v.trim()) parts.push(v);
  }
  return parts.join(' ');
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Case-insensitive whole-token match: the term must not be flanked by other
 * alphanumerics, so tag "SE" matches "SE Connect" but not "diesel", and "S"
 * doesn't match every title containing the letter.
 */
function tokenMatch(textLower: string, term: string): boolean {
  const escaped = term.toLowerCase().replace(REGEX_SPECIALS, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(textLower);
}

/**
 * Optional gate on a segment's tag matching, stored in
 * market_segments.filter_patterns. Solves pairs of segments distinguished by
 * a token the source omits on the default variant: AutoTrader labels AWD
 * cars "AWD" but RWD cars carry no drivetrain token, so "EV6 GT-Line RWD"
 * and "EV6 GT-Line AWD" tie on every RWD listing. Give the AWD segment
 * {"require": ["AWD"]} and the RWD segment {"exclude": ["AWD"]}.
 */
interface FilterPatterns {
  /** Segment only qualifies if at least one term appears (whole-token). */
  require?: string[];
  /** Segment is disqualified if any term appears (whole-token). */
  exclude?: string[];
}

function segmentQualifies(textLower: string, filterPatternsJson: string | null): boolean {
  let patterns: FilterPatterns;
  try {
    patterns = JSON.parse(filterPatternsJson || '{}');
  } catch {
    return true;
  }
  const terms = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : [];

  const exclude = terms(patterns.exclude);
  if (exclude.some((t) => tokenMatch(textLower, t))) return false;

  const require = terms(patterns.require);
  if (require.length > 0 && !require.some((t) => tokenMatch(textLower, t))) return false;

  return true;
}

/**
 * Match an offer's text (see offerMatchText) to the best-fitting market
 * segment. Each segment tag or name word found in the text scores its
 * character length, so specific matches ("GT-Line S") outweigh generic ones
 * ("GT-Line"). If two segments tie for the top score the text carries no
 * token that separates them (e.g. no trim info) — return null rather than
 * misfile the offer into whichever segment happens to come first.
 */
export function matchToSegment(
  text: string,
  segments: SegmentWithStats[],
): SegmentMatch | null {
  if (!text || !segments.length) return null;

  const textLower = text.toLowerCase();
  let best: SegmentMatch | null = null;
  let tiedAtBest = false;

  for (const segment of segments) {
    if (!segmentQualifies(textLower, segment.filter_patterns)) continue;

    let tags: string[];
    try {
      tags = JSON.parse(segment.tags);
    } catch {
      continue;
    }

    let score = tags.reduce(
      (s, tag) => s + (tokenMatch(textLower, tag) ? tag.length : 0),
      0,
    );

    // Also match against segment name words (e.g. "Ryzen 5 Pro 5650G")
    // so offers match even if tags only contain spec descriptors
    const nameWords = segment.name.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    for (const word of nameWords) {
      if (tokenMatch(textLower, word)) score += word.length;
    }

    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { segment, score };
      tiedAtBest = false;
    } else if (score === best.score && segment !== best.segment) {
      tiedAtBest = true;
    }
  }

  return tiedAtBest ? null : best;
}

/**
 * Get a baseline assessment for an offer price relative to its matched segment.
 * Returns 'good' (below low), 'fair' (low to high), 'high' (above high), or null.
 */
export type BaselineAssessment = 'good' | 'fair' | 'high';

export function assessPrice(
  price: number | null,
  segment: SegmentWithStats | null,
): BaselineAssessment | null {
  if (price == null || !segment) return null;
  if (segment.price_low == null || segment.price_high == null) return null;

  if (price <= segment.price_low) return 'good';
  if (price >= segment.price_high) return 'high';
  return 'fair';
}

/**
 * CSS class for a baseline assessment.
 */
export function assessmentColor(assessment: BaselineAssessment | null): string {
  switch (assessment) {
    case 'good': return 'text-success';
    case 'fair': return 'text-zinc-400';
    case 'high': return 'text-danger';
    default: return 'text-zinc-500';
  }
}

/**
 * Short label for a baseline assessment.
 */
export function assessmentLabel(assessment: BaselineAssessment | null): string {
  switch (assessment) {
    case 'good': return 'Good deal';
    case 'fair': return 'Fair';
    case 'high': return 'Overpriced';
    default: return '';
  }
}
