import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatPrice, formatRelativeTime, formatCountdown, getCountdownUrgency } from '@/lib/format';
import { cn } from '@/lib/utils';
import { matchToSegment, offerMatchText, assessPrice, assessmentColor } from '@/lib/segment-matcher';
import StatusBadge from '@/components/shared/StatusBadge';
import PriceTierBar, { priceToPct } from '@/components/shared/PriceTierBar';
import {
  getVerticalUI,
  type ParsedBaselineOffer,
} from '@/lib/verticals/registry';
import { parseCarAttributes, parseFeatures } from '@/lib/attributes';
import {
  fitLinearTrend,
  residualDealThreshold,
  type LinearTrendFit,
} from '@/lib/regression';
import TargetsStrip from '@/components/verticals/cars/TargetsStrip';
import type {
  HuntBaselineData,
  HuntTargetsData,
  SegmentWithStats,
  BaselinePrice,
} from '@shared/types';
import { AlertTriangle, ChevronDown, ChevronUp, Info } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

// Segment band colors
const SEGMENT_COLORS = [
  '#22C55E', // green
  '#3B82F6', // blue
  '#EAB308', // yellow
  '#EC4899', // pink
  '#F97316', // orange
  '#06B6D4', // cyan
];

function isAuction(offer: ParsedBaselineOffer) {
  return offer.buying_format?.includes('AUCTION') ?? false;
}

function offerDotClasses(assessment: ReturnType<typeof assessPrice>, auction: boolean) {
  if (auction) {
    const border = assessment === 'good' ? 'border-success' : assessment === 'high' ? 'border-danger' : 'border-white';
    return `bg-transparent border-2 ${border}`;
  }
  const fill = assessment === 'good' ? 'bg-success' : assessment === 'high' ? 'bg-danger' : 'bg-white';
  return `border border-zinc-900 ${fill}`;
}

/**
 * Tooltip suffix for an offer dot: signed residual vs the segment's trend fit
 * when computable (cars). Empty string otherwise — band-only verticals see
 * exactly the original tooltip text.
 */
function residualTitleSuffix(
  offer: ParsedBaselineOffer,
  fit: LinearTrendFit | undefined,
): string {
  if (!fit || offer.current_price == null || offer.carAttrs?.mileage_num == null) return '';
  const res = offer.current_price - fit.predict(offer.carAttrs.mileage_num);
  const amount = `£${Math.round(Math.abs(res)).toLocaleString('en-GB')}`;
  return `\n${amount} ${res <= 0 ? 'under' : 'over'} trend for its mileage`;
}

interface MarketTabProps {
  huntId: number;
  budget: number | null;
  vertical?: string;
}

export default function MarketTab({ huntId, budget, vertical }: MarketTabProps) {
  const ui = getVerticalUI(vertical);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [expandedSegment, setExpandedSegment] = useState<number | null>(null);

  const { data: baseline, isLoading } = useQuery({
    queryKey: queryKeys.hunts.baseline(huntId),
    queryFn: () => apiGet<HuntBaselineData>(`/hunts/${huntId}/baseline`),
    staleTime: 60_000,
  });

  const { data: targetsData } = useQuery({
    queryKey: queryKeys.hunts.targets(huntId),
    queryFn: () => apiGet<HuntTargetsData>(`/hunts/${huntId}/targets`),
    staleTime: 60_000,
    enabled: ui.supportsMustHaveVerification || ui.supportsSpecExplorer,
  });
  const mustHaves = targetsData?.must_have ?? [];
  const targets = targetsData?.targets ?? [];

  // --- Parse offers ONCE into typed rows (superset of the raw row) ---
  const parsedOffers = useMemo<ParsedBaselineOffer[]>(() => {
    if (!baseline) return [];
    const wantsCarAttrs =
      ui.primaryDealSignal === 'trend-residual' ||
      ui.supportsSourcePriceOpinion ||
      ui.supportsMustHaveVerification;
    return baseline.active_offer_prices.map((offer) =>
      wantsCarAttrs
        ? {
            ...offer,
            carAttrs: parseCarAttributes(offer.attributes),
            features: parseFeatures(offer.attributes),
          }
        : offer,
    );
  }, [baseline, ui]);

  // --- Tag filtering ---
  const allTags = useMemo(() => {
    if (!baseline?.segments.length) return [];
    const tagSet = new Map<string, number>();
    for (const seg of baseline.segments) {
      try {
        const tags = JSON.parse(seg.tags) as string[];
        for (const t of tags) tagSet.set(t, (tagSet.get(t) || 0) + 1);
      } catch { /* skip */ }
    }
    return Array.from(tagSet.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);
  }, [baseline]);

  const filteredSegments = useMemo(() => {
    if (!baseline?.segments.length) return [];
    if (selectedTags.size === 0) return baseline.segments;
    return baseline.segments.filter((seg) => {
      try {
        const tags = JSON.parse(seg.tags) as string[];
        return tags.some((t) => selectedTags.has(t));
      } catch { return false; }
    });
  }, [baseline, selectedTags]);

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  };

  // --- Offer-to-segment matching ---
  const { offersBySegment, unmatchedOffers } = useMemo(() => {
    const map = new Map<number, ParsedBaselineOffer[]>();
    const unmatched: ParsedBaselineOffer[] = [];
    if (!baseline) return { offersBySegment: map, unmatchedOffers: unmatched };

    for (const offer of parsedOffers) {
      if (offer.current_price == null) continue;
      const match = matchToSegment(offerMatchText(offer), baseline.segments);
      if (match) {
        const list = map.get(match.segment.id) || [];
        list.push(offer);
        map.set(match.segment.id, list);
      } else {
        unmatched.push(offer);
      }
    }
    return { offersBySegment: map, unmatchedOffers: unmatched };
  }, [baseline, parsedOffers]);

  // --- Per-segment trend fits (trend-residual verticals only) ---
  const segmentFits = useMemo(() => {
    const fits = new Map<number, LinearTrendFit>();
    if (ui.primaryDealSignal !== 'trend-residual') return fits;
    for (const [segmentId, offers] of offersBySegment) {
      const fit = fitLinearTrend(
        offers
          .filter((o) => o.current_price != null && o.carAttrs?.mileage_num != null)
          .map((o) => ({ x: o.carAttrs!.mileage_num!, y: o.current_price! })),
      );
      if (fit) fits.set(segmentId, fit);
    }
    return fits;
  }, [offersBySegment, ui]);

  const underTrendCount = useMemo(() => {
    if (ui.primaryDealSignal !== 'trend-residual') return 0;
    let count = 0;
    for (const [segmentId, offers] of offersBySegment) {
      const fit = segmentFits.get(segmentId);
      if (!fit) continue;
      for (const offer of offers) {
        if (offer.current_price == null || offer.carAttrs?.mileage_num == null) continue;
        const predicted = fit.predict(offer.carAttrs.mileage_num);
        if (offer.current_price - predicted <= -residualDealThreshold(predicted)) count++;
      }
    }
    return count;
  }, [offersBySegment, segmentFits, ui]);

  // --- Spec-sheet links: segments whose tags contain a known target_key ---
  const specTargetBySegment = useMemo(() => {
    const map = new Map<number, string>();
    if (!ui.supportsSpecExplorer || !baseline || targets.length === 0) return map;
    for (const seg of baseline.segments) {
      try {
        const tags = JSON.parse(seg.tags) as string[];
        const hit = targets.find((t) =>
          tags.some(
            (tag) => typeof tag === 'string' && tag.toLowerCase() === t.target_key.toLowerCase(),
          ),
        );
        if (hit) map.set(seg.id, hit.target_key);
      } catch { /* skip */ }
    }
    return map;
  }, [baseline, targets, ui]);

  // --- Deal summary stats ---
  const summary = useMemo(() => {
    if (!baseline) return null;
    let goodDeals = 0;
    let urgentAuctions = 0;
    const urgentItems: Array<{ offer_id: number; title: string; price: number; countdown: string }> = [];

    for (const offer of parsedOffers) {
      if (offer.current_price == null) continue;
      const match = matchToSegment(offerMatchText(offer), baseline.segments);
      if (match) {
        const assessment = assessPrice(offer.current_price, match.segment);
        if (assessment === 'good') goodDeals++;
      }
      // Check for urgent auctions among all offers
      if (ui.showAuctionUrgency && isAuction(offer) && offer.auction_end_time) {
        const urgency = getCountdownUrgency(offer.auction_end_time);
        if (urgency === 'critical' || urgency === 'warning') {
          urgentAuctions++;
          if (urgentItems.length < 2) {
            urgentItems.push({
              offer_id: offer.offer_id,
              title: offer.title,
              price: offer.current_price!,
              countdown: formatCountdown(offer.auction_end_time) || '',
            });
          }
        }
      }
    }

    // Price spread
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const seg of baseline.segments) {
      if (seg.price_low != null) minPrice = Math.min(minPrice, seg.price_low);
      if (seg.price_high != null) maxPrice = Math.max(maxPrice, seg.price_high);
    }

    return {
      goodDeals,
      urgentAuctions,
      urgentItems,
      activeOffers: baseline.active_offer_prices.length,
      priceSpread: minPrice < Infinity ? { min: minPrice, max: maxPrice } : null,
      segmentCount: baseline.segments.length,
    };
  }, [baseline, parsedOffers, ui]);

  const hasSegments = baseline && baseline.segments.length > 0;

  const AnalyticsPanel = ui.SegmentAnalyticsPanel;
  const ExtraPanel = ui.MarketExtraPanel;

  return (
    <div className="animate-feed-in space-y-6">
      {/* Deal Summary Strip */}
      {summary && hasSegments && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          {ui.primaryDealSignal === 'trend-residual' ? (
            <>
              <span className={cn('font-mono', underTrendCount > 0 ? 'text-success' : 'text-zinc-500')}>
                {underTrendCount} <span className="text-xs font-sans">under trend</span>
              </span>
              <span className="font-mono text-xs text-zinc-500">
                {summary.goodDeals} <span className="font-sans">below band</span>
              </span>
            </>
          ) : (
            <span className={cn('font-mono', summary.goodDeals > 0 ? 'text-success' : 'text-zinc-500')}>
              {summary.goodDeals} <span className="text-xs font-sans">good deal{summary.goodDeals !== 1 ? 's' : ''}</span>
            </span>
          )}
          {summary.urgentAuctions > 0 && (
            <span className="text-warning font-mono">
              {summary.urgentAuctions} <span className="text-xs font-sans">auction{summary.urgentAuctions !== 1 ? 's' : ''} ending soon</span>
            </span>
          )}
          {summary.priceSpread && (
            <span className="font-mono text-zinc-400">
              {formatPrice(summary.priceSpread.min)} – {formatPrice(summary.priceSpread.max)}
              <span className="text-xs font-sans text-zinc-500 ml-1">range</span>
            </span>
          )}
          <span className="font-mono text-zinc-500">
            {summary.activeOffers} <span className="text-xs font-sans">tracked</span>
          </span>
        </div>
      )}

      {/* Targets strip — model chips linking to Spec Explorer */}
      {ui.supportsSpecExplorer && targets.length > 0 && (
        <TargetsStrip huntId={huntId} targets={targets} />
      )}

      {/* Attention row — urgent items */}
      {summary && summary.urgentItems.length > 0 && (
        <div className="border-l-2 border-warning bg-warning/5 rounded-r-lg px-4 py-3 space-y-2">
          {summary.urgentItems.map((item) => (
            <Link
              key={item.offer_id}
              to={`/offers/${item.offer_id}`}
              className="flex items-center justify-between text-sm hover:text-zinc-200 transition-colors"
            >
              <span className="text-zinc-300 truncate mr-4">{item.title}</span>
              <span className="flex items-center gap-3 shrink-0">
                <span className="font-mono text-zinc-200">{formatPrice(item.price)}</span>
                <span className="font-mono text-xs text-warning">{item.countdown}</span>
              </span>
            </Link>
          ))}
        </div>
      )}

      {/* Tag filter */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 items-center">
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => toggleTag(tag)}
              className={cn(
                'px-2 py-1 rounded text-xs transition-colors',
                selectedTags.has(tag) ? 'bg-accent text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200',
              )}
            >
              {tag}
            </button>
          ))}
          {selectedTags.size > 0 && (
            <button onClick={() => setSelectedTags(new Set())} className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300">
              Clear
            </button>
          )}
        </div>
      )}

      {isLoading && (
        <div className="space-y-4">
          <div className="h-40 bg-surface border border-zinc-800 rounded-lg animate-pulse" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {[1, 2].map((i) => (
              <div key={i} className="h-48 bg-surface border border-zinc-800 rounded-lg animate-pulse" />
            ))}
          </div>
        </div>
      )}

      {/* Market Overview Bar */}
      {hasSegments && filteredSegments.length > 0 && (
        <MarketOverview
          segments={filteredSegments}
          activeOffers={parsedOffers}
          offersBySegment={offersBySegment}
          budget={budget}
          showAuctionUrgency={ui.showAuctionUrgency}
          segmentFits={segmentFits}
        />
      )}

      {/* Vertical-specific hunt-wide panel (e.g. cars source-opinion cross-check) */}
      {hasSegments && ExtraPanel && (
        <ExtraPanel
          huntId={huntId}
          segments={filteredSegments}
          offersBySegment={offersBySegment}
        />
      )}

      {/* Segment Analytics Cards */}
      {hasSegments && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filteredSegments.map((segment, i) => (
            <SegmentCard
              key={segment.id}
              segment={segment}
              huntId={huntId}
              color={SEGMENT_COLORS[i % SEGMENT_COLORS.length]}
              matchedOffers={offersBySegment.get(segment.id) || []}
              budget={budget}
              expanded={expandedSegment === segment.id}
              onToggle={() => setExpandedSegment(expandedSegment === segment.id ? null : segment.id)}
              showConditionBreakdown={ui.showConditionBreakdown}
              showAuctionUrgency={ui.showAuctionUrgency}
              fit={segmentFits.get(segment.id)}
              specSheetTargetKey={specTargetBySegment.get(segment.id) ?? null}
              analyticsPanel={
                AnalyticsPanel ? (
                  <AnalyticsPanel
                    segment={segment}
                    offers={offersBySegment.get(segment.id) || []}
                    budget={budget}
                    mustHaves={mustHaves}
                  />
                ) : undefined
              }
            />
          ))}
        </div>
      )}

      {/* Unmatched offers */}
      {unmatchedOffers.length > 0 && (
        <div className="bg-surface border border-warning/20 rounded-lg p-4">
          <h3 className="text-sm font-medium text-warning mb-3 flex items-center gap-1.5">
            <AlertTriangle size={14} />
            Unmatched Offers ({unmatchedOffers.length})
          </h3>
          <div className="space-y-2">
            {unmatchedOffers.map((offer) => (
              <div key={offer.offer_id} className="flex items-center justify-between text-xs">
                <span className="text-zinc-400 truncate max-w-[70%]">{offer.title}</span>
                <span className="font-mono text-zinc-300">{formatPrice(offer.current_price)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unclassified baseline warning */}
      {baseline && baseline.unclassified_count > 0 && (
        <div className="bg-surface border border-zinc-700 rounded-lg px-4 py-3 flex items-center gap-2 text-xs text-zinc-500">
          <Info size={14} className="shrink-0" />
          {baseline.unclassified_count} baseline data point{baseline.unclassified_count !== 1 ? 's' : ''} not assigned to any segment
        </div>
      )}

      {!hasSegments && !isLoading && (
        <div className="text-center py-12 text-zinc-500 text-sm">
          No market segments defined for this hunt
        </div>
      )}
    </div>
  );
}

// --- Market Overview Bar ---

function MarketOverview({
  segments,
  activeOffers,
  offersBySegment,
  budget,
  showAuctionUrgency,
  segmentFits,
}: {
  segments: SegmentWithStats[];
  activeOffers: ParsedBaselineOffer[];
  offersBySegment: Map<number, ParsedBaselineOffer[]>;
  budget: number | null;
  showAuctionUrgency: boolean;
  segmentFits: Map<number, LinearTrendFit>;
}) {
  const { axisMin, axisMax, range } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const seg of segments) {
      if (seg.price_low != null) min = Math.min(min, seg.price_low);
      if (seg.price_high != null) max = Math.max(max, seg.price_high);
    }
    for (const o of activeOffers) {
      if (o.current_price != null) {
        min = Math.min(min, o.current_price);
        max = Math.max(max, o.current_price);
      }
    }
    if (budget != null) {
      min = Math.min(min, budget);
      max = Math.max(max, budget);
    }
    const r = max - min || 1;
    return { axisMin: min - r * 0.05, axisMax: max + r * 0.05, range: r * 1.1 };
  }, [segments, activeOffers, budget]);

  const pct = (v: number) => ((v - axisMin) / range) * 100;

  const offerPositions = useMemo(() => {
    return activeOffers
      .filter((o) => o.current_price != null)
      .map((o) => {
        const match = matchToSegment(offerMatchText(o), segments);
        const assessment = match ? assessPrice(o.current_price, match.segment) : null;
        const auction = showAuctionUrgency && isAuction(o);
        return { ...o, assessment, auction, left: pct(o.current_price!) };
      });
  }, [activeOffers, segments, axisMin, range, showAuctionUrgency]);

  const ticks = useMemo(() => {
    const step = Math.pow(10, Math.floor(Math.log10(range / 4)));
    const niceStep = range / step < 6 ? step : step * 2;
    const first = Math.ceil(axisMin / niceStep) * niceStep;
    const marks: number[] = [];
    for (let v = first; v <= axisMax; v += niceStep) marks.push(v);
    return marks;
  }, [axisMin, axisMax, range]);

  return (
    <div className="bg-surface border border-zinc-800 rounded-lg p-4">
      <div className="flex items-start justify-between mb-4">
        <h2 className="text-heading text-zinc-300">Market Overview</h2>
        <div className="flex flex-wrap items-center gap-3 text-tiny text-zinc-500">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-success border border-zinc-900" />
            Good deal
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-white border border-zinc-900" />
            Fair
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-danger border border-zinc-900" />
            Overpriced
          </span>
          {showAuctionUrgency && (
            <span className="flex items-center gap-1.5 ml-1 pl-2 border-l border-zinc-700">
              <span className="w-2.5 h-2.5 rounded-full bg-transparent border-2 border-zinc-400" />
              Auction
            </span>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {segments.map((seg, i) => {
          if (seg.price_low == null || seg.price_high == null) return null;
          const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
          const opacity = seg.confidence === 'HIGH' ? 1 : seg.confidence === 'MEDIUM' ? 0.7 : 0.4;

          return (
            <div key={seg.id} className="flex items-center gap-3">
              <span className="text-xs text-zinc-400 w-40 shrink-0 truncate" title={seg.name}>
                {seg.name}
              </span>
              <div className="relative flex-1 h-6">
                <div className="absolute inset-x-0 top-1/2 -translate-y-px h-px bg-zinc-800" />
                <div
                  className="absolute top-1 h-4 rounded-sm"
                  style={{
                    left: `${pct(seg.price_low)}%`,
                    width: `${Math.max(pct(seg.price_high) - pct(seg.price_low), 0.5)}%`,
                    backgroundColor: color,
                    opacity: opacity * 0.25,
                  }}
                />
                <div
                  className="absolute top-1 h-4 rounded-sm border"
                  style={{
                    left: `${pct(seg.price_low)}%`,
                    width: `${Math.max(pct(seg.price_high) - pct(seg.price_low), 0.5)}%`,
                    borderColor: color,
                    opacity: opacity * 0.5,
                  }}
                />
                {seg.price_mid != null && (
                  <div
                    className="absolute top-0.5 w-1 h-5 rounded-full"
                    style={{ left: `${pct(seg.price_mid)}%`, backgroundColor: color, opacity }}
                    title={`Mid: ${formatPrice(seg.price_mid)}`}
                  />
                )}
                {(offersBySegment.get(seg.id) || []).map((offer) => {
                  if (offer.current_price == null) return null;
                  const assessment = assessPrice(offer.current_price, seg);
                  const auction = showAuctionUrgency && isAuction(offer);
                  return (
                    <Link
                      key={offer.offer_id}
                      to={`/offers/${offer.offer_id}`}
                      className={cn(
                        'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full transition-transform hover:scale-150 z-10',
                        offerDotClasses(assessment, auction),
                      )}
                      style={{ left: `${pct(offer.current_price)}%` }}
                      title={`${offer.title}\n${formatPrice(offer.current_price)}${auction ? ' (Auction)' : ''}${residualTitleSuffix(offer, segmentFits.get(seg.id))}`}
                    />
                  );
                })}
                {budget != null && i === 0 && (
                  <div
                    className="absolute -top-1 h-8 w-px border-l border-dashed border-red-500/60"
                    style={{ left: `${pct(budget)}%` }}
                    title={`Budget: ${formatPrice(budget)}`}
                  />
                )}
              </div>
            </div>
          );
        })}

        {/* Unmatched offers row */}
        {offerPositions.filter((o) => !segments.some((s) => offersBySegment.get(s.id)?.some((m) => m.offer_id === o.offer_id))).length > 0 && (
          <div className="flex items-center gap-3 pt-1 border-t border-zinc-800/50">
            <span className="text-xs text-zinc-500 w-40 shrink-0">Unmatched</span>
            <div className="relative flex-1 h-5">
              <div className="absolute inset-x-0 top-1/2 -translate-y-px h-px bg-zinc-800" />
              {offerPositions
                .filter((o) => !segments.some((s) => offersBySegment.get(s.id)?.some((m) => m.offer_id === o.offer_id)))
                .map((o) => (
                <Link
                  key={o.offer_id}
                  to={`/offers/${o.offer_id}`}
                  className={cn(
                    'absolute top-1 w-2.5 h-2.5 rounded-full -translate-x-1 transition-transform hover:scale-150',
                    offerDotClasses(o.assessment, o.auction),
                  )}
                  style={{ left: `${o.left}%` }}
                  title={`${o.title}\n${formatPrice(o.current_price)}${o.auction ? ' (Auction)' : ''}`}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Price axis ticks */}
      <div className="flex items-center gap-3 mt-1">
        <div className="w-40 shrink-0" />
        <div className="relative flex-1 h-4">
          {ticks.map((v) => (
            <span
              key={v}
              className="absolute text-tiny font-mono text-zinc-600 -translate-x-1/2"
              style={{ left: `${pct(v)}%` }}
            >
              {formatPrice(v)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Condition Breakdown (computers vertical only) ---

function ConditionBreakdown({
  conditions,
  min,
  max,
}: {
  conditions: Array<{ condition: string; count: number; min: number; max: number; median: number }>;
  min: number;
  max: number;
}) {
  const segRange = max - min || 1;
  return (
    <div className="flex-1 min-w-0">
      <h4 className="text-xs text-zinc-500 mb-2">By Condition</h4>
      <div className="space-y-2.5">
        {conditions.map((cd) => {
          const minPct = ((cd.min - min) / segRange) * 100;
          const widthPct = ((cd.max - cd.min) / segRange) * 100 || 2;
          const medianPct = ((cd.median - min) / segRange) * 100;
          return (
            <div key={cd.condition}>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-xs text-zinc-400">
                  {cd.condition} <span className="text-zinc-600">({cd.count})</span>
                </span>
                <span className="font-mono text-tiny text-zinc-500">
                  {formatPrice(cd.min)} – {formatPrice(cd.max)}
                </span>
              </div>
              <div className="relative h-1.5 bg-zinc-800 rounded-full">
                <div
                  className="absolute h-1.5 bg-accent/40 rounded-full"
                  style={{ left: `${minPct}%`, width: `${Math.max(widthPct, 2)}%` }}
                />
                <div
                  className="absolute w-1 h-2.5 bg-accent rounded-full -top-0.5"
                  style={{ left: `${medianPct}%` }}
                  title={`Median: ${formatPrice(cd.median)}`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Segment Card ---

function SegmentCard({
  segment,
  huntId,
  color,
  matchedOffers,
  budget,
  expanded,
  onToggle,
  showConditionBreakdown = true,
  showAuctionUrgency = true,
  fit,
  specSheetTargetKey = null,
  analyticsPanel,
}: {
  segment: SegmentWithStats;
  huntId: number;
  color: string;
  matchedOffers: ParsedBaselineOffer[];
  budget: number | null;
  expanded: boolean;
  onToggle: () => void;
  showConditionBreakdown?: boolean;
  showAuctionUrgency?: boolean;
  /** Segment trend fit (trend-residual verticals) — enriches dot tooltips. */
  fit?: LinearTrendFit;
  /** When set, the card links to this target's Spec Explorer page. */
  specSheetTargetKey?: string | null;
  /** Vertical-specific analytics rendered above the comps histogram. */
  analyticsPanel?: React.ReactNode;
}) {
  const tags: string[] = (() => {
    try { return JSON.parse(segment.tags); } catch { return []; }
  })();

  const isStale = segment.latest_data &&
    Date.now() - new Date(segment.latest_data + 'Z').getTime() > 14 * 24 * 60 * 60 * 1000;

  const { data: prices } = useQuery({
    queryKey: queryKeys.hunts.segmentPrices(huntId, segment.id),
    queryFn: () => apiGet<BaselinePrice[]>(`/hunts/${huntId}/segments/${segment.id}/prices`),
    enabled: expanded,
  });

  const analytics = useMemo(() => {
    if (!prices?.length) return null;

    const pricedItems = prices.map((p) => ({
      price: (p.total_landed_gbp ?? p.price) as number,
      condition: p.condition || 'Unknown',
      sourceType: p.source_type,
    }));

    const allPrices = pricedItems.map((p) => p.price);
    const min = Math.min(...allPrices);
    const max = Math.max(...allPrices);
    const range = max - min || 1;
    const bucketCount = Math.min(10, Math.max(5, Math.ceil(allPrices.length / 3)));
    const bucketSize = range / bucketCount;
    const histogram = Array.from({ length: bucketCount }, (_, i) => ({
      label: formatPrice(min + i * bucketSize),
      sold: 0,
      active: 0,
    }));
    for (const item of pricedItems) {
      const idx = Math.min(Math.floor((item.price - min) / bucketSize), bucketCount - 1);
      if (item.sourceType === 'sold') histogram[idx].sold++;
      else histogram[idx].active++;
    }

    const condGroups = new Map<string, number[]>();
    for (const item of pricedItems) {
      if (!condGroups.has(item.condition)) condGroups.set(item.condition, []);
      condGroups.get(item.condition)!.push(item.price);
    }
    const conditions = Array.from(condGroups.entries())
      .map(([condition, cPrices]) => {
        const sorted = [...cPrices].sort((a, b) => a - b);
        const median = sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];
        return { condition, count: cPrices.length, min: sorted[0], max: sorted[sorted.length - 1], median };
      })
      .sort((a, b) => b.count - a.count);

    return { histogram, conditions, min, max };
  }, [prices]);

  const hasPriceTier = segment.price_low != null && segment.price_high != null;
  const hasBaselineAnalytics = !!(prices && prices.length > 0 && analytics);

  return (
    <div className="bg-surface border border-zinc-800 rounded-lg p-4" style={{ borderTopColor: color, borderTopWidth: 2 }}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="text-heading text-zinc-200">{segment.name}</h3>
          {segment.description && <p className="text-xs text-zinc-500 mt-0.5">{segment.description}</p>}
        </div>
        {specSheetTargetKey ? (
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className="text-xs text-zinc-500 whitespace-nowrap" title={`Data confidence: ${segment.confidence.toLowerCase()} (${segment.sample_size} data points)`}>
              {segment.sample_size} sample{segment.sample_size !== 1 ? 's' : ''}
            </span>
            <Link
              to={`/hunts/${huntId}/models/${encodeURIComponent(specSheetTargetKey)}`}
              className="text-xs text-accent hover:text-accent-hover whitespace-nowrap transition-colors"
            >
              Spec sheet →
            </Link>
          </div>
        ) : (
          <span className="text-xs text-zinc-500 whitespace-nowrap shrink-0" title={`Data confidence: ${segment.confidence.toLowerCase()} (${segment.sample_size} data points)`}>
            {segment.sample_size} sample{segment.sample_size !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {hasPriceTier && (
        <div className="mb-2">
          <PriceTierBar segment={segment}>
            {matchedOffers.map((offer) => {
              if (offer.current_price == null) return null;
              const assessment = assessPrice(offer.current_price, segment);
              const auction = showAuctionUrgency && isAuction(offer);
              const left = priceToPct(offer.current_price, segment);
              return (
                <Link
                  key={offer.offer_id}
                  to={`/offers/${offer.offer_id}`}
                  className={cn(
                    'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full transition-transform hover:scale-150 z-10',
                    offerDotClasses(assessment, auction),
                  )}
                  style={{ left: `${left}%` }}
                  title={`${offer.title}\n${formatPrice(offer.current_price)}${auction ? ' (Auction)' : ''}${residualTitleSuffix(offer, fit)}`}
                />
              );
            })}
          </PriceTierBar>
        </div>
      )}

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {tags.map((tag) => (
            <span key={tag} className="bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded text-xs">{tag}</span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4 text-xs text-zinc-500 mb-2">
        <span>{segment.sold_count} sold / {segment.active_count} active</span>
        {segment.latest_data && (
          <span className={cn(isStale && 'text-warning')}>
            {isStale && <AlertTriangle size={10} className="inline mr-1" />}
            Updated {formatRelativeTime(segment.latest_data)}
          </span>
        )}
      </div>

      {segment.notes && <p className="text-xs text-zinc-500 italic mb-2">{segment.notes}</p>}

      <button onClick={onToggle} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {expanded ? 'Hide' : 'Show'} analytics ({segment.data_point_count})
      </button>

      {expanded && (analyticsPanel || hasBaselineAnalytics) && (
        <div className="mt-3 border-t border-zinc-800 pt-3 space-y-4">
          {analyticsPanel}

          {hasBaselineAnalytics && analytics && (
            <>
              <div className="flex flex-col lg:flex-row gap-4">
                <div className="flex-1 min-w-0">
                  <h4 className="text-xs text-zinc-500 mb-2">Price Distribution</h4>
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart data={analytics.histogram} barCategoryGap="15%">
                      <CartesianGrid horizontal vertical={false} stroke="#27272A" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 9, fill: '#71717A' }}
                        axisLine={false}
                        tickLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        tick={{ fontSize: 9, fill: '#71717A' }}
                        axisLine={false}
                        tickLine={false}
                        width={20}
                        allowDecimals={false}
                      />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#3F3F46', border: '1px solid #52525B', borderRadius: '6px', fontSize: '11px' }}
                        labelStyle={{ color: '#A1A1AA' }}
                      />
                      <Bar dataKey="sold" stackId="a" fill="#22C55E" opacity={0.6} radius={[0, 0, 0, 0]} name="Sold" />
                      <Bar dataKey="active" stackId="a" fill="#3B82F6" opacity={0.6} radius={[2, 2, 0, 0]} name="Active" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {showConditionBreakdown && analytics.conditions.length > 1 && (
                  <ConditionBreakdown conditions={analytics.conditions} min={analytics.min} max={analytics.max} />
                )}
              </div>

              <div>
                <h4 className="text-xs text-zinc-500 mb-2">Data Points</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-zinc-500">
                        <th className="text-left py-1 font-medium">Title</th>
                        <th className="text-right py-1 font-medium w-16">Price</th>
                        <th className="text-center py-1 font-medium w-14">Type</th>
                        <th className="text-left py-1 font-medium w-20">Cond.</th>
                        <th className="text-right py-1 font-medium w-20">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/50">
                      {prices!.map((bp) => (
                        <tr key={bp.id} className="hover:bg-raised transition-colors">
                          <td className="py-1.5 pr-2 text-zinc-300 truncate max-w-[200px]">
                            {bp.source_url ? (
                              <a href={bp.source_url} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{bp.title}</a>
                            ) : bp.title}
                          </td>
                          <td className="py-1.5 text-right font-mono text-zinc-200">{formatPrice(bp.total_landed_gbp ?? bp.price)}</td>
                          <td className="py-1.5 text-center">
                            <span className={cn('text-tiny px-1 py-0.5 rounded', bp.source_type === 'sold' ? 'bg-success/10 text-success' : 'bg-info/10 text-info')}>
                              {bp.source_type}
                            </span>
                          </td>
                          <td className="py-1.5 text-zinc-500">{bp.condition || '—'}</td>
                          <td className="py-1.5 text-right font-mono text-zinc-500">{bp.sold_date || formatRelativeTime(bp.observed_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
