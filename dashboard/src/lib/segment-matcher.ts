import type { SegmentWithStats } from '@shared/types';

export interface SegmentMatch {
  segment: SegmentWithStats;
  score: number;
}

/**
 * Match an offer title to the best-fitting market segment.
 * Uses tag-based matching: each segment tag that appears in the title
 * (case-insensitive) scores 1 point. Highest score wins.
 */
export function matchToSegment(
  title: string,
  segments: SegmentWithStats[],
): SegmentMatch | null {
  if (!title || !segments.length) return null;

  const titleLower = title.toLowerCase();
  let best: SegmentMatch | null = null;

  for (const segment of segments) {
    let tags: string[];
    try {
      tags = JSON.parse(segment.tags);
    } catch {
      continue;
    }

    // Score from tags
    let score = tags.reduce(
      (s, tag) => s + (titleLower.includes(tag.toLowerCase()) ? 1 : 0),
      0,
    );

    // Also match against segment name words (e.g. "Ryzen 5 Pro 5650G")
    // so offers match even if tags only contain spec descriptors
    const nameWords = segment.name.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    for (const word of nameWords) {
      if (titleLower.includes(word)) score++;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { segment, score };
    }
  }

  return best;
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
