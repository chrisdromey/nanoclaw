/**
 * WP2: PriceMileageScatter — trend legend, no-trend fallback, no-mileage
 * footnote, and recharts edge cases (single offer, mileage=0).
 *
 * recharts renders SVG via ResponsiveContainer which reports zero size in
 * jsdom, so assertions target the HTML legend/footnote layer, not chart
 * internals or pixel positions.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

// jsdom has no ResizeObserver; recharts' ResponsiveContainer requires one.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import PriceMileageScatter from '../components/verticals/cars/PriceMileageScatter';
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
  price: number | null,
  attrs: Record<string, unknown>,
): ParsedBaselineOffer {
  return {
    offer_id: id,
    title: `Kia EV6 GT-Line #${id}`,
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

function renderPanel(offers: ParsedBaselineOffer[], budget: number | null = 30000) {
  return render(
    <MemoryRouter>
      <PriceMileageScatter
        segment={makeSegment()}
        offers={offers}
        budget={budget}
        mustHaves={['Heat pump']}
      />
    </MemoryRouter>,
  );
}

const fourWithMileage = [
  makeOffer(1, 29000, { mileage_num: 10000, year: 2023, seller_type: 'trade' }),
  makeOffer(2, 28000, { mileage_num: 20000, year: 2022, seller_type: 'trade' }),
  makeOffer(3, 27000, { mileage_num: 30000, year: 2022, seller_type: 'private' }),
  makeOffer(4, 26000, { mileage_num: 40000, year: 2021, seller_type: 'TRADE' }),
];

describe('PriceMileageScatter — trend legend', () => {
  it('renders the trend legend with slope and r² when >= 4 mileage points', () => {
    renderPanel(fourWithMileage);
    // Exact fit: slope -0.1 £/mile, r² = 1.00
    expect(screen.getByText(/trend: −£0\.10\/mile · r² 1\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/not enough data for a trend/)).not.toBeInTheDocument();
  });

  it('renders seller-type and year-bucket legend chips', () => {
    renderPanel(fourWithMileage);
    expect(screen.getByText(/● trade/)).toBeInTheDocument();
    expect(screen.getByText(/◆ private/)).toBeInTheDocument();
    // Years 2021–2023 → 3 buckets, one per distinct year
    expect(screen.getByText('2021')).toBeInTheDocument();
    expect(screen.getByText('2022')).toBeInTheDocument();
    expect(screen.getByText('2023')).toBeInTheDocument();
  });

  it('shows "not enough data" with only 3 mileage points', () => {
    renderPanel(fourWithMileage.slice(0, 3));
    expect(screen.getByText('not enough data for a trend (n<4)')).toBeInTheDocument();
    expect(screen.queryByText(/trend: /)).not.toBeInTheDocument();
  });
});

describe('PriceMileageScatter — no-mileage footnote', () => {
  it('counts priced offers without mileage', () => {
    const offers = [
      ...fourWithMileage,
      makeOffer(5, 25000, { year: 2022 }), // no mileage
      makeOffer(6, 24000, {}), // no mileage
    ];
    renderPanel(offers);
    expect(
      screen.getByText('2 offers without mileage — band assessment only'),
    ).toBeInTheDocument();
    // Trend still fits from the 4 mileage-carrying offers
    expect(screen.getByText(/trend: /)).toBeInTheDocument();
  });

  it('uses singular wording for one offer', () => {
    renderPanel([...fourWithMileage, makeOffer(5, 25000, {})]);
    expect(
      screen.getByText('1 offer without mileage — band assessment only'),
    ).toBeInTheDocument();
  });

  it('ignores unpriced offers entirely', () => {
    renderPanel([...fourWithMileage, makeOffer(9, null, {})]);
    expect(screen.queryByText(/without mileage/)).not.toBeInTheDocument();
  });
});

describe('PriceMileageScatter — recharts edge cases', () => {
  it('does not crash with a single-offer segment', () => {
    renderPanel([makeOffer(1, 24000, { mileage_num: 35000, year: 2022 })]);
    expect(screen.getByText('Price vs Mileage')).toBeInTheDocument();
    expect(screen.getByText('not enough data for a trend (n<4)')).toBeInTheDocument();
  });

  it('does not crash with a mileage=0 offer', () => {
    const offers = [
      makeOffer(1, 30000, { mileage_num: 0, year: 2024 }),
      ...fourWithMileage.map((o, i) => ({ ...o, offer_id: 10 + i })),
    ];
    renderPanel(offers);
    expect(screen.getByText('Price vs Mileage')).toBeInTheDocument();
    // 5 points → trend renders
    expect(screen.getByText(/trend: /)).toBeInTheDocument();
  });

  it('does not crash with zero offers', () => {
    renderPanel([]);
    expect(screen.getByText('Price vs Mileage')).toBeInTheDocument();
    expect(screen.getByText('not enough data for a trend (n<4)')).toBeInTheDocument();
  });

  it('does not crash without a budget', () => {
    renderPanel(fourWithMileage, null);
    expect(screen.getByText(/trend: /)).toBeInTheDocument();
  });
});
