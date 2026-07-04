/**
 * Cars per-segment analytics panel: price-vs-mileage scatter with the segment
 * band, budget line, and the depreciation trend fitted from the segment's
 * live offers. Residual against that trend is the primary cars deal signal;
 * band assessment stays as secondary context.
 *
 * Rendered inside an expanded SegmentCard via the vertical UI registry
 * (SegmentAnalyticsPanel slot). The baseline comps histogram stays alongside.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  Line,
  Scatter,
} from 'recharts';
import type {
  SegmentAnalyticsPanelProps,
  ParsedBaselineOffer,
} from '@/lib/verticals/registry';
import { fitLinearTrend, residual, type LinearTrendFit } from '@/lib/regression';
import { getSourcePriceOpinion } from '@/lib/attributes';
import { assessPrice, assessmentLabel } from '@/lib/segment-matcher';
import { formatPrice } from '@/lib/format';
import MustHaveChips from './MustHaveChips';

const TREND_COLOR = '#8B5CF6';
const BAND_COLOR = '#3B82F6';
/** Year-bucket palette, cold (oldest) → warm (newest). */
const YEAR_PALETTE = ['#3B82F6', '#22C55E', '#EAB308', '#F97316', '#EC4899'];
const NO_YEAR_FILL = '#71717A';

interface ScatterPoint {
  x: number; // mileage
  y: number; // price
  fill: string;
  offer: ParsedBaselineOffer;
}

function formatMiles(v: number): string {
  return v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`;
}

function formatShortPrice(v: number): string {
  return v >= 1000 ? `£${Math.round(v / 1000)}k` : `£${Math.round(v)}`;
}

function formatGbp(v: number): string {
  return `£${Math.round(Math.abs(v)).toLocaleString('en-GB')}`;
}

interface YearBuckets {
  bucketFor(year: number | undefined): number | null;
  /** Legend chips: fill + label per bucket (only buckets with offers). */
  chips: Array<{ fill: string; label: string }>;
  fillFor(year: number | undefined): string;
}

function buildYearBuckets(years: number[]): YearBuckets {
  if (years.length === 0) {
    return { bucketFor: () => null, chips: [], fillFor: () => NO_YEAR_FILL };
  }
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const span = maxYear - minYear + 1; // distinct-year span
  const bucketCount = Math.min(5, span);

  const bucketFor = (year: number | undefined): number | null => {
    if (year == null) return null;
    const idx = Math.floor(((year - minYear) / span) * bucketCount);
    return Math.max(0, Math.min(bucketCount - 1, idx));
  };

  // Label each bucket by the actual years that fall into it.
  const byBucket = new Map<number, number[]>();
  for (const y of years) {
    const b = bucketFor(y)!;
    const list = byBucket.get(b) ?? [];
    list.push(y);
    byBucket.set(b, list);
  }
  const chips = Array.from(byBucket.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, ys]) => {
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      return {
        fill: YEAR_PALETTE[bucket],
        label: lo === hi ? `${lo}` : `${lo}–${hi}`,
      };
    });

  const fillFor = (year: number | undefined): string => {
    const b = bucketFor(year);
    return b == null ? NO_YEAR_FILL : YEAR_PALETTE[b];
  };

  return { bucketFor, chips, fillFor };
}

// --- Custom dot shapes (trade = circle, private = diamond) ---

interface ShapeProps {
  cx?: number;
  cy?: number;
  payload?: ScatterPoint;
}

function makeShapeRenderer(
  kind: 'circle' | 'diamond',
  onDotClick: (offerId: number) => void,
) {
  return function renderShape(props: unknown) {
    const { cx, cy, payload } = props as ShapeProps;
    if (typeof cx !== 'number' || typeof cy !== 'number' || !payload) {
      return <g />;
    }
    const common = {
      fill: payload.fill,
      stroke: '#18181B',
      strokeWidth: 1,
      className: 'cursor-pointer',
      onClick: () => onDotClick(payload.offer.offer_id),
    };
    if (kind === 'circle') {
      return <circle cx={cx} cy={cy} r={5} {...common} />;
    }
    const r = 6;
    const points = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
    return <polygon points={points} {...common} />;
  };
}

export default function PriceMileageScatter({
  segment,
  offers,
  budget,
  mustHaves,
}: SegmentAnalyticsPanelProps) {
  const navigate = useNavigate();

  const {
    tradePoints,
    privatePoints,
    fit,
    trendData,
    xDomain,
    yDomain,
    yearChips,
    withoutMileageCount,
    hasPoints,
  } = useMemo(() => {
    const priced = offers.filter((o) => o.current_price != null);
    const withMileage = priced.filter((o) => o.carAttrs?.mileage_num != null);
    const withoutMileage = priced.length - withMileage.length;

    const buckets = buildYearBuckets(
      withMileage
        .map((o) => o.carAttrs?.year)
        .filter((y): y is number => y != null),
    );

    const points: ScatterPoint[] = withMileage.map((o) => ({
      x: o.carAttrs!.mileage_num!,
      y: o.current_price!,
      fill: buckets.fillFor(o.carAttrs?.year),
      offer: o,
    }));

    const trendFit: LinearTrendFit | null = fitLinearTrend(
      points.map((p) => ({ x: p.x, y: p.y })),
    );

    // X domain: data range padded 5% each side (single point → fixed pad).
    const xs = points.map((p) => p.x);
    const xMin = xs.length ? Math.min(...xs) : 0;
    const xMax = xs.length ? Math.max(...xs) : 1;
    const xSpan = xMax - xMin;
    const xPad = xSpan > 0 ? xSpan * 0.05 : Math.max(xMax * 0.05, 500);
    const xLo = xMin - xPad;
    const xHi = xMax + xPad;

    const trend =
      trendFit != null
        ? [
            { x: xLo, y: trendFit.predict(xLo) },
            { x: xHi, y: trendFit.predict(xHi) },
          ]
        : null;

    // Y domain: cover band, offers, budget, and trend endpoints; 5% padding.
    const ys = points.map((p) => p.y);
    if (segment.price_low != null) ys.push(segment.price_low);
    if (segment.price_high != null) ys.push(segment.price_high);
    if (budget != null) ys.push(budget);
    if (trend) ys.push(trend[0].y, trend[1].y);
    const yMin = ys.length ? Math.min(...ys) : 0;
    const yMax = ys.length ? Math.max(...ys) : 1;
    const ySpan = yMax - yMin || Math.max(yMax * 0.1, 1);
    const yLo = Math.max(0, yMin - ySpan * 0.05);
    const yHi = yMax + ySpan * 0.05;

    const isPrivate = (o: ParsedBaselineOffer) =>
      o.carAttrs?.seller_type?.toLowerCase() === 'private';

    return {
      tradePoints: points.filter((p) => !isPrivate(p.offer)),
      privatePoints: points.filter((p) => isPrivate(p.offer)),
      fit: trendFit,
      trendData: trend,
      xDomain: [xLo, xHi] as [number, number],
      yDomain: [yLo, yHi] as [number, number],
      yearChips: buckets.chips,
      withoutMileageCount: withoutMileage,
      hasPoints: points.length > 0,
    };
  }, [offers, segment, budget]);

  const onDotClick = (offerId: number) => navigate(`/offers/${offerId}`);

  const renderTooltip = (props: {
    active?: boolean;
    payload?: Array<{ payload?: ScatterPoint }>;
  }) => {
    const point = props.payload?.[0]?.payload;
    if (!props.active || !point?.offer) return null;
    const { offer } = point;
    const attrs = offer.carAttrs ?? {};
    const opinion = getSourcePriceOpinion(offer.source, offer.attributes);
    const band = assessPrice(point.y, segment);
    const res = fit ? residual(point.y, point.x, fit) : null;

    return (
      <div className="bg-overlay border border-zinc-600 rounded-md px-3 py-2 space-y-1 max-w-[280px] text-xs shadow-lg">
        <div className="text-zinc-200 font-medium leading-snug">{offer.title}</div>
        <div className="font-mono text-zinc-300">
          {formatPrice(point.y)}
          <span className="font-sans text-zinc-500"> · </span>
          {formatMiles(point.x)} miles
          {attrs.year != null && (
            <>
              <span className="font-sans text-zinc-500"> · </span>
              {attrs.year}
            </>
          )}
        </div>
        {res != null && (
          <div className={res <= 0 ? 'text-success' : 'text-danger'}>
            {res <= 0
              ? `${formatGbp(res)} under trend for its mileage`
              : `${formatGbp(res)} over trend`}
          </div>
        )}
        {band != null && (
          <div className="text-tiny text-zinc-500">Band: {assessmentLabel(band)}</div>
        )}
        {opinion != null && (
          <div className="text-tiny text-zinc-400">
            {opinion.source}: {opinion.label ?? opinion.tier}
            {opinion.deviation_gbp != null &&
              ` (${formatGbp(opinion.deviation_gbp)} ${opinion.deviation_gbp <= 0 ? 'below' : 'above'} market)`}
          </div>
        )}
        {mustHaves.length > 0 && (
          <MustHaveChips mustHaves={mustHaves} features={offer.features ?? []} mode="compact" />
        )}
      </div>
    );
  };

  return (
    <div>
      <h4 className="text-xs text-zinc-500 mb-2">Price vs Mileage</h4>

      {hasPoints && (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="#27272A" strokeDasharray="3 3" />
            <XAxis
              dataKey="x"
              type="number"
              domain={xDomain}
              tickFormatter={formatMiles}
              tick={{ fontSize: 9, fill: '#71717A', fontFamily: 'JetBrains Mono, monospace' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              dataKey="y"
              type="number"
              domain={yDomain}
              tickFormatter={formatShortPrice}
              tick={{ fontSize: 9, fill: '#71717A', fontFamily: 'JetBrains Mono, monospace' }}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            {segment.price_low != null && segment.price_high != null && (
              <ReferenceArea
                y1={segment.price_low}
                y2={segment.price_high}
                fill={BAND_COLOR}
                fillOpacity={0.12}
                stroke="none"
                label={{
                  value: 'market band',
                  position: 'insideTopRight',
                  fontSize: 9,
                  fill: BAND_COLOR,
                }}
              />
            )}
            {budget != null && (
              <ReferenceLine
                y={budget}
                stroke="#EF4444"
                strokeDasharray="4 4"
                label={{
                  value: 'budget',
                  position: 'insideBottomLeft',
                  fontSize: 9,
                  fill: '#EF4444',
                }}
              />
            )}
            {trendData && (
              <Line
                data={trendData}
                dataKey="y"
                type="linear"
                stroke={TREND_COLOR}
                strokeDasharray="6 4"
                strokeWidth={1.5}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            )}
            <Scatter
              data={tradePoints}
              shape={makeShapeRenderer('circle', onDotClick)}
              isAnimationActive={false}
            />
            <Scatter
              data={privatePoints}
              shape={makeShapeRenderer('diamond', onDotClick)}
              isAnimationActive={false}
            />
            <Tooltip
              content={renderTooltip}
              cursor={{ strokeDasharray: '3 3', stroke: '#52525B' }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* Legend + footnotes (plain HTML — stable in tests, readable in UI) */}
      <div className="mt-1.5 space-y-1">
        {fit && (
          <div className="text-tiny text-zinc-500">
            <span className="inline-block w-4 border-t border-dashed align-middle mr-1.5" style={{ borderColor: TREND_COLOR }} />
            trend: {fit.slope <= 0 ? '−' : '+'}£{Math.abs(fit.slope).toFixed(2)}/mile · r²{' '}
            {fit.r2.toFixed(2)}
          </div>
        )}
        {hasPoints && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-tiny text-zinc-500">
            <span>● trade</span>
            <span>◆ private</span>
            {yearChips.map((chip) => (
              <span key={chip.label} className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: chip.fill }} />
                {chip.label}
              </span>
            ))}
          </div>
        )}
        {withoutMileageCount > 0 && (
          <div className="text-tiny text-zinc-500">
            {withoutMileageCount} offer{withoutMileageCount !== 1 ? 's' : ''} without mileage —
            band assessment only
          </div>
        )}
        {!fit && (
          <div className="text-tiny text-zinc-500">not enough data for a trend (n&lt;4)</div>
        )}
      </div>
    </div>
  );
}
