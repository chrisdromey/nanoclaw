/**
 * WP3 — App routing: the SpecExplorer route renders under MemoryRouter at
 * /hunts/11/models/Kia%20EV6 (react-router decodes the target key param).
 * MainLayout is mocked (it wires SSE/sidebar); API layer is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom';
import type { HuntTargetsData, HuntBaselineData } from '@shared/types';

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

vi.mock('@/components/layout/MainLayout', async () => {
  const { Outlet } = await import('react-router-dom');
  return { default: () => <Outlet /> };
});

import { apiGet } from '@/lib/api';
import App from '../App';

const targetsFixture: HuntTargetsData = {
  hunt_id: 11,
  vertical: 'cars',
  must_have: ['Heat pump'],
  targets: [
    {
      target_key: 'Kia EV6',
      criteria: { make: 'Kia', model: 'EV6' },
      kb: {
        kb_path: 'references/kb/kia-ev6.md',
        citation_count: 4,
        must_have_citations: {},
        built_at: '2026-07-01T10:00:00',
      },
      verifications: [],
    },
  ],
};

const baselineFixture: HuntBaselineData = {
  segments: [],
  unclassified_count: 0,
  active_offer_prices: [],
};

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiGet).mockImplementation((path: string) => {
    if (path === '/hunts/11/targets') return Promise.resolve(targetsFixture);
    if (path === '/hunts/11/baseline') return Promise.resolve(baselineFixture);
    if (path === '/hunts/11/targets/Kia%20EV6/kb') {
      return Promise.resolve({
        target_key: 'Kia EV6',
        kb_path: 'references/kb/kia-ev6.md',
        built_at: '2026-07-01T10:00:00',
        markdown: '# EV6 KB',
      });
    }
    return Promise.reject(new Error(`Unexpected apiGet: ${path}`));
  });
});

describe('App — SpecExplorer route', () => {
  it('renders SpecExplorer at /hunts/11/models/Kia%20EV6', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/hunts/11/models/Kia%20EV6']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Param is URL-decoded by react-router and the page finds the target
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Kia EV6' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/4 cited sources/)).toBeInTheDocument();
    // KB fetched via the encoded target key path
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/hunts/11/targets/Kia%20EV6/kb');
  });
});
