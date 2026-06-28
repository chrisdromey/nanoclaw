/**
 * Tests for translateCarsCriteriaToAutotrader.
 */

import { describe, it, expect } from 'vitest';
import { translateCarsCriteriaToAutotrader } from './autotrader.js';
import type { CarsCriteria } from './autotrader.js';

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
    const f = result.filters.find((f) => f.filter === 'min_year');
    expect(f).toBeDefined();
    expect(f!.selected).toEqual(['2016']);
  });

  it('adds year_max filter when provided', () => {
    const result = translateCarsCriteriaToAutotrader({ ...baseCriteria, year_max: 2022 });
    const f = result.filters.find((f) => f.filter === 'max_year');
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
    const f = result.filters.find((f) => f.filter === 'maximum_mileage');
    expect(f).toBeDefined();
    expect(f!.selected).toEqual(['80000']);
  });

  it('adds fuel-type filter when fuel provided', () => {
    const result = translateCarsCriteriaToAutotrader({ ...baseCriteria, fuel: 'Diesel' });
    const f = result.filters.find((f) => f.filter === 'fuel-type');
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
    expect(filterNames).not.toContain('min_year');
    expect(filterNames).not.toContain('max_year');
    expect(filterNames).not.toContain('max_price');
    expect(filterNames).not.toContain('maximum_mileage');
    expect(filterNames).not.toContain('fuel-type');
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
    expect(filterNames).toContain('min_year');
    expect(filterNames).toContain('max_year');
    expect(filterNames).toContain('max_price');
    expect(filterNames).toContain('maximum_mileage');
    expect(filterNames).toContain('postcode');
    expect(filterNames).toContain('fuel-type');
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
