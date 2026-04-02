import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatPrice, formatCount, formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import PageHeader from '@/components/layout/PageHeader';
import MetricCard from '@/components/shared/MetricCard';
import StatusBadge from '@/components/shared/StatusBadge';
import type {
  HuntPriceData,
  Hunt,
  HuntBaselineData,
  SegmentWithStats,
  BaselinePrice,
} from '@shared/types';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
  BarChart,
  Bar,
} from 'recharts';

type Period = '7d' | '14d' | '30d' | '90d' | 'all';

const periods: { value: Period; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '14d', label: '14d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
];

// Segment band colors (muted, for chart overlays)
const SEGMENT_COLORS = [
  '#22C55E', // green
  '#3B82F6', // blue
  '#EAB308', // yellow
  '#EC4899', // pink
  '#F97316', // orange
  '#06B6D4', // cyan
];

export default function HuntPrices() {
  const { id } = useParams();
  const huntId = parseInt(id!);
  const [period, setPeriod] = useState<Period>('30d');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [expandedSegment, setExpandedSegment] = useState<number | null>(null);

  const { data: hunt } = useQuery({
    queryKey: queryKeys.hunts.detail(huntId),
    queryFn: () => apiGet<Hunt>(`/hunts/${huntId}`),
  });

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.hunts.prices(huntId, period),
    queryFn: () =>
      apiGet<HuntPriceData>(`/hunts/${huntId}/prices?period=${period}`),
  });

  const { data: baseline } = useQuery({
    queryKey: queryKeys.hunts.baseline(huntId),
    queryFn: () => apiGet<HuntBaselineData>(`/hunts/${huntId}/baseline`),
  });

  const budget = (() => {
    try {
      const c = JSON.parse(hunt?.criteria || '{}');
      return c.budget || c.budget_target || c.max_price || null;
    } catch {
      return null;
    }
  })();

  // --- Baseline: tags and filtering ---
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

  // --- Price data transforms ---
  const dailyData = (() => {
    if (!data?.observations.length) return [];
    const byDay = new Map<string, { prices: number[]; min: number; max: number }>();
    for (const obs of data.observations) {
      const day = obs.observed_at.split('T')[0].split(' ')[0];
      const price = (obs.total_landed_gbp ?? obs.price) as number;
      if (!byDay.has(day)) byDay.set(day, { prices: [], min: Infinity, max: -Infinity });
      const d = byDay.get(day)!;
      d.prices.push(price);
      d.min = Math.min(d.min, price);
      d.max = Math.max(d.max, price);
    }
    return Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, d]) => {
        const sorted = [...d.prices].sort((a, b) => a - b);
        const median = sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];
        return {
          date: new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
          min: d.min, max: d.max, median,
        };
      });
  })();

  const histogramData = (() => {
    if (!data?.observations.length) return [];
    const prices = data.observations.map((o) => (o.total_landed_gbp ?? o.price) as number).filter((p) => p != null);
    if (prices.length === 0) return [];
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const bucketCount = Math.min(15, Math.max(5, Math.ceil(prices.length / 3)));
    const bucketSize = range / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
      label: formatPrice(min + i * bucketSize),
      count: 0,
    }));
    for (const p of prices) {
      const idx = Math.min(Math.floor((p - min) / bucketSize), bucketCount - 1);
      buckets[idx].count++;
    }
    return buckets;
  })();

  const conditionData = useMemo(() => {
    if (!data?.observations.length) return [];
    const groups = new Map<string, number[]>();
    for (const obs of data.observations) {
      const condition = obs.offer_condition || 'Unknown';
      const price = (obs.total_landed_gbp ?? obs.price) as number;
      if (!groups.has(condition)) groups.set(condition, []);
      groups.get(condition)!.push(price);
    }
    return Array.from(groups.entries())
      .map(([condition, prices]) => {
        const sorted = [...prices].sort((a, b) => a - b);
        const median = sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];
        return { condition, count: prices.length, min: sorted[0], max: sorted[sorted.length - 1], median };
      })
      .sort((a, b) => b.count - a.count);
  }, [data]);

  // Segments with price tiers for chart overlay
  const segmentBands = useMemo(() => {
    return filteredSegments
      .filter((s) => s.price_low != null && s.price_high != null)
      .map((s, i) => ({
        name: s.name,
        low: s.price_low!,
        high: s.price_high!,
        color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
      }));
  }, [filteredSegments]);

  const hasSegments = baseline && baseline.segments.length > 0;

  return (
    <div>
      <PageHeader
        title="Price Intelligence"
        breadcrumbs={[
          { label: 'Hunts', to: '/hunts' },
          { label: hunt?.name || `Hunt #${huntId}`, to: `/hunts/${huntId}` },
          { label: 'Prices' },
        ]}
      />

      {/* Controls row: period + tag filter */}
      <div className="flex flex-wrap items-start gap-4 mb-6">
        <div className="flex gap-1 bg-surface border border-zinc-800 rounded-lg p-1">
          {periods.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm transition-colors',
                period === p.value ? 'bg-accent text-white' : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
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
      </div>

      {isLoading && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 bg-surface border border-zinc-800 rounded-lg animate-pulse" />
            ))}
          </div>
          <div className="h-64 bg-surface border border-zinc-800 rounded-lg animate-pulse" />
        </div>
      )}

      <div className="space-y-6">
        {/* Market Segments (baseline) */}
        {hasSegments && (
          <div>
            <h2 className="text-heading text-zinc-300 mb-3">Market Segments</h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {filteredSegments.map((segment) => (
                <SegmentCard
                  key={segment.id}
                  segment={segment}
                  huntId={huntId}
                  expanded={expandedSegment === segment.id}
                  onToggle={() => setExpandedSegment(expandedSegment === segment.id ? null : segment.id)}
                />
              ))}
            </div>
          </div>
        )}

        {data && (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <MetricCard label="Median" value={formatPrice(data.aggregates.median_price)} />
              <MetricCard label="Min" value={formatPrice(data.aggregates.min_price)} />
              <MetricCard label="Max" value={formatPrice(data.aggregates.max_price)} />
              <MetricCard label="Observations" value={formatCount(data.aggregates.observation_count)} />
            </div>

            {/* Trend chart with segment bands */}
            {dailyData.length > 0 && (
              <div className="bg-surface border border-zinc-800 rounded-lg p-4">
                <h3 className="text-heading text-zinc-300 mb-3">Price Trend</h3>
                {segmentBands.length > 0 && (
                  <div className="flex flex-wrap gap-3 mb-2 text-xs text-zinc-500">
                    {segmentBands.map((sb) => (
                      <span key={sb.name} className="flex items-center gap-1">
                        <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: sb.color, opacity: 0.3 }} />
                        {sb.name}
                      </span>
                    ))}
                  </div>
                )}
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={dailyData}>
                    <defs>
                      <linearGradient id="envelopeGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.08} />
                        <stop offset="100%" stopColor="#8B5CF6" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid horizontal vertical={false} stroke="#27272A" strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#71717A' }} axisLine={false} tickLine={false} />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#71717A', fontFamily: 'JetBrains Mono' }}
                      axisLine={false} tickLine={false} tickFormatter={(v) => `£${v}`} width={65}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#3F3F46', border: '1px solid #52525B', borderRadius: '6px', fontSize: '12px' }}
                      formatter={(value: number, name: string) => [formatPrice(value), name === 'median' ? 'Median' : name]}
                      labelStyle={{ color: '#A1A1AA' }}
                    />
                    {/* Segment baseline bands */}
                    {segmentBands.map((sb) => (
                      <ReferenceArea
                        key={sb.name}
                        y1={sb.low}
                        y2={sb.high}
                        fill={sb.color}
                        fillOpacity={0.06}
                        stroke={sb.color}
                        strokeOpacity={0.15}
                        strokeDasharray="4 4"
                      />
                    ))}
                    {/* Min-max envelope */}
                    <Area dataKey="max" stroke="none" fill="url(#envelopeGradient)" type="monotone" />
                    <Area dataKey="min" stroke="none" fill="#09090B" type="monotone" />
                    {/* Median line */}
                    <Line dataKey="median" stroke="#8B5CF6" strokeWidth={2} dot={false} type="monotone" />
                    {/* Budget line */}
                    {budget && (
                      <ReferenceLine
                        y={budget} stroke="#EF4444" strokeDasharray="8 4"
                        label={{ value: `Budget ${formatPrice(budget)}`, position: 'right', fill: '#EF4444', fontSize: 11 }}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Distribution */}
            {histogramData.length > 0 && (
              <div className="bg-surface border border-zinc-800 rounded-lg p-4">
                <h3 className="text-heading text-zinc-300 mb-3">Price Distribution</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={histogramData}>
                    <CartesianGrid horizontal vertical={false} stroke="#27272A" strokeDasharray="3 3" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#71717A' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11, fill: '#71717A' }} axisLine={false} tickLine={false} width={30} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#3F3F46', border: '1px solid #52525B', borderRadius: '6px', fontSize: '12px' }}
                      formatter={(value: number) => [value, 'Observations']}
                      labelStyle={{ color: '#A1A1AA' }}
                    />
                    <Bar dataKey="count" fill="#8B5CF6" opacity={0.6} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Condition breakdown */}
            {conditionData.length > 1 && (
              <div className="bg-surface border border-zinc-800 rounded-lg p-4">
                <h3 className="text-heading text-zinc-300 mb-3">By Condition</h3>
                <div className="space-y-3">
                  {conditionData.map((cd) => {
                    const range = data.aggregates.max_price - data.aggregates.min_price || 1;
                    const minPct = ((cd.min - data.aggregates.min_price) / range) * 100;
                    const widthPct = ((cd.max - cd.min) / range) * 100 || 2;
                    const medianPct = ((cd.median - data.aggregates.min_price) / range) * 100;
                    return (
                      <div key={cd.condition}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm text-zinc-400">
                            {cd.condition} <span className="text-zinc-600 text-xs">({cd.count})</span>
                          </span>
                          <span className="font-mono text-xs text-zinc-300">
                            {formatPrice(cd.min)} – {formatPrice(cd.max)}
                            <span className="text-zinc-500 ml-2">median {formatPrice(cd.median)}</span>
                          </span>
                        </div>
                        <div className="relative h-2 bg-zinc-800 rounded-full">
                          <div className="absolute h-2 bg-accent/40 rounded-full" style={{ left: `${minPct}%`, width: `${Math.max(widthPct, 2)}%` }} />
                          <div className="absolute w-1.5 h-3 bg-accent rounded-full -top-0.5" style={{ left: `${medianPct}%` }} title={`Median: ${formatPrice(cd.median)}`} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {data.observations.length === 0 && !hasSegments && (
              <div className="text-center py-12 text-zinc-500 text-sm">
                No price data in this period
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- Segment Card sub-component ---

function SegmentCard({
  segment,
  huntId,
  expanded,
  onToggle,
}: {
  segment: SegmentWithStats;
  huntId: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tags: string[] = (() => {
    try { return JSON.parse(segment.tags); } catch { return []; }
  })();

  const isStale = segment.latest_data &&
    Date.now() - new Date(segment.latest_data + 'Z').getTime() > 14 * 24 * 60 * 60 * 1000;

  const confidenceVariant = segment.confidence === 'HIGH' ? 'active'
    : segment.confidence === 'MEDIUM' ? 'medium' : 'low';

  const { data: prices } = useQuery({
    queryKey: queryKeys.hunts.segmentPrices(huntId, segment.id),
    queryFn: () => apiGet<BaselinePrice[]>(`/hunts/${huntId}/segments/${segment.id}/prices`),
    enabled: expanded,
  });

  return (
    <div className="bg-surface border border-zinc-800 rounded-lg p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="text-heading text-zinc-200">{segment.name}</h3>
          {segment.description && <p className="text-xs text-zinc-500 mt-0.5">{segment.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge variant={confidenceVariant}>{segment.confidence}</StatusBadge>
          <span className="text-xs font-mono text-zinc-500">n={segment.sample_size}</span>
        </div>
      </div>

      {segment.price_low != null && segment.price_high != null && (
        <div className="mb-3">
          <div className="flex justify-between text-xs font-mono text-zinc-500 mb-1">
            <span>{formatPrice(segment.price_low)}</span>
            {segment.price_mid != null && <span className="text-zinc-300">{formatPrice(segment.price_mid)}</span>}
            <span>{formatPrice(segment.price_high)}</span>
          </div>
          <div className="relative h-2.5 rounded-full overflow-hidden flex">
            <div className="bg-success/40 h-full" style={{
              width: segment.price_mid
                ? `${((segment.price_mid - segment.price_low) / (segment.price_high - segment.price_low)) * 100}%`
                : '50%',
            }} />
            <div className="bg-warning/40 h-full flex-1" />
          </div>
          <div className="flex justify-between text-tiny text-zinc-600 mt-0.5">
            <span>Good deal</span>
            <span>Overpriced</span>
          </div>
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
        {expanded ? 'Hide' : 'Show'} data points ({segment.data_point_count})
      </button>

      {expanded && prices && prices.length > 0 && (
        <div className="mt-3 border-t border-zinc-800 pt-3">
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
              {prices.map((bp) => (
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
      )}
    </div>
  );
}
