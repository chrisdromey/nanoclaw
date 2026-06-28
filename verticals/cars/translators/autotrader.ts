/**
 * Cars criteria → AutoTrader GraphQL filter array translator.
 *
 * Cars criteria shape (from verticals.yml):
 *   { make, model, year_min, year_max, max_price, max_mileage, postcode, fuel, transmission }
 *
 * Filter enum casing rules (spike #1 confirmed):
 *   - make: proper case, e.g. "Audi" (NOT "AUDI")
 *   - model: proper case, e.g. "A4"
 *   - min_year / max_year: string of 4-digit year
 *   - max_price: string integer
 *   - maximum_mileage: string integer
 *   - postcode: as-is, e.g. "LE11AB"
 *   - price_search_type: constant "total"
 *   - home_delivery_adverts: constant "include"
 *   - fuel-type: as supplied (e.g. "Petrol", "Diesel")
 *   - transmission: as supplied (e.g. "Automatic", "Manual")
 */

// Inline the filter types to avoid cross-compilation-root imports.
// These must stay in sync with watcher/src/sources/autotrader/types.ts.
export interface AutotraderFilterInput {
  filter: string;
  selected: string[];
}

export interface AutotraderSearchParams {
  filters: AutotraderFilterInput[];
  page?: number;
  sortBy?: 'relevance' | 'price-asc' | 'distance';
}

export interface CarsCriteria {
  make: string;
  model: string;
  postcode: string;
  year_min?: number;
  year_max?: number;
  max_price?: number;
  max_mileage?: number;
  fuel?: string;
  transmission?: string;
}

/**
 * Translate a cars hunt criteria object into the AutoTrader GraphQL filter array.
 *
 * @throws {Error} if required fields (make, postcode) are missing
 */
export function translateCarsCriteriaToAutotrader(
  criteria: CarsCriteria,
): AutotraderSearchParams & { filters: AutotraderFilterInput[] } {
  if (!criteria.make || criteria.make.trim() === '') {
    throw new Error(
      'translateCarsCriteriaToAutotrader: criteria.make is required. ' +
        'AutoTrader searches require a make filter to avoid returning all cars.',
    );
  }
  if (!criteria.postcode || criteria.postcode.trim() === '') {
    throw new Error(
      'translateCarsCriteriaToAutotrader: criteria.postcode is required. ' +
        'AutoTrader uses postcode for proximity sorting and distance filtering.',
    );
  }

  const filters: AutotraderSearchParams['filters'] = [
    { filter: 'make', selected: [criteria.make] },
  ];

  if (criteria.model) {
    filters.push({ filter: 'model', selected: [criteria.model] });
  }

  if (criteria.year_min != null) {
    filters.push({ filter: 'min_year', selected: [String(criteria.year_min)] });
  }

  if (criteria.year_max != null) {
    filters.push({ filter: 'max_year', selected: [String(criteria.year_max)] });
  }

  if (criteria.max_price != null) {
    filters.push({ filter: 'max_price', selected: [String(criteria.max_price)] });
  }

  if (criteria.max_mileage != null) {
    filters.push({ filter: 'maximum_mileage', selected: [String(criteria.max_mileage)] });
  }

  filters.push({ filter: 'postcode', selected: [criteria.postcode] });

  // Constants — always include
  filters.push({ filter: 'price_search_type', selected: ['total'] });
  filters.push({ filter: 'home_delivery_adverts', selected: ['include'] });

  if (criteria.fuel) {
    filters.push({ filter: 'fuel-type', selected: [criteria.fuel] });
  }

  if (criteria.transmission) {
    filters.push({ filter: 'transmission', selected: [criteria.transmission] });
  }

  return { filters };
}
