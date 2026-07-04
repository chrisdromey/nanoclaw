/**
 * WP3 — SpecExplorer page tests. Mocks the API layer (targets, kb, baseline
 * queries) and the WP2 MustHaveChips component; exercises fuzzy verification
 * matching with real hunt-11-style strings, null evidence_url degradation,
 * option-pack warnings, inventory residual sorting, and not-found / no-KB
 * states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom';
import type { HuntTargetsData, HuntBaselineData, SegmentWithStats } from '@shared/types';

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
}));

vi.mock('@/components/verticals/cars/MustHaveChips', () => ({
  default: ({ mode }: { mode: string }) => (
    <span data-testid="must-have-chips">{mode}</span>
  ),
}));

import { apiGet } from '@/lib/api';
import SpecExplorer from '../pages/SpecExplorer';

const segment: SegmentWithStats = {
  id: 1,
  hunt_id: 11,
  name: 'Kia EV6',
  description: null,
  tags: '["Kia EV6"]',
  filter_patterns: '[]',
  price_low: 22000,
  price_mid: 26000,
  price_high: 31000,
  sample_size: 40,
  confidence: 'HIGH',
  notes: null,
  created_at: '2026-06-01T00:00:00',
  updated_at: '2026-07-01T00:00:00',
  data_point_count: 40,
  sold_count: 30,
  active_count: 10,
  earliest_data: '2026-06-01T00:00:00',
  latest_data: '2026-07-01T00:00:00',
};

const targetsFixture: HuntTargetsData = {
  hunt_id: 11,
  vertical: 'cars',
  must_have: [
    'Adaptive cruise control (ACC)',
    'Heat pump',
    'Lane keep assist',
    'Panoramic roof',
  ],
  targets: [
    {
      target_key: 'Kia EV6',
      criteria: { make: 'Kia', model: 'EV6', year_min: 2021 },
      kb: {
        kb_path: 'references/kb/kia-ev6.md',
        citation_count: 7,
        must_have_citations: { 'Adaptive cruise control (ACC)': 3 },
        built_at: '2026-07-01T10:00:00',
      },
      verifications: [
        {
          feature: 'Adaptive Cruise Control (ACC)',
          verdict: 'verified',
          evidence_url: null,
          notes: 'Standard on all UK trims',
          checked_at: '2026-07-01T10:00:00',
        },
        {
          feature: 'Heat pump fitted as standard',
          verdict: 'unverified',
          evidence_url: null,
          notes: 'Only standard on GT-Line S',
          checked_at: '2026-07-01T10:00:00',
        },
        {
          feature: 'Lane Keeping Assist',
          verdict: 'contradicted',
          evidence_url: null,
          notes: null,
          checked_at: '2026-07-01T10:00:00',
        },
        {
          feature: 'Vehicle-to-load (V2L)',
          verdict: 'verified',
          evidence_url: null,
          notes: null,
          checked_at: '2026-07-01T10:00:00',
        },
      ],
    },
    {
      // Overlapping model name with "Kia EV6" — pins the most-specific
      // assignment rule (a GT offer must never leak onto the plain EV6 page).
      target_key: 'Kia EV6 GT',
      criteria: { make: 'Kia', model: 'EV6 GT' },
      kb: null,
      verifications: [],
    },
    {
      target_key: 'Skoda Enyaq',
      criteria: { make: 'Skoda', model: 'Enyaq' },
      kb: null,
      verifications: [],
    },
  ],
};

// Trend fit over offers A–D (E has no mileage):
// points (10k,30000) (20k,28000) (30k,26000) (25k,20000)
// → slope −0.32, intercept 32800.
// Residuals: A +400, B +1600, C +2800, D −4800 → sort D, A, B, C, E(last).
const baselineFixture: HuntBaselineData = {
  segments: [segment],
  unclassified_count: 0,
  active_offer_prices: [
    {
      offer_id: 101,
      title: 'Kia EV6 GT-Line 2022 Offer A',
      current_price: 30000,
      condition: null,
      buying_format: null,
      source: 'autotrader',
      auction_end_time: null,
      attributes: {
        make: 'Kia',
        model: 'EV6',
        mileage_num: 10000,
        year: 2022,
        features: [
          {
            category: 'Safety',
            items: [{ name: 'Adaptive Cruise Control (ACC)', type: 'Standard' }],
          },
        ],
      },
    },
    {
      // No make/model attrs — must be picked up via the segment-tag match path.
      offer_id: 102,
      title: 'Kia EV6 Air 2021 Offer B',
      current_price: 28000,
      condition: null,
      buying_format: null,
      source: 'autotrader',
      auction_end_time: null,
      attributes: { mileage_num: 20000, year: 2021 },
    },
    {
      offer_id: 103,
      title: 'Kia EV6 Air 2021 Offer C',
      current_price: 26000,
      condition: null,
      buying_format: null,
      source: 'autotrader',
      auction_end_time: null,
      attributes: { make: 'Kia', model: 'EV6', mileage_num: 30000, year: 2021 },
    },
    {
      offer_id: 104,
      title: 'Kia EV6 GT-Line S 2022 Offer D',
      current_price: 20000,
      condition: null,
      buying_format: null,
      source: 'autotrader',
      auction_end_time: null,
      attributes: {
        make: 'Kia',
        model: 'EV6',
        mileage_num: 25000,
        year: 2022,
        features: [
          {
            category: 'Comfort',
            items: [{ name: 'Heat pump', type: 'Optional' }],
          },
        ],
      },
    },
    {
      offer_id: 105,
      title: 'Kia EV6 2022 no-mileage Offer E',
      current_price: 27000,
      condition: null,
      buying_format: null,
      source: 'autotrader',
      auction_end_time: null,
      attributes: { make: 'Kia', model: 'EV6', year: 2022 },
    },
    {
      offer_id: 106,
      title: 'Skoda Enyaq 80 SportLine',
      current_price: 25000,
      condition: null,
      buying_format: null,
      source: 'autotrader',
      auction_end_time: null,
      attributes: { make: 'Skoda', model: 'Enyaq', mileage_num: 15000 },
    },
    {
      // Exact model "EV6 GT" — belongs to the Kia EV6 GT target only. Its
      // Optional heat pump must NOT bump the plain-EV6 option-pack warning.
      offer_id: 107,
      title: 'Kia EV6 GT 2022 Offer G',
      current_price: 35000,
      condition: null,
      buying_format: null,
      source: 'autotrader',
      auction_end_time: null,
      attributes: {
        make: 'Kia',
        model: 'EV6 GT',
        mileage_num: 12000,
        year: 2022,
        features: [
          {
            category: 'Comfort',
            items: [{ name: 'Heat pump', type: 'Optional' }],
          },
        ],
      },
    },
  ],
};

const kbFixture = {
  target_key: 'Kia EV6',
  kb_path: 'references/kb/kia-ev6.md',
  built_at: '2026-07-01T10:00:00',
  markdown: '# Kia EV6 knowledge base\n\nHeat pump availability varies by trim.',
};

function mockApi() {
  vi.mocked(apiGet).mockImplementation((path: string) => {
    if (path === '/hunts/11/targets') return Promise.resolve(targetsFixture);
    if (path === '/hunts/11/baseline') return Promise.resolve(baselineFixture);
    if (path === '/hunts/11/targets/Kia%20EV6/kb') return Promise.resolve(kbFixture);
    return Promise.reject(new Error(`Unexpected apiGet: ${path}`));
  });
}

function renderAt(url: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/hunts/:id/models/:targetKey" element={<SpecExplorer />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  mockApi();
});

/** The verification row containing a given must-have string. */
function rowFor(mustHave: string): HTMLElement {
  const label = screen.getByText(mustHave);
  return label.closest('div')! as HTMLElement;
}

describe('SpecExplorer — header', () => {
  it('renders the target key as the page title with criteria + KB meta', async () => {
    renderAt('/hunts/11/models/Kia%20EV6');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Kia EV6' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/make: Kia/)).toBeInTheDocument();
    expect(screen.getByText(/year_min: 2021/)).toBeInTheDocument();
    expect(screen.getByText(/7 cited sources/)).toBeInTheDocument();
    expect(screen.getByText(/KB built/)).toBeInTheDocument();
  });
});

describe('SpecExplorer — must-have verification', () => {
  it('fuzzy-matches real must-have/verification string pairs to verdict badges', async () => {
    renderAt('/hunts/11/models/Kia%20EV6');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6' });

    // "Adaptive cruise control (ACC)" ↔ "Adaptive Cruise Control (ACC)"
    expect(within(rowFor('Adaptive cruise control (ACC)')).getByText('verified')).toBeInTheDocument();
    // "Heat pump" ↔ "Heat pump fitted as standard"
    expect(within(rowFor('Heat pump')).getByText('unverified')).toBeInTheDocument();
    // "Lane keep assist" ↔ "Lane Keeping Assist" (alias table)
    expect(within(rowFor('Lane keep assist')).getByText('contradicted')).toBeInTheDocument();
  });

  it('shows "no verification recorded" for an unmatched must-have', async () => {
    renderAt('/hunts/11/models/Kia%20EV6');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6' });
    expect(
      within(rowFor('Panoramic roof')).getByText('no verification recorded'),
    ).toBeInTheDocument();
  });

  it('renders no evidence anchor when evidence_url is null, but still shows notes', async () => {
    renderAt('/hunts/11/models/Kia%20EV6');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6' });
    expect(screen.queryByText('evidence')).not.toBeInTheDocument();
    expect(screen.getByText('Standard on all UK trims')).toBeInTheDocument();
  });

  it('renders an evidence link when evidence_url is present', async () => {
    const withUrl: HuntTargetsData = JSON.parse(JSON.stringify(targetsFixture));
    withUrl.targets[0].verifications[0].evidence_url = 'https://www.kia.com/uk/ev6/specs/';
    vi.mocked(apiGet).mockImplementation((path: string) => {
      if (path === '/hunts/11/targets') return Promise.resolve(withUrl);
      if (path === '/hunts/11/baseline') return Promise.resolve(baselineFixture);
      if (path === '/hunts/11/targets/Kia%20EV6/kb') return Promise.resolve(kbFixture);
      return Promise.reject(new Error(`Unexpected apiGet: ${path}`));
    });
    renderAt('/hunts/11/models/Kia%20EV6');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6' });
    const link = screen.getByRole('link', { name: /evidence/ });
    expect(link).toHaveAttribute('href', 'https://www.kia.com/uk/ev6/specs/');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows the KB citation count for an exact must-have key', async () => {
    renderAt('/hunts/11/models/Kia%20EV6');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6' });
    expect(
      within(rowFor('Adaptive cruise control (ACC)')).getByText('3 citations'),
    ).toBeInTheDocument();
  });

  it('lists verifications not matched to any must-have under "Other verifications"', async () => {
    renderAt('/hunts/11/models/Kia%20EV6');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6' });
    expect(screen.getByText('Other verifications')).toBeInTheDocument();
    expect(screen.getByText('Vehicle-to-load (V2L)')).toBeInTheDocument();
  });
});

describe('SpecExplorer — option-pack warnings', () => {
  it('warns when a must-have is only an optional pack on live listings', async () => {
    renderAt('/hunts/11/models/Kia%20EV6');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6' });
    expect(
      await screen.findByText(/Heat pump: optional pack on 1 of 5 current listings/),
    ).toBeInTheDocument();
    expect(screen.getByText(/verify per car/)).toBeInTheDocument();
  });
});

describe('SpecExplorer — live inventory', () => {
  it('shows residuals and sorts best deals first, no-mileage rows last', async () => {
    renderAt('/hunts/11/models/Kia%20EV6');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6' });
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1); // drop header
    expect(rows).toHaveLength(5); // Skoda offer excluded
    expect(within(rows[0]).getByText(/Offer D/)).toBeInTheDocument();
    expect(within(rows[0]).getByText('−£4,800')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Offer A/)).toBeInTheDocument();
    expect(within(rows[4]).getByText(/Offer E/)).toBeInTheDocument();
    // Offer B (segment-tag matched, no make/model attrs) is included
    expect(within(table).getByText(/Offer B/)).toBeInTheDocument();
    // Best-deal row gets a band assessment from its matched segment
    expect(within(rows[0]).getByText('Good deal')).toBeInTheDocument();
    // Compact must-have chips per row
    expect(within(table).getAllByTestId('must-have-chips').length).toBe(5);
  });

  it('links each inventory row to its offer page', async () => {
    renderAt('/hunts/11/models/Kia%20EV6');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6' });
    const table = await screen.findByRole('table');
    const link = within(table).getByRole('link', { name: /Offer D/ });
    expect(link).toHaveAttribute('href', '/offers/104');
  });
});

describe('SpecExplorer — overlapping targets (no cross-contamination)', () => {
  it('excludes the GT offer from the plain EV6 page inventory, trend, and warnings', async () => {
    renderAt('/hunts/11/models/Kia%20EV6');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6' });
    const table = await screen.findByRole('table');
    // Offer G (model "EV6 GT") must not appear on the plain-EV6 page
    expect(within(table).queryByText(/Offer G/)).not.toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(6); // header + 5
    // Trend fit unchanged by G's (12k, £35,000) point — D still −£4,800
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('−£4,800')).toBeInTheDocument();
    // G's Optional heat pump doesn't inflate the plain-EV6 warning count
    expect(
      screen.getByText(/Heat pump: optional pack on 1 of 5 current listings/),
    ).toBeInTheDocument();
  });

  it('shows the GT offer on the GT page (exact model match wins)', async () => {
    renderAt('/hunts/11/models/Kia%20EV6%20GT');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6 GT' });
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText(/Offer G/)).toBeInTheDocument();
    // Single offer — no trend fit, residual renders as "—"
    expect(within(rows[0]).queryByText(/−£|\+£/)).not.toBeInTheDocument();
    // GT page's own option-pack warning counts only its own inventory
    expect(
      screen.getByText(/Heat pump: optional pack on 1 of 1 current listings/),
    ).toBeInTheDocument();
  });

  it('does not fire the kb query for a target without a KB', async () => {
    renderAt('/hunts/11/models/Kia%20EV6%20GT');
    await screen.findByRole('heading', { level: 1, name: 'Kia EV6 GT' });
    expect(
      screen.getByText('No knowledge base built for this target yet.'),
    ).toBeInTheDocument();
    expect(vi.mocked(apiGet)).not.toHaveBeenCalledWith(
      '/hunts/11/targets/Kia%20EV6%20GT/kb',
    );
  });
});

describe('SpecExplorer — KB document', () => {
  it('renders the KB markdown', async () => {
    renderAt('/hunts/11/models/Kia%20EV6');
    expect(
      await screen.findByRole('heading', { name: 'Kia EV6 knowledge base' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Heat pump availability varies by trim/),
    ).toBeInTheDocument();
  });

  it('shows the no-KB state for a target without a knowledge base', async () => {
    renderAt('/hunts/11/models/Skoda%20Enyaq');
    await screen.findByRole('heading', { level: 1, name: 'Skoda Enyaq' });
    expect(
      screen.getByText('No knowledge base built for this target yet.'),
    ).toBeInTheDocument();
  });
});

describe('SpecExplorer — not found', () => {
  it('renders a not-found state with a back link for an unknown target', async () => {
    renderAt('/hunts/11/models/Unknown%20Model');
    expect(await screen.findByText(/No target .*Unknown Model.* found/)).toBeInTheDocument();
    const back = screen.getByRole('link', { name: /Back to hunt/ });
    expect(back).toHaveAttribute('href', '/hunts/11');
  });
});
