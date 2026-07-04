/**
 * Cars Market-tab extra panel: cross-checks OUR price verdict (trend residual
 * against the offer's segment when computable, band assessment otherwise)
 * against the SOURCE's own price opinion (e.g. AutoTrader's price tier).
 * Direct contradictions are highlighted and sorted first.
 *
 * Rendered once on the Market tab via the vertical UI registry
 * (MarketExtraPanel slot). Returns null when no offer carries an opinion.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Minus } from 'lucide-react';
import type { SegmentWithStats, SourcePriceOpinion } from '@shared/types';
import type {
  MarketExtraPanelProps,
  ParsedBaselineOffer,
} from '@/lib/verticals/registry';
import { fitLinearTrend, residualDealThreshold } from '@/lib/regression';
import {
  sourceVerdict,
  ourVerdictFromResidual,
  ourVerdictFromBand,
  isDisagreement,
  type PriceVerdict,
} from '@/lib/price-opinion';
import { getSourcePriceOpinion } from '@/lib/attributes';
import { assessPrice } from '@/lib/segment-matcher';
import { formatPrice } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Row {
  offer: ParsedBaselineOffer;
  opinion: SourcePriceOpinion;
  ours: PriceVerdict | null;
  /** Signed residual vs the segment trend, when computable. */
  residualGbp: number | null;
  source: PriceVerdict | null;
  disagreement: boolean;
}

const VERDICT_COLOR: Record<PriceVerdict, string> = {
  below: 'text-success',
  fair: 'text-zinc-400',
  above: 'text-danger',
};

function formatGbp(v: number): string {
  return `£${Math.round(Math.abs(v)).toLocaleString('en-GB')}`;
}

function buildRows(
  segments: SegmentWithStats[],
  offersBySegment: Map<number, ParsedBaselineOffer[]>,
): Row[] {
  const rows: Row[] = [];
  for (const segment of segments) {
    const offers = offersBySegment.get(segment.id) ?? [];
    const fit = fitLinearTrend(
      offers
        .filter((o) => o.current_price != null && o.carAttrs?.mileage_num != null)
        .map((o) => ({ x: o.carAttrs!.mileage_num!, y: o.current_price! })),
    );

    for (const offer of offers) {
      if (offer.current_price == null) continue;
      const opinion = getSourcePriceOpinion(offer.source, offer.attributes);
      if (!opinion) continue;

      let ours: PriceVerdict | null;
      let residualGbp: number | null = null;
      if (fit && offer.carAttrs?.mileage_num != null) {
        const predicted = fit.predict(offer.carAttrs.mileage_num);
        residualGbp = offer.current_price - predicted;
        ours = ourVerdictFromResidual(residualGbp, residualDealThreshold(predicted));
      } else {
        ours = ourVerdictFromBand(assessPrice(offer.current_price, segment));
      }

      const source = sourceVerdict(opinion);
      rows.push({
        offer,
        opinion,
        ours,
        residualGbp,
        source,
        disagreement: isDisagreement(ours, source),
      });
    }
  }
  // Disagreements first; stable otherwise (segment order, then offer order).
  return rows.sort((a, b) => Number(b.disagreement) - Number(a.disagreement));
}

export default function SourceOpinionCrossCheck({
  segments,
  offersBySegment,
}: MarketExtraPanelProps) {
  const rows = useMemo(
    () => buildRows(segments, offersBySegment),
    [segments, offersBySegment],
  );

  if (rows.length === 0) return null;

  const disagreements = rows.filter((r) => r.disagreement).length;
  const sources = Array.from(new Set(rows.map((r) => r.opinion.source)));
  const sourceHeader = sources.length === 1 ? `${sources[0]} says` : 'source says';

  return (
    <div className="bg-surface border border-zinc-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-heading text-zinc-300">Price opinion cross-check</h2>
        <span className="text-tiny text-zinc-500">
          {disagreements} disagreement{disagreements !== 1 ? 's' : ''} of {rows.length}{' '}
          opinion{rows.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="space-y-0.5">
        <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_10rem_minmax(0,12rem)_1.5rem] items-center gap-3 px-2 text-tiny text-zinc-500">
          <span>Listing</span>
          <span className="text-right">Price</span>
          <span>Our verdict</span>
          <span>{sourceHeader}</span>
          <span />
        </div>

        {rows.map((row) => {
          const { offer, opinion } = row;
          return (
            <div
              key={offer.offer_id}
              className={cn(
                'grid grid-cols-[minmax(0,1fr)_5.5rem_10rem_minmax(0,12rem)_1.5rem] items-center gap-3 px-2 py-1.5 rounded-r text-xs',
                row.disagreement && 'border-l-2 border-warning bg-warning/5',
              )}
            >
              <Link
                to={`/offers/${offer.offer_id}`}
                className="truncate text-zinc-300 hover:text-zinc-100 transition-colors"
                title={offer.title}
              >
                {offer.title}
              </Link>
              <span className="font-mono text-zinc-200 text-right">
                {formatPrice(offer.current_price)}
              </span>
              <span>
                {row.ours == null ? (
                  <span className="text-zinc-500">—</span>
                ) : (
                  <>
                    <span className={VERDICT_COLOR[row.ours]}>{row.ours}</span>{' '}
                    <span className="text-tiny text-zinc-500">
                      {row.residualGbp != null
                        ? `${formatGbp(row.residualGbp)} ${row.residualGbp <= 0 ? 'under' : 'over'} trend`
                        : 'vs band'}
                    </span>
                  </>
                )}
              </span>
              <span className="truncate text-zinc-400">
                {opinion.label ?? opinion.tier}
                {opinion.deviation_gbp != null && (
                  <span className="text-tiny text-zinc-500">
                    {' '}
                    ({formatGbp(opinion.deviation_gbp)}{' '}
                    {opinion.deviation_gbp <= 0 ? 'below' : 'above'} market)
                  </span>
                )}
              </span>
              <span className="flex justify-center">
                {row.disagreement ? (
                  <AlertTriangle size={12} className="text-warning" aria-label="disagreement" />
                ) : row.ours != null && row.source != null && row.ours === row.source ? (
                  <Check size={12} className="text-success" aria-label="agreement" />
                ) : (
                  <Minus size={12} className="text-zinc-600" aria-label="no strong signal" />
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
