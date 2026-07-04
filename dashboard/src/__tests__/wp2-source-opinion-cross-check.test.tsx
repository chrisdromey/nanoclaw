/**
 * WP2: SourceOpinionCrossCheck — our verdict (trend residual, band fallback)
 * vs the source's own price opinion; disagreements highlighted and sorted
 * first; null render when no offer carries an opinion.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

import SourceOpinionCrossCheck from '../components/verticals/cars/SourceOpinionCrossCheck';
import { parseCarAttributes, parseFeatures } from '../lib/attributes';
import type { ParsedBaselineOffer } from '../lib/verticals/registry';
import type { SegmentWithStats } from '@shared/types';

function makeSegment(overrides: Partial<SegmentWithStats> = {}): SegmentWithStats {
  return {
    id: 1,
    hunt_id: 11,
    name: 'Kia EV6 RWD',
    description: null,
    tags: '["Kia EV6","EV6"]',
    filter_patterns: '[]',
    price_low: 20000,
    price_mid: 23000,
    price_high: 26000,
    sample_size: 24,
    confidence: 'HIGH',
    notes: null,
    created_at: '2026-06-01T00:00:00',
    updated_at: '2026-06-28T00:00:00',
    data_point_count: 24,
    sold_count: 10,
    active_count: 14,
    earliest_data: '2026-06-01T00:00:00',
    latest_data: '2026-06-28T00:00:00',
    ...overrides,
  };
}

function makeOffer(
  id: number,
  title: string,
  price: number | null,
  attrs: Record<string, unknown>,
): ParsedBaselineOffer {
  return {
    offer_id: id,
    title,
    current_price: price,
    condition: null,
    buying_format: null,
    source: 'autotrader',
    auction_end_time: null,
    attributes: attrs,
    carAttrs: parseCarAttributes(attrs),
    features: parseFeatures(attrs),
  };
}

function renderPanel(
  segments: SegmentWithStats[],
  offersBySegment: Map<number, ParsedBaselineOffer[]>,
) {
  return render(
    <MemoryRouter>
      <SourceOpinionCrossCheck
        huntId={11}
        segments={segments}
        offersBySegment={offersBySegment}
      />
    </MemoryRouter>,
  );
}

describe('SourceOpinionCrossCheck — band fallback (no trend fit)', () => {
  // Fewer than 4 mileage points in the segment → our verdict falls back to band.
  const agreeing = makeOffer(1, 'Kia EV6 agreeable', 19000, {
    price_tier: 'LOW',
    price_tier_label: 'Lower price',
    price_deviation_gbp: -2500,
  }); // band: good → below; source: LOW → below → agreement
  const disagreeing = makeOffer(2, 'Kia EV6 contentious', 27000, {
    price_tier: 'GOOD',
    price_tier_label: 'Good price',
    price_deviation_gbp: -1732,
  }); // band: high → above; source: GOOD → below → disagreement

  it('sorts the disagreement row first and highlights it', () => {
    const segment = makeSegment();
    // Agreeing offer listed FIRST — the disagreement must be re-sorted to the top.
    renderPanel([segment], new Map([[segment.id, [agreeing, disagreeing]]]));

    const rowTitles = screen
      .getAllByRole('link')
      .map((l) => l.textContent);
    expect(rowTitles[0]).toBe('Kia EV6 contentious');

    const disagreementRow = screen
      .getByText('Kia EV6 contentious')
      .closest('div');
    expect(disagreementRow?.className).toContain('border-warning');
    expect(disagreementRow?.className).toContain('bg-warning/5');

    const agreementRow = screen.getByText('Kia EV6 agreeable').closest('div');
    expect(agreementRow?.className).not.toContain('border-warning');
  });

  it('shows the summary count and the source-named column header', () => {
    const segment = makeSegment();
    renderPanel([segment], new Map([[segment.id, [agreeing, disagreeing]]]));
    expect(screen.getByText('1 disagreement of 2 opinions')).toBeInTheDocument();
    expect(screen.getByText('autotrader says')).toBeInTheDocument();
  });

  it('renders band-based verdicts with a "vs band" note and the source deviation', () => {
    const segment = makeSegment();
    renderPanel([segment], new Map([[segment.id, [agreeing, disagreeing]]]));
    expect(screen.getByText('above')).toBeInTheDocument();
    expect(screen.getAllByText('vs band')).toHaveLength(2);
    expect(screen.getByText(/£1,732 below market/)).toBeInTheDocument();
  });

  it('links each row to the offer page', () => {
    const segment = makeSegment();
    renderPanel([segment], new Map([[segment.id, [agreeing, disagreeing]]]));
    expect(screen.getByRole('link', { name: 'Kia EV6 contentious' })).toHaveAttribute(
      'href',
      '/offers/2',
    );
  });
});

describe('SourceOpinionCrossCheck — residual verdict (trend fit available)', () => {
  it('uses the segment trend residual when computable', () => {
    const segment = makeSegment();
    // Five mileage points: four on the line y = 30000 - 0.1x plus one deep deal.
    // Combined fit: slope -0.1, intercept 29100 → predict(25000) = 26600.
    const offers = [
      makeOffer(1, 'Kia EV6 a', 29000, { mileage_num: 10000 }),
      makeOffer(2, 'Kia EV6 b', 28000, { mileage_num: 20000 }),
      makeOffer(3, 'Kia EV6 c', 27000, { mileage_num: 30000 }),
      makeOffer(4, 'Kia EV6 d', 26000, { mileage_num: 40000 }),
      makeOffer(5, 'Kia EV6 deal', 23000, {
        mileage_num: 25000,
        price_tier: 'HIGH',
        price_tier_label: 'Higher price',
        price_deviation_gbp: 1200,
      }),
    ];
    renderPanel([segment], new Map([[segment.id, offers]]));

    // Residual: 23000 - 26600 = -£3,600 → below (threshold £1,064)
    expect(screen.getByText('below')).toBeInTheDocument();
    expect(screen.getByText('£3,600 under trend')).toBeInTheDocument();
    // Source said HIGH (above) → opposite directions → disagreement
    expect(screen.getByText('1 disagreement of 1 opinion')).toBeInTheDocument();
    expect(screen.getByLabelText('disagreement')).toBeInTheDocument();
  });
});

describe('SourceOpinionCrossCheck — empty states', () => {
  it('renders nothing when no offer carries a source opinion', () => {
    const segment = makeSegment();
    const offers = [
      makeOffer(1, 'Kia EV6 plain', 24000, {}),
      makeOffer(2, 'Kia EV6 noanalysis', 25000, { price_tier: 'NOANALYSIS' }),
    ];
    const { container } = renderPanel([segment], new Map([[segment.id, offers]]));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing with no offers at all', () => {
    const { container } = renderPanel([makeSegment()], new Map());
    expect(container.firstChild).toBeNull();
  });
});
