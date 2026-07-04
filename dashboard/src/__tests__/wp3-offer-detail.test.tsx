/**
 * WP3 — OfferDetail page integration tests:
 * - cars offer dismissed from its first hunt uses the WATCHING hunt
 *   (primaryHuntId) for the must-have chips + "Spec sheet →" link, so the
 *   must-haves shown belong to the same hunt as the market context;
 * - eBay offers are untouched: no chips, no spec link, no Car Details,
 *   zero /targets fetches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom';
import type {
  OfferDetail as OfferDetailType,
  HuntTargetsData,
  HuntBaselineData,
} from '@shared/types';

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

vi.mock('@/components/verticals/cars/MustHaveChips', () => ({
  default: ({ mode }: { mode: string }) => (
    <div data-testid="must-have-chips">{mode}</div>
  ),
}));

import { apiGet } from '@/lib/api';
import OfferDetail from '../pages/OfferDetail';

const emptyBaseline: HuntBaselineData = {
  segments: [],
  unclassified_count: 0,
  active_offer_prices: [],
};

const targetsFixture: HuntTargetsData = {
  hunt_id: 2,
  vertical: 'cars',
  must_have: ['Heat pump'],
  targets: [
    {
      target_key: 'Kia EV6',
      criteria: { make: 'Kia', model: 'EV6' },
      kb: null,
      verifications: [],
    },
  ],
};

const carsOffer: OfferDetailType = {
  id: 7,
  source: 'autotrader',
  source_id: 'at-7',
  title: 'Kia EV6 GT-Line S 77.4kWh',
  url: 'https://www.autotrader.co.uk/car-details/at-7',
  seller: null,
  seller_rating: null,
  condition: null,
  buying_format: null,
  auction_end_time: null,
  bid_count: null,
  specs_extracted: '{}',
  watching: 1,
  watch_conditions: null,
  status: 'active',
  first_seen_at: '2026-07-01T00:00:00',
  last_seen_at: '2026-07-02T00:00:00',
  last_status_change: null,
  notified_thresholds: null,
  thumbnail_url: null,
  vertical: 'cars',
  attributes: { make: 'Kia', model: 'EV6', year: 2022 },
  // Dismissed from hunt 1, watching in hunt 2 → hunt 2 is the primary hunt.
  hunt_associations: [
    { hunt_id: 1, hunt_name: 'Old cars hunt', status: 'dismissed' },
    { hunt_id: 2, hunt_name: 'Family EV', status: 'watching' },
  ],
  evaluations: [],
  alerts: [],
};

const ebayOffer: OfferDetailType = {
  ...carsOffer,
  id: 8,
  source: 'ebay',
  source_id: 'v1|888|0',
  title: 'Lenovo ThinkCentre M75q Gen 2',
  url: 'https://www.ebay.co.uk/itm/888',
  condition: 'Used',
  buying_format: 'FIXED_PRICE',
  vertical: 'computers',
  attributes: {},
  hunt_associations: [{ hunt_id: 1, hunt_name: 'Mini PCs', status: 'new' }],
};

function mockApiFor(offer: OfferDetailType) {
  vi.mocked(apiGet).mockImplementation((path: string) => {
    if (path === `/offers/${offer.id}`) return Promise.resolve(offer);
    if (path === `/offers/${offer.id}/prices`) return Promise.resolve([]);
    if (path.endsWith('/baseline')) return Promise.resolve(emptyBaseline);
    if (path === '/hunts/2/targets') return Promise.resolve(targetsFixture);
    return Promise.reject(new Error(`Unexpected apiGet: ${path}`));
  });
}

function renderOffer(id: number) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/offers/${id}`]}>
        <Routes>
          <Route path="/offers/:id" element={<OfferDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
});

describe('OfferDetail — cars offer dismissed from its first hunt', () => {
  it('fetches targets for the watching hunt, not the dismissed one', async () => {
    mockApiFor(carsOffer);
    renderOffer(7);
    expect(await screen.findByText('Must-haves')).toBeInTheDocument();
    const calls = vi.mocked(apiGet).mock.calls.map((c) => c[0]);
    expect(calls).toContain('/hunts/2/targets');
    expect(calls).not.toContain('/hunts/1/targets');
  });

  it('renders full-mode chips and links the spec sheet into the watching hunt', async () => {
    mockApiFor(carsOffer);
    renderOffer(7);
    expect(await screen.findByText('Must-haves')).toBeInTheDocument();
    expect(screen.getByTestId('must-have-chips')).toHaveTextContent('full');
    const link = screen.getByRole('link', { name: /Spec sheet/ });
    expect(link).toHaveAttribute('href', '/hunts/2/models/Kia%20EV6');
    // Car Details block also renders for cars offers
    expect(screen.getByText('Car Details')).toBeInTheDocument();
  });
});

describe('OfferDetail — eBay offer regression', () => {
  it('renders no chips, no spec link, no Car Details, and never fetches /targets', async () => {
    mockApiFor(ebayOffer);
    renderOffer(8);
    expect(await screen.findByText(/View on eBay/)).toBeInTheDocument();
    expect(screen.queryByText('Must-haves')).not.toBeInTheDocument();
    expect(screen.queryByTestId('must-have-chips')).not.toBeInTheDocument();
    expect(screen.queryByText(/Spec sheet/)).not.toBeInTheDocument();
    expect(screen.queryByText('Car Details')).not.toBeInTheDocument();
    const calls = vi.mocked(apiGet).mock.calls.map((c) => c[0]);
    expect(calls.some((p) => String(p).includes('/targets'))).toBe(false);
  });
});
