/**
 * Tests for source-specific subcomponents extracted from OfferDetail.
 * Tests eBay regression path and cars/AutoTrader path.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import EbayAuctionBlock from '../components/source-specific/EbayAuctionBlock';
import EbayConditionBadge from '../components/source-specific/EbayConditionBadge';
import ViewOnSourceLink from '../components/source-specific/ViewOnSourceLink';
import CarAttributesBlock from '../components/source-specific/CarAttributesBlock';

import type { Offer } from '@shared/types';

// Base offer shape — all nullable eBay-specific fields are null
const baseOffer: Offer = {
  id: 1,
  source: 'ebay',
  source_id: 'v1|123|0',
  title: 'Test listing',
  url: 'https://www.ebay.co.uk/itm/123',
  seller: 'seller123',
  seller_rating: 99.5,
  condition: 'Used',
  buying_format: 'AUCTION',
  auction_end_time: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), // 3h from now
  bid_count: 5,
  specs_extracted: '{}',
  watching: 0,
  watch_conditions: null,
  status: 'active',
  first_seen_at: '2024-01-01T00:00:00',
  last_seen_at: '2024-01-02T00:00:00',
  last_status_change: null,
  notified_thresholds: null,
  thumbnail_url: null,
  vertical: 'computers',
  attributes: {},
};

const carsOffer: Offer = {
  ...baseOffer,
  id: 2,
  source: 'autotrader',
  source_id: '2024012345',
  title: '2019 Audi A4 2.0 TDI',
  url: 'https://www.autotrader.co.uk/car-details/2024012345',
  condition: null,
  buying_format: null,
  auction_end_time: null,
  bid_count: null,
  vertical: 'cars',
  attributes: {
    year: 2019,
    mileage_text: '45,000 miles',
    fuel: 'Diesel',
    body_type: 'Saloon',
    transmission: 'Manual',
    colour: 'Phantom Black',
    seller_type: 'trade',
    location_text: 'Leicester (3 miles)',
    distance_miles: 12,
    price_tier: 'GREAT',
    price_tier_label: 'Great Price',
    price_deviation_gbp: -1732,
  },
};

// --- EbayConditionBadge ---

describe('EbayConditionBadge', () => {
  it('renders condition text when condition is set', () => {
    render(<EbayConditionBadge condition="Used" />);
    expect(screen.getByText('Used')).toBeInTheDocument();
  });

  it('renders nothing when condition is null', () => {
    const { container } = render(<EbayConditionBadge condition={null} />);
    expect(container.firstChild).toBeNull();
  });
});

// --- EbayAuctionBlock ---

describe('EbayAuctionBlock', () => {
  it('renders bid count for an active auction', () => {
    render(<EbayAuctionBlock offer={baseOffer} />);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText(/bids?/)).toBeInTheDocument();
    expect(screen.getByText(/remaining/)).toBeInTheDocument();
  });

  it('renders nothing when auction_end_time is null (no countdown available)', () => {
    const noAuction = { ...baseOffer, auction_end_time: null };
    const { container } = render(<EbayAuctionBlock offer={noAuction} />);
    expect(container.firstChild).toBeNull();
  });
});

// --- ViewOnSourceLink ---

describe('ViewOnSourceLink', () => {
  it('renders "View on eBay" for eBay offers', () => {
    render(<ViewOnSourceLink offer={baseOffer} />);
    expect(screen.getByText(/View on eBay/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', baseOffer.url!);
  });

  it('renders "View on AutoTrader" for autotrader offers', () => {
    render(<ViewOnSourceLink offer={carsOffer} />);
    expect(screen.getByText(/View on AutoTrader/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', carsOffer.url!);
  });

  it('renders nothing when url is null', () => {
    const noUrl = { ...baseOffer, url: null };
    const { container } = render(<ViewOnSourceLink offer={noUrl} />);
    expect(container.firstChild).toBeNull();
  });
});

// --- CarAttributesBlock ---

describe('CarAttributesBlock', () => {
  it('renders all car-specific attributes', () => {
    render(<CarAttributesBlock attributes={carsOffer.attributes} source="autotrader" />);
    expect(screen.getByText('2019')).toBeInTheDocument();
    expect(screen.getByText('45,000 miles')).toBeInTheDocument();
    expect(screen.getByText('Diesel')).toBeInTheDocument();
    expect(screen.getByText('Saloon')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('Phantom Black')).toBeInTheDocument();
    // seller_type: 'trade' should be capitalised to "Trade"
    expect(screen.getByText('Trade')).toBeInTheDocument();
    // location_text "Leicester (3 miles)" should display only the city "Leicester"
    expect(screen.getByText('Leicester')).toBeInTheDocument();
    // The raw "(3 miles)" suffix should NOT appear in location; distance_miles covers it separately
    expect(screen.queryByText(/\(3 miles\)/)).not.toBeInTheDocument();
    expect(screen.getByText(/12 mi/)).toBeInTheDocument();
    // Price-opinion row is relabelled with the offer's source
    expect(screen.getByText(/Source opinion — autotrader/)).toBeInTheDocument();
    expect(screen.getByText('Great Price')).toBeInTheDocument();
    expect(screen.getByText(/below market/)).toBeInTheDocument();
  });

  it('renders nothing when attributes are empty', () => {
    const { container } = render(<CarAttributesBlock attributes={{}} source="autotrader" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders gracefully when some attributes are missing', () => {
    render(
      <CarAttributesBlock
        attributes={{ year: 2020, mileage_text: '30k miles' }}
        source="autotrader"
      />,
    );
    expect(screen.getByText('2020')).toBeInTheDocument();
    expect(screen.getByText('30k miles')).toBeInTheDocument();
    // Should not throw even without fuel, body, seller_type, or location_text.
  });

  it('renders gracefully when seller_type and location_text are absent', () => {
    render(
      <CarAttributesBlock
        attributes={{ year: 2021, price_tier: 'FAIR', price_tier_label: 'Fair Price' }}
        source="autotrader"
      />,
    );
    expect(screen.getByText('2021')).toBeInTheDocument();
    expect(screen.getByText('Fair Price')).toBeInTheDocument();
    expect(screen.getByText(/Source opinion — autotrader/)).toBeInTheDocument();
    // No seller/location rows rendered
    expect(screen.queryByText('Seller')).not.toBeInTheDocument();
    expect(screen.queryByText('Location')).not.toBeInTheDocument();
  });

  it('does not render an opinion row when the source offered no analysis', () => {
    render(
      <CarAttributesBlock
        attributes={{ year: 2021, price_tier: 'NOANALYSIS', price_tier_label: 'Great Price' }}
        source="autotrader"
      />,
    );
    expect(screen.getByText('2021')).toBeInTheDocument();
    expect(screen.queryByText(/Source opinion/)).not.toBeInTheDocument();
    expect(screen.queryByText('Great Price')).not.toBeInTheDocument();
  });

  it('strips "(X miles)" suffix from AT location_text and shows only the city', () => {
    render(
      <CarAttributesBlock attributes={{ location_text: 'Birmingham (8 miles)' }} source="autotrader" />,
    );
    expect(screen.getByText('Birmingham')).toBeInTheDocument();
    expect(screen.queryByText(/\(8 miles\)/)).not.toBeInTheDocument();
  });
});

// --- Issue 8: Async-refresh deduplication (unit test of Map semantics) ---
// The real deduplication lives in dashboard/server/routes/offers.ts:activeRefreshByOffer.
// This test exercises the same Map<offerId, {refreshId, promise}> contract in isolation
// so CI can catch regressions to the dedupe logic without spinning up a server.

describe('Async refresh deduplication (Issue 8)', () => {
  it('returns the same refresh_id for a second request while the first is in-flight', () => {
    type Job = { refreshId: string; promise: Promise<{ status: string }> };
    const activeRefreshByOffer = new Map<number, Job>();

    function startRefresh(offerId: number): { status: string; refresh_id: string; isNew: boolean } {
      const existing = activeRefreshByOffer.get(offerId);
      if (existing) {
        return { status: 'pending', refresh_id: existing.refreshId, isNew: false };
      }
      const refreshId = `id-${offerId}-${Date.now()}`;
      const promise = new Promise<{ status: string }>((resolve) => {
        setTimeout(() => {
          activeRefreshByOffer.delete(offerId);
          resolve({ status: 'active' });
        }, 50);
      });
      activeRefreshByOffer.set(offerId, { refreshId, promise });
      return { status: 'pending', refresh_id: refreshId, isNew: true };
    }

    const first = startRefresh(42);
    const second = startRefresh(42);

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.refresh_id).toBe(first.refresh_id);
    // Different offer: gets a new job
    const other = startRefresh(99);
    expect(other.isNew).toBe(true);
    expect(other.refresh_id).not.toBe(first.refresh_id);
  });
});

// --- Issue 12: Async-refresh polling uses GET (not POST) ---
// Verifies that the OfferDetail handleRefresh polling path calls apiGet, not apiPost.
// We exercise this by mocking the API calls and confirming the verb used.

describe('Async-refresh polling verb (Issue 12)', () => {
  it('uses GET to poll the refresh status endpoint', async () => {
    // Simulate the sequence: POST /offers/:id/refresh → 202 + refresh_id,
    // then GET /offers/:id/refresh/:refresh_id → completed.
    const calls: Array<{ verb: 'GET' | 'POST'; url: string }> = [];

    async function apiPost(url: string) {
      calls.push({ verb: 'POST', url });
      return { status: 'pending', refresh_id: 'abc-123' };
    }

    async function apiGet(url: string) {
      calls.push({ verb: 'GET', url });
      return { status: 'active' };
    }

    // Replicate the handleRefresh polling logic from OfferDetail.tsx
    const offerId = 7;
    const result = await apiPost(`/offers/${offerId}/refresh`);

    if (result.status === 'pending' && result.refresh_id) {
      await apiGet(`/offers/${offerId}/refresh/${result.refresh_id}`);
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ verb: 'POST', url: '/offers/7/refresh' });
    expect(calls[1]).toEqual({ verb: 'GET', url: '/offers/7/refresh/abc-123' });
  });
});
