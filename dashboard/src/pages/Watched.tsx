import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useMemo } from 'react';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import {
  formatPrice,
  formatPercent,
  priceChange,
  formatCountdown,
  getCountdownUrgency,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import PageHeader from '@/components/layout/PageHeader';
import type { WatchedOffer, HuntBaselineData } from '@shared/types';
import { useState, useEffect } from 'react';
import { useFlash } from '@/hooks/use-flash';
import {
  matchToSegment,
  offerMatchText,
  assessPrice,
  assessmentColor,
  assessmentLabel,
} from '@/lib/segment-matcher';

/**
 * Compact chip row for an offer's parsed watch_conditions: price keys render
 * as neutral chips ("alert < £12,000", "max £15,000"), verify_required
 * entries (unverified must-haves) as warning chips ("verify: …").
 */
function WatchConditionChips({
  conditions,
}: {
  conditions: Record<string, unknown> | null;
}) {
  if (!conditions) return null;

  const chips: Array<{ key: string; label: string; warning?: boolean }> = [];
  if (typeof conditions.alert_if_price_below_gbp === 'number') {
    chips.push({
      key: 'alert_below',
      label: `alert < ${formatPrice(conditions.alert_if_price_below_gbp)}`,
    });
  }
  if (typeof conditions.max_price === 'number') {
    chips.push({
      key: 'max_price',
      label: `max ${formatPrice(conditions.max_price)}`,
    });
  }
  if (Array.isArray(conditions.verify_required)) {
    for (const item of conditions.verify_required) {
      if (typeof item === 'string') {
        chips.push({ key: `verify-${item}`, label: `verify: ${item}`, warning: true });
      }
    }
  }
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={cn(
            'inline-flex items-center px-1.5 py-0.5 rounded text-tiny',
            chip.warning
              ? 'bg-warning-muted text-warning'
              : 'bg-raised border border-zinc-700 text-zinc-400',
          )}
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
}

export default function Watched() {
  const navigate = useNavigate();
  const [, setTick] = useState(0);
  const { getFlashClass } = useFlash();

  const { data: offers, isLoading } = useQuery({
    queryKey: queryKeys.watched,
    queryFn: () => apiGet<WatchedOffer[]>('/watched'),
    refetchInterval: 30_000,
  });

  // Get unique hunt IDs from offers
  const huntIds = useMemo(() => {
    if (!offers) return [];
    return [...new Set(offers.map((o) => o.hunt_id))];
  }, [offers]);

  // Fetch baseline for each hunt (uses single query with all IDs)
  const { data: baselines } = useQuery({
    queryKey: ['baselines', huntIds],
    queryFn: async () => {
      const results = new Map<number, HuntBaselineData>();
      await Promise.all(
        huntIds.map(async (id) => {
          try {
            const data = await apiGet<HuntBaselineData>(`/hunts/${id}/baseline`);
            results.set(id, data);
          } catch { /* skip */ }
        }),
      );
      return results;
    },
    enabled: huntIds.length > 0,
    staleTime: 60_000,
  });

  // Tick every second for countdown timers
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Helper to get segment match for an offer
  const getSegmentInfo = (offer: WatchedOffer) => {
    const baseline = baselines?.get(offer.hunt_id);
    if (!baseline?.segments.length) return null;
    const match = matchToSegment(offerMatchText(offer), baseline.segments);
    if (!match) return null;
    const assessment = assessPrice(offer.current_price, match.segment);
    return { ...match, assessment };
  };

  return (
    <div>
      <PageHeader
        title={`Watched Items${offers ? ` (${offers.length})` : ''}`}
      />

      {isLoading && (
        <div className="h-64 bg-surface border border-zinc-800 rounded-lg animate-pulse" />
      )}

      {offers && offers.length === 0 && (
        <div className="text-center py-12 text-zinc-500">
          <p className="text-sm">No items being watched</p>
          <p className="text-xs mt-1">
            The agent will start watching items as it evaluates offers
          </p>
        </div>
      )}

      {offers && offers.length > 0 && (
        <div className="bg-surface border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
                <th className="w-8 py-2.5 px-2" />
                <th className="text-left py-2.5 px-3 font-medium">Title</th>
                <th className="text-left py-2.5 px-3 font-medium">Segment</th>
                <th className="text-right py-2.5 px-3 font-medium">Price</th>
                <th className="text-center py-2.5 px-3 font-medium">
                  vs Base
                </th>
                <th className="text-right py-2.5 px-3 font-medium">Change</th>
                <th className="text-left py-2.5 px-3 font-medium">
                  Condition
                </th>
                <th className="text-center py-2.5 px-3 font-medium">
                  Format
                </th>
                <th className="text-right py-2.5 px-3 font-medium">Bids</th>
                <th className="text-right py-2.5 px-3 font-medium">Ends</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {offers.map((offer) => {
                const change = priceChange(
                  offer.current_price,
                  offer.first_price,
                );
                const urgency = getCountdownUrgency(offer.auction_end_time);
                const segInfo = getSegmentInfo(offer);

                return (
                  <tr
                    key={`${offer.id}-${offer.hunt_id}`}
                    onClick={() => navigate(`/offers/${offer.id}`)}
                    className={cn(
                      'hover:bg-raised cursor-pointer transition-colors',
                      urgency === 'critical' &&
                        'border-l-2 border-l-danger',
                      urgency === 'warning' &&
                        'border-l-2 border-l-warning',
                    )}
                  >
                    {/* Urgency dot */}
                    <td className="py-2.5 px-2 text-center">
                      {urgency === 'critical' && (
                        <div className="w-2 h-2 rounded-full bg-danger mx-auto" />
                      )}
                      {urgency === 'warning' && (
                        <div className="w-2 h-2 rounded-full bg-warning mx-auto" />
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-zinc-300 max-w-xs">
                      <div className="truncate">{offer.title}</div>
                      <WatchConditionChips conditions={offer.watch_conditions} />
                    </td>
                    {/* Segment */}
                    <td className="py-2.5 px-3 text-xs text-zinc-500 max-w-[120px] truncate">
                      {segInfo ? (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/hunts/${offer.hunt_id}/prices`);
                          }}
                          className="hover:text-zinc-300 cursor-pointer"
                          title={segInfo.segment.name}
                        >
                          {segInfo.segment.name}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        'py-2.5 px-3 text-right font-mono text-zinc-50',
                        getFlashClass(offer.id),
                      )}
                    >
                      {formatPrice(offer.current_price)}
                    </td>
                    {/* vs Baseline */}
                    <td className="py-2.5 px-3 text-center text-xs font-mono">
                      {segInfo?.assessment ? (
                        <span
                          className={assessmentColor(segInfo.assessment)}
                          title={
                            segInfo.segment.price_low != null
                              ? `Segment: ${formatPrice(segInfo.segment.price_low)} – ${formatPrice(segInfo.segment.price_high)}`
                              : undefined
                          }
                        >
                          {segInfo.assessment === 'good' ? '▼' : segInfo.assessment === 'high' ? '▲' : '—'}
                          {' '}
                          {assessmentLabel(segInfo.assessment)}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        'py-2.5 px-3 text-right font-mono text-xs',
                        change != null && change < 0 && 'text-success',
                        change != null && change > 0 && 'text-danger',
                        (change == null || change === 0) && 'text-zinc-500',
                      )}
                    >
                      {change != null ? formatPercent(change) : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-zinc-400 text-xs">
                      {offer.condition || '—'}
                    </td>
                    <td className="py-2.5 px-3 text-center text-zinc-400 text-xs">
                      {offer.buying_format?.includes('AUCTION')
                        ? 'Auc.'
                        : offer.buying_format?.includes('FIXED')
                          ? 'BIN'
                          : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-zinc-400 text-xs">
                      {offer.bid_count ?? '—'}
                    </td>
                    <td
                      className={cn(
                        'py-2.5 px-3 text-right font-mono text-xs',
                        urgency === 'critical' &&
                          'text-danger font-semibold',
                        urgency === 'warning' && 'text-warning',
                        urgency === 'normal' && 'text-zinc-400',
                        urgency === 'none' && 'text-zinc-600',
                      )}
                    >
                      {formatCountdown(offer.auction_end_time) || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
