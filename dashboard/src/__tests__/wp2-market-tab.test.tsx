/**
 * WP2: MarketTab vertical behaviour via the UI registry.
 *
 * computers → band-based summary ("good deals"), auction urgency (the fixed
 * latent bug: auction_end_time now flows from the baseline endpoint), NO cars
 * panels, targets endpoint not fetched.
 *
 * cars → "N under trend" primary + "M below band" secondary, targets strip,
 * spec-sheet links, source-opinion cross-check, price/mileage scatter inside
 * an expanded segment, no auction legend.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom';

// jsdom has no ResizeObserver; recharts' ResponsiveContainer requires one.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import MarketTab from '../components/hunts/MarketTab';
import type { HuntBaselineData, HuntTargetsData, SegmentWithStats } from '@shared/types';

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
}));
import { apiGet } from '@/lib/api';
const apiGetMock = apiGet as Mock;

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
    latest_data: new Date().toISOString().replace('Z', ''),
    ...overrides,
  };
}

type ActiveOffer = HuntBaselineData['active_offer_prices'][number];

function carsOffer(
  id: number,
  price: number,
  attrs: Record<string, unknown>,
): ActiveOffer {
  return {
    offer_id: id,
    title: `Kia EV6 GT-Line #${id}`,
    current_price: price,
    condition: null,
    buying_format: null,
    source: 'autotrader',
    auction_end_time: null,
    attributes: attrs,
  };
}

// Hunt-11-like cars fixture. Trend across the 5 offers: slope -0.1,
// intercept 29100 → offer 5 (25k miles @ £23,000) is £3,600 under trend
// (threshold £1,064) — exactly 1 "under trend". No offer is at/below the
// £20,000 band low → 0 "below band".
const carsBaseline: HuntBaselineData = {
  segments: [makeSegment()],
  unclassified_count: 0,
  active_offer_prices: [
    carsOffer(1, 29000, { mileage_num: 10000, year: 2023, seller_type: 'trade' }),
    carsOffer(2, 28000, { mileage_num: 20000, year: 2022, seller_type: 'trade' }),
    carsOffer(3, 27000, { mileage_num: 30000, year: 2022, seller_type: 'private' }),
    carsOffer(4, 26000, { mileage_num: 40000, year: 2021, seller_type: 'TRADE' }),
    carsOffer(5, 23000, {
      mileage_num: 25000,
      year: 2022,
      seller_type: 'private',
      price_tier: 'GOOD',
      price_tier_label: 'Good price',
      price_deviation_gbp: -3000,
      features: [
        {
          category: 'Driver Convenience',
          items: [{ name: 'Heat Pump', type: 'Standard' }],
        },
      ],
    }),
  ],
};

const carsTargets: HuntTargetsData = {
  hunt_id: 11,
  vertical: 'cars',
  must_have: ['Adaptive cruise control (ACC)', 'Heat pump'],
  targets: [
    {
      target_key: 'Kia EV6',
      criteria: {},
      kb: {
        kb_path: 'references/hunts/kb/kia-ev6.md',
        citation_count: 6,
        must_have_citations: {},
        built_at: '2026-06-30T00:00:00',
      },
      verifications: [
        {
          feature: 'Adaptive cruise control',
          verdict: 'verified',
          evidence_url: null,
          notes: null,
          checked_at: '2026-07-01T00:00:00',
        },
      ],
    },
  ],
};

const computersBaseline: HuntBaselineData = {
  segments: [
    makeSegment({
      id: 7,
      hunt_id: 1,
      name: 'Ryzen 5 Pro 5650G',
      tags: '["5650G"]',
      price_low: 200,
      price_mid: 250,
      price_high: 300,
    }),
  ],
  unclassified_count: 0,
  active_offer_prices: [
    {
      offer_id: 21,
      title: 'Lenovo M75q Gen 2 5650G 16GB',
      current_price: 180,
      condition: 'Used',
      buying_format: 'AUCTION',
      source: 'ebay',
      auction_end_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      attributes: {},
    },
    {
      offer_id: 22,
      title: 'HP EliteDesk 805 5650G',
      current_price: 250,
      condition: 'Used',
      buying_format: 'FIXED_PRICE',
      source: 'ebay',
      auction_end_time: null,
      attributes: {},
    },
  ],
};

function mockApi(baseline: HuntBaselineData, targets?: HuntTargetsData) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.endsWith('/baseline')) return Promise.resolve(baseline);
    if (path.endsWith('/targets')) {
      return targets ? Promise.resolve(targets) : Promise.reject(new Error('404'));
    }
    if (path.includes('/prices')) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

function renderTab(props: { huntId: number; budget: number | null; vertical?: string }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MarketTab {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
});

describe('MarketTab — computers vertical', () => {
  it('shows the band-based good-deal summary, not the trend summary', async () => {
    mockApi(computersBaseline);
    renderTab({ huntId: 1, budget: 400, vertical: 'computers' });

    expect(await screen.findByText(/good deal/)).toBeInTheDocument();
    expect(screen.getByText(/good deal/).parentElement).toHaveTextContent('1 good deal');
    expect(screen.queryByText(/under trend/)).not.toBeInTheDocument();
    expect(screen.queryByText(/below band/)).not.toBeInTheDocument();
  });

  it('surfaces auction urgency now that auction_end_time flows (bug fix)', async () => {
    mockApi(computersBaseline);
    renderTab({ huntId: 1, budget: 400, vertical: 'computers' });

    expect(await screen.findByText(/auction ending soon/)).toBeInTheDocument();
    // Attention row links to the urgent auction offer (the overview dot for
    // the same offer also carries its title, so disambiguate by text content)
    const lenovoLinks = screen.getAllByRole('link', { name: /Lenovo M75q Gen 2 5650G 16GB/ });
    expect(
      lenovoLinks.some((l) => l.textContent?.includes('£180.00')),
    ).toBe(true);
    // Auction legend visible for computers
    expect(screen.getByText('Auction')).toBeInTheDocument();
  });

  it('renders no cars panels and never fetches targets', async () => {
    mockApi(computersBaseline);
    renderTab({ huntId: 1, budget: 400, vertical: 'computers' });
    await screen.findByText(/good deal/);

    expect(screen.queryByText('Models:')).not.toBeInTheDocument();
    expect(screen.queryByText('Price opinion cross-check')).not.toBeInTheDocument();
    expect(screen.queryByText('Price vs Mileage')).not.toBeInTheDocument();
    expect(screen.queryByText('Spec sheet →')).not.toBeInTheDocument();
    const paths = apiGetMock.mock.calls.map((c) => c[0]);
    expect(paths).toContain('/hunts/1/baseline');
    expect(paths).not.toContain('/hunts/1/targets');
  });

  it('still renders the condition breakdown when computers analytics are expanded', async () => {
    // Guard for the registry rewrite: the computers expanded-analytics path
    // (condition breakdown + histogram) must survive vertical-agnostic MarketTab.
    apiGetMock.mockImplementation((path: string) => {
      if (path.endsWith('/baseline')) return Promise.resolve(computersBaseline);
      if (path.includes('/prices')) {
        return Promise.resolve([
          { id: 1, price: 210, condition: 'Used', source_type: 'sold', observed_at: '2026-07-01', title: 'a' },
          { id: 2, price: 240, condition: 'Used', source_type: 'active', observed_at: '2026-07-01', title: 'b' },
          { id: 3, price: 290, condition: 'New', source_type: 'sold', observed_at: '2026-07-01', title: 'c' },
        ]);
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    renderTab({ huntId: 1, budget: 400, vertical: 'computers' });

    fireEvent.click(await screen.findByText(/Show analytics/));
    expect(await screen.findByText('By Condition')).toBeInTheDocument();
    expect(screen.getByText('Price Distribution')).toBeInTheDocument();
    expect(screen.queryByText('Price vs Mileage')).not.toBeInTheDocument();
  });

  it('defaults to computers behaviour when vertical is undefined', async () => {
    mockApi(computersBaseline);
    renderTab({ huntId: 1, budget: 400 });
    expect(await screen.findByText(/good deal/)).toBeInTheDocument();
    expect(apiGetMock.mock.calls.map((c) => c[0])).not.toContain('/hunts/1/targets');
  });
});

describe('MarketTab — cars vertical', () => {
  it('shows "N under trend" primary and "M below band" secondary', async () => {
    mockApi(carsBaseline, carsTargets);
    renderTab({ huntId: 11, budget: 30000, vertical: 'cars' });

    const underTrend = await screen.findByText('under trend');
    expect(underTrend.closest('span')?.parentElement).toHaveTextContent('1 under trend');
    expect(underTrend.closest('span')?.parentElement?.className).toContain('text-success');
    expect(screen.getByText('below band').closest('span')?.parentElement).toHaveTextContent(
      '0 below band',
    );
    expect(screen.queryByText(/good deal/)).not.toBeInTheDocument();
  });

  it('renders the targets strip with encoded spec-explorer links', async () => {
    mockApi(carsBaseline, carsTargets);
    renderTab({ huntId: 11, budget: 30000, vertical: 'cars' });

    expect(await screen.findByText('Models:')).toBeInTheDocument();
    const hrefs = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('/hunts/11/models/Kia%20EV6');
    expect(screen.getByText('· 6 cites')).toBeInTheDocument();
  });

  it('adds a Spec sheet link to segment cards whose tags contain a target_key', async () => {
    mockApi(carsBaseline, carsTargets);
    renderTab({ huntId: 11, budget: 30000, vertical: 'cars' });

    const specLink = await screen.findByRole('link', { name: 'Spec sheet →' });
    expect(specLink).toHaveAttribute('href', '/hunts/11/models/Kia%20EV6');
  });

  it('renders the source-opinion cross-check panel', async () => {
    mockApi(carsBaseline, carsTargets);
    renderTab({ huntId: 11, budget: 30000, vertical: 'cars' });

    expect(await screen.findByText('Price opinion cross-check')).toBeInTheDocument();
    // Deal offer: £3,600 under trend (below) while AT says GOOD (below) → agreement
    expect(screen.getByText('0 disagreements of 1 opinion')).toBeInTheDocument();
  });

  it('renders the price/mileage scatter when a segment is expanded', async () => {
    mockApi(carsBaseline, carsTargets);
    renderTab({ huntId: 11, budget: 30000, vertical: 'cars' });

    const toggle = await screen.findByText(/Show analytics/);
    expect(screen.queryByText('Price vs Mileage')).not.toBeInTheDocument();
    fireEvent.click(toggle);

    expect(await screen.findByText('Price vs Mileage')).toBeInTheDocument();
    // Trend legend from the 5 mileage-carrying offers
    expect(screen.getByText(/trend: −£/)).toBeInTheDocument();
  });

  it('hides auction UI and appends trend residuals to offer dot tooltips', async () => {
    mockApi(carsBaseline, carsTargets);
    const { container } = renderTab({ huntId: 11, budget: 30000, vertical: 'cars' });
    await screen.findByText('under trend');

    expect(screen.queryByText('Auction')).not.toBeInTheDocument();
    expect(screen.queryByText(/auction ending soon/)).not.toBeInTheDocument();

    const dotsWithResidual = container.querySelectorAll(
      'a[title*="trend for its mileage"]',
    );
    // 5 offers × 2 rows of dots (market overview + segment card tier bar)
    expect(dotsWithResidual.length).toBe(10);
    const dealDot = Array.from(dotsWithResidual).find((d) =>
      d.getAttribute('title')?.includes('#5'),
    );
    expect(dealDot?.getAttribute('title')).toContain('£3,600 under trend for its mileage');
  });
});
