/**
 * Tests for translateCarsCriteriaToAutotrader.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateCarsCriteriaToAutotrader } from './autotrader.js';
import type { CarsCriteria } from './autotrader.js';
import { AT_FILTER, buildAutotraderFilters } from './autotrader-filters.js';

describe('translateCarsCriteriaToAutotrader', () => {
  const baseCriteria: CarsCriteria = {
    make: 'Audi',
    model: 'A4',
    postcode: 'LE11AB',
  };

  it('produces the correct make filter', () => {
    const result = translateCarsCriteriaToAutotrader(baseCriteria);
    const makeFilter = result.filters.find((f) => f.filter === 'make');
    expect(makeFilter).toBeDefined();
    expect(makeFilter!.selected).toEqual(['Audi']);
  });

  it('produces the correct model filter', () => {
    const result = translateCarsCriteriaToAutotrader(baseCriteria);
    const modelFilter = result.filters.find((f) => f.filter === 'model');
    expect(modelFilter).toBeDefined();
    expect(modelFilter!.selected).toEqual(['A4']);
  });

  it('produces the postcode filter', () => {
    const result = translateCarsCriteriaToAutotrader(baseCriteria);
    const postcodeFilter = result.filters.find((f) => f.filter === 'postcode');
    expect(postcodeFilter).toBeDefined();
    expect(postcodeFilter!.selected).toEqual(['LE11AB']);
  });

  it('always includes price_search_type=total constant', () => {
    const result = translateCarsCriteriaToAutotrader(baseCriteria);
    const priceTypeFilter = result.filters.find((f) => f.filter === 'price_search_type');
    expect(priceTypeFilter).toBeDefined();
    expect(priceTypeFilter!.selected).toEqual(['total']);
  });

  it('always includes home_delivery_adverts=include constant', () => {
    const result = translateCarsCriteriaToAutotrader(baseCriteria);
    const homeDelivFilter = result.filters.find((f) => f.filter === 'home_delivery_adverts');
    expect(homeDelivFilter).toBeDefined();
    expect(homeDelivFilter!.selected).toEqual(['include']);
  });

  it('adds year_min filter when provided', () => {
    const result = translateCarsCriteriaToAutotrader({ ...baseCriteria, year_min: 2016 });
    const f = result.filters.find((f) => f.filter === 'min_year_manufactured');
    expect(f).toBeDefined();
    expect(f!.selected).toEqual(['2016']);
  });

  it('adds year_max filter when provided', () => {
    const result = translateCarsCriteriaToAutotrader({ ...baseCriteria, year_max: 2022 });
    const f = result.filters.find((f) => f.filter === 'max_year_manufactured');
    expect(f).toBeDefined();
    expect(f!.selected).toEqual(['2022']);
  });

  it('adds max_price filter when provided', () => {
    const result = translateCarsCriteriaToAutotrader({ ...baseCriteria, max_price: 15000 });
    const f = result.filters.find((f) => f.filter === 'max_price');
    expect(f).toBeDefined();
    expect(f!.selected).toEqual(['15000']);
  });

  it('adds maximum_mileage filter when provided', () => {
    const result = translateCarsCriteriaToAutotrader({ ...baseCriteria, max_mileage: 80000 });
    const f = result.filters.find((f) => f.filter === 'max_mileage');
    expect(f).toBeDefined();
    expect(f!.selected).toEqual(['80000']);
  });

  it('adds fuel_type filter when fuel provided', () => {
    const result = translateCarsCriteriaToAutotrader({ ...baseCriteria, fuel: 'Diesel' });
    const f = result.filters.find((f) => f.filter === 'fuel_type');
    expect(f).toBeDefined();
    expect(f!.selected).toEqual(['Diesel']);
  });

  it('adds transmission filter when provided', () => {
    const result = translateCarsCriteriaToAutotrader({ ...baseCriteria, transmission: 'Automatic' });
    const f = result.filters.find((f) => f.filter === 'transmission');
    expect(f).toBeDefined();
    expect(f!.selected).toEqual(['Automatic']);
  });

  it('omits optional filters when not provided', () => {
    const result = translateCarsCriteriaToAutotrader(baseCriteria);
    const filterNames = result.filters.map((f) => f.filter);
    expect(filterNames).not.toContain('min_year_manufactured');
    expect(filterNames).not.toContain('max_year_manufactured');
    expect(filterNames).not.toContain('max_price');
    expect(filterNames).not.toContain('max_mileage');
    expect(filterNames).not.toContain('fuel_type');
    expect(filterNames).not.toContain('transmission');
  });

  it('handles full criteria with all fields', () => {
    const full: CarsCriteria = {
      make: 'BMW',
      model: '3 Series',
      postcode: 'SW1A1AA',
      year_min: 2018,
      year_max: 2022,
      max_price: 25000,
      max_mileage: 50000,
      fuel: 'Petrol',
      transmission: 'Automatic',
    };
    const result = translateCarsCriteriaToAutotrader(full);
    const filterNames = result.filters.map((f) => f.filter);
    expect(filterNames).toContain('make');
    expect(filterNames).toContain('model');
    expect(filterNames).toContain('min_year_manufactured');
    expect(filterNames).toContain('max_year_manufactured');
    expect(filterNames).toContain('max_price');
    expect(filterNames).toContain('max_mileage');
    expect(filterNames).toContain('postcode');
    expect(filterNames).toContain('fuel_type');
    expect(filterNames).toContain('transmission');

    const makeFilter = result.filters.find((f) => f.filter === 'make');
    expect(makeFilter!.selected).toEqual(['BMW']);
  });

  it('throws when make is missing', () => {
    expect(() =>
      translateCarsCriteriaToAutotrader({ make: '', model: 'A4', postcode: 'LE11AB' }),
    ).toThrow(/make is required/i);
  });

  it('throws when postcode is missing', () => {
    expect(() =>
      translateCarsCriteriaToAutotrader({ make: 'Audi', model: 'A4', postcode: '' }),
    ).toThrow(/postcode is required/i);
  });

  it('matches spike #1 filter array format exactly', () => {
    // Validate against the exact working request from spike #1
    const result = translateCarsCriteriaToAutotrader({
      make: 'Audi',
      model: 'A4',
      postcode: 'LE11AB',
      max_price: 15000,
    });

    expect(result.filters).toContainEqual({ filter: 'make', selected: ['Audi'] });
    expect(result.filters).toContainEqual({ filter: 'model', selected: ['A4'] });
    expect(result.filters).toContainEqual({ filter: 'max_price', selected: ['15000'] });
    expect(result.filters).toContainEqual({ filter: 'postcode', selected: ['LE11AB'] });
    expect(result.filters).toContainEqual({ filter: 'price_search_type', selected: ['total'] });
    expect(result.filters).toContainEqual({ filter: 'home_delivery_adverts', selected: ['include'] });
  });
});

describe('translateCarsCriteriaToAutotrader — multi-model (shared/targets)', () => {
  const multiCriteria: CarsCriteria = {
    shared: {
      postcode: 'M346EP',
      max_price: 22000,
      max_mileage: 80000,
      fuel: 'Electric',
    },
    targets: {
      'Jaguar I-Pace': { make: 'Jaguar', model: 'I-Pace', year_min: 2021 },
      'Kia EV6': { make: 'Kia', model: 'EV6' },
    },
    intent: { must_have: ['Adaptive cruise'] }, // must never leak into filters
  };

  it('selects the target named by the search term and merges shared fields', () => {
    const result = translateCarsCriteriaToAutotrader(multiCriteria, 'Jaguar I-Pace');
    expect(result.filters).toContainEqual({ filter: 'make', selected: ['Jaguar'] });
    expect(result.filters).toContainEqual({ filter: 'model', selected: ['I-Pace'] });
    expect(result.filters).toContainEqual({ filter: 'min_year_manufactured', selected: ['2021'] });
    // shared, applied to every model
    expect(result.filters).toContainEqual({ filter: 'postcode', selected: ['M346EP'] });
    expect(result.filters).toContainEqual({ filter: 'max_price', selected: ['22000'] });
    expect(result.filters).toContainEqual({ filter: 'max_mileage', selected: ['80000'] });
    expect(result.filters).toContainEqual({ filter: 'fuel_type', selected: ['Electric'] });
  });

  it('produces a different per-model filter set for a different term', () => {
    const result = translateCarsCriteriaToAutotrader(multiCriteria, 'Kia EV6');
    expect(result.filters).toContainEqual({ filter: 'make', selected: ['Kia'] });
    expect(result.filters).toContainEqual({ filter: 'model', selected: ['EV6'] });
    // EV6 target has no year bound
    expect(result.filters.map((f) => f.filter)).not.toContain('min_year_manufactured');
  });

  it('never emits filters for evaluator-only intent', () => {
    const result = translateCarsCriteriaToAutotrader(multiCriteria, 'Kia EV6');
    const names = result.filters.map((f) => f.filter);
    expect(names).not.toContain('must_have');
    expect(names).not.toContain('intent');
  });

  it('resolves a single-target hunt whose term matches its key', () => {
    const single: CarsCriteria = {
      shared: { postcode: 'M346EP' },
      targets: { 'Kia EV6': { make: 'Kia', model: 'EV6' } },
    };
    const result = translateCarsCriteriaToAutotrader(single, 'Kia EV6');
    expect(result.filters).toContainEqual({ filter: 'make', selected: ['Kia'] });
  });

  it('throws (not silently re-search) when a single-target term does not match its key', () => {
    // The footgun: ONE target but the searched term is a DIFFERENT model. The old
    // tolerant fallback used the lone target regardless of the term, so the
    // intended model was never searched with no error. It must now throw loudly,
    // naming the available key and the offending term.
    const single: CarsCriteria = {
      shared: { postcode: 'M346EP' },
      targets: { 'Kia EV6': { make: 'Kia', model: 'EV6' } },
    };
    expect(() => translateCarsCriteriaToAutotrader(single, 'Hyundai Ioniq 5')).toThrow(
      /no target matches search term "Hyundai Ioniq 5".*"Kia EV6"/is,
    );
  });

  it('throws a descriptive error when a term matches no target (multi-target)', () => {
    expect(() => translateCarsCriteriaToAutotrader(multiCriteria, 'Tesla Model 3')).toThrow(
      /no target matches search term/i,
    );
  });
});

describe('autotrader-filters — single source of truth / drift guard', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const canonical = path.join(here, 'autotrader-filters.ts');
  const vendored = path.join(
    here,
    '..',
    '..',
    '..',
    'container',
    'agent-runner',
    'src',
    'autotrader-filters.ts',
  );

  it('the agent-runner vendored copy is byte-identical to the canonical copy', () => {
    // The two pipelines (watcher translator + agent recon MCP) live in separate
    // compilation roots and cannot import each other at container runtime, so the
    // filter builder is vendored. This locks the copies together: editing one
    // without the other (the Issue-3 drift) fails here.
    expect(readFileSync(vendored, 'utf8')).toBe(readFileSync(canonical, 'utf8'));
  });

  it('pins the confirmed AutoTrader FilterName enum values', () => {
    // Belt-and-suspenders: catches a coordinated rename in BOTH copies (which the
    // byte-identity check alone would pass) against the live-confirmed names.
    expect(AT_FILTER).toEqual({
      make: 'make',
      model: 'model',
      minYear: 'min_year_manufactured',
      maxYear: 'max_year_manufactured',
      maxPrice: 'max_price',
      maxMileage: 'max_mileage',
      postcode: 'postcode',
      priceSearchType: 'price_search_type',
      homeDeliveryAdverts: 'home_delivery_adverts',
      fuelType: 'fuel_type',
      transmission: 'transmission',
    });
  });

  it('the watcher translator emits exactly the shared builder output', () => {
    // Locks the watcher poll path to the shared builder for a full-field input.
    const translated = translateCarsCriteriaToAutotrader({
      make: 'BMW',
      model: '3 Series',
      postcode: 'SW1A1AA',
      year_min: 2018,
      year_max: 2022,
      max_price: 25000,
      max_mileage: 50000,
      fuel: 'Petrol',
      transmission: 'Automatic',
    });
    const built = buildAutotraderFilters({
      make: 'BMW',
      model: '3 Series',
      postcode: 'SW1A1AA',
      year_min: 2018,
      year_max: 2022,
      max_price: 25000,
      max_mileage: 50000,
      fuel: 'Petrol',
      transmission: 'Automatic',
    });
    expect(translated.filters).toEqual(built);
  });
});
