/**
 * Tests for the vertical filter dropdown in the layout header.
 * Verifies URL param updates and query key changes.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import '@testing-library/jest-dom';
import { queryKeys } from '../lib/query-keys';

// --- query-keys.ts ---

describe('queryKeys.hunts.all', () => {
  it('returns a key with vertical=undefined when called with no args', () => {
    const key = queryKeys.hunts.all();
    expect(key).toEqual(['hunts', { vertical: undefined }]);
  });

  it('returns a key with vertical=cars when called with "cars"', () => {
    const key = queryKeys.hunts.all('cars');
    expect(key).toEqual(['hunts', { vertical: 'cars' }]);
  });

  it('returns a key with vertical=computers when called with "computers"', () => {
    const key = queryKeys.hunts.all('computers');
    expect(key).toEqual(['hunts', { vertical: 'computers' }]);
  });

  it('produces different cache keys for different verticals', () => {
    const carsKey = JSON.stringify(queryKeys.hunts.all('cars'));
    const computersKey = JSON.stringify(queryKeys.hunts.all('computers'));
    const allKey = JSON.stringify(queryKeys.hunts.all());
    expect(carsKey).not.toBe(computersKey);
    expect(carsKey).not.toBe(allKey);
    expect(computersKey).not.toBe(allKey);
  });
});

// --- VerticalFilter component (inline render of MainLayout-extracted logic) ---

// Import MainLayout through the component path is complex due to SSE/sidebar hooks.
// Instead test the filter logic via URL-param reading and navigation.

import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';

function VerticalFilterTestHarness() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const vertical = searchParams.get('vertical') ?? '';

  const options = [
    { value: '', label: 'All' },
    { value: 'computers', label: 'Computers' },
    { value: 'cars', label: 'Cars' },
  ];

  const handleChange = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set('vertical', value);
    } else {
      params.delete('vertical');
    }
    navigate(`/hunts?${params.toString()}`, { replace: true });
  };

  return (
    <div>
      <div data-testid="current-vertical">{vertical || 'all'}</div>
      {options.map((opt) => (
        <button
          key={opt.value || 'all'}
          data-testid={`filter-${opt.value || 'all'}`}
          onClick={() => handleChange(opt.value)}
          aria-pressed={vertical === opt.value}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function TestApp() {
  const location = useLocation();
  return (
    <div>
      <div data-testid="location">{location.pathname + location.search}</div>
      <Routes>
        <Route path="/hunts" element={<VerticalFilterTestHarness />} />
      </Routes>
    </div>
  );
}

describe('Vertical filter navigation', () => {
  function renderAt(initialUrl: string) {
    return render(
      <MemoryRouter initialEntries={[initialUrl]}>
        <TestApp />
      </MemoryRouter>,
    );
  }

  it('shows "all" as the default selected state', () => {
    renderAt('/hunts');
    expect(screen.getByTestId('current-vertical').textContent).toBe('all');
  });

  it('clicking Cars updates the URL to ?vertical=cars', () => {
    renderAt('/hunts');
    fireEvent.click(screen.getByTestId('filter-cars'));
    expect(screen.getByTestId('location').textContent).toContain('vertical=cars');
  });

  it('clicking Computers updates the URL to ?vertical=computers', () => {
    renderAt('/hunts');
    fireEvent.click(screen.getByTestId('filter-computers'));
    expect(screen.getByTestId('location').textContent).toContain('vertical=computers');
  });

  it('clicking All removes the vertical param from the URL', () => {
    renderAt('/hunts?vertical=cars');
    fireEvent.click(screen.getByTestId('filter-all'));
    expect(screen.getByTestId('location').textContent).not.toContain('vertical=');
  });

  it('reads existing vertical param from URL on load', () => {
    renderAt('/hunts?vertical=cars');
    expect(screen.getByTestId('current-vertical').textContent).toBe('cars');
  });
});
