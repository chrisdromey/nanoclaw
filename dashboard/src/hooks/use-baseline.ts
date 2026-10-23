import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import {
  matchToSegment,
  offerMatchText,
  assessPrice,
  type MatchableOffer,
  type SegmentMatch,
  type BaselineAssessment,
} from '@/lib/segment-matcher';
import type { HuntBaselineData, SegmentWithStats } from '@shared/types';

export interface BaselineContext {
  segments: SegmentWithStats[];
  isLoading: boolean;
  match: (offer: MatchableOffer) => SegmentMatch | null;
  assess: (price: number | null, offer: MatchableOffer) => BaselineAssessment | null;
  belowBaselineCount: (
    offers: Array<MatchableOffer & { current_price: number | null }>,
  ) => number;
  isStale: boolean;
  hasSegments: boolean;
}

/**
 * Hook that provides baseline context for a hunt.
 * Fetches segments once, then provides matching and assessment functions.
 */
export function useBaseline(huntId: number | null): BaselineContext {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.hunts.baseline(huntId!),
    queryFn: () => apiGet<HuntBaselineData>(`/hunts/${huntId}/baseline`),
    enabled: huntId != null,
    staleTime: 60_000, // baseline data doesn't change often
  });

  const segments = data?.segments ?? [];

  const match = useCallback(
    (offer: MatchableOffer) => matchToSegment(offerMatchText(offer), segments),
    [segments],
  );

  const assess = useCallback(
    (price: number | null, offer: MatchableOffer) => {
      const m = matchToSegment(offerMatchText(offer), segments);
      return assessPrice(price, m?.segment ?? null);
    },
    [segments],
  );

  const belowBaselineCount = useCallback(
    (offers: Array<MatchableOffer & { current_price: number | null }>) => {
      return offers.filter((o) => assess(o.current_price, o) === 'good').length;
    },
    [assess],
  );

  const isStale = segments.some(
    (s) =>
      s.latest_data &&
      Date.now() - new Date(s.latest_data + 'Z').getTime() > 14 * 24 * 60 * 60 * 1000,
  );

  return {
    segments,
    isLoading,
    match,
    assess,
    belowBaselineCount,
    isStale,
    hasSegments: segments.length > 0,
  };
}
