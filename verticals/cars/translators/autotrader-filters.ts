/**
 * AutoTrader search-filter builder — SINGLE SOURCE OF TRUTH for filter NAMES.
 *
 * Two pipelines build AutoTrader `FilterInput[]` arrays from car-search criteria:
 *   - the watcher poll path  (verticals/cars/translators/autotrader.ts)
 *   - the agent recon MCP    (container/agent-runner/src/autotrader-search-mcp.ts)
 * They live in separate compilation roots that cannot import each other at
 * container runtime: container/agent-runner/src is copied standalone into the
 * agent container (and into each group's agent-runner-src cache), while
 * verticals/ is never mounted there. To stop the filter NAMES from silently
 * drifting again (the Issue-3 bug), this module is VENDORED — kept byte-identical
 * in both trees:
 *   - verticals/cars/translators/autotrader-filters.ts
 *   - container/agent-runner/src/autotrader-filters.ts
 * A test (verticals/cars/translators/autotrader.test.ts) asserts the two copies
 * are identical, so editing one without the other fails the suite.
 *
 * Filter-name enum values are confirmed against the live AutoTrader FilterName
 * enum (cars-first test, 2026-06-28): make / model / min_year_manufactured /
 * max_year_manufactured / max_price / max_mileage / postcode / price_search_type
 * / home_delivery_adverts / fuel_type / transmission.
 */

export interface AutotraderFilterInput {
  filter: string;
  selected: string[];
}

/** Authoritative AutoTrader FilterName values (the strings that drifted before). */
export const AT_FILTER = {
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
} as const;

/** Flat searchable inputs for one AutoTrader car search. */
export interface AutotraderFilterValues {
  make: string;
  model?: string;
  year_min?: number;
  year_max?: number;
  max_price?: number;
  max_mileage?: number;
  postcode: string;
  fuel?: string;
  transmission?: string;
}

/**
 * Build the AutoTrader `FilterInput[]` for one car search from flat values.
 * This is the only place that knows the filter NAMES and per-filter shape, so
 * the watcher translator and the recon MCP cannot diverge. It does not validate
 * — each caller enforces its own required-field contract before calling.
 */
export function buildAutotraderFilters(v: AutotraderFilterValues): AutotraderFilterInput[] {
  const filters: AutotraderFilterInput[] = [{ filter: AT_FILTER.make, selected: [v.make] }];

  if (v.model) filters.push({ filter: AT_FILTER.model, selected: [v.model] });
  if (v.year_min != null)
    filters.push({ filter: AT_FILTER.minYear, selected: [String(v.year_min)] });
  if (v.year_max != null)
    filters.push({ filter: AT_FILTER.maxYear, selected: [String(v.year_max)] });
  if (v.max_price != null)
    filters.push({ filter: AT_FILTER.maxPrice, selected: [String(v.max_price)] });
  if (v.max_mileage != null)
    filters.push({ filter: AT_FILTER.maxMileage, selected: [String(v.max_mileage)] });

  filters.push({ filter: AT_FILTER.postcode, selected: [v.postcode] });

  // Constants — always included.
  filters.push({ filter: AT_FILTER.priceSearchType, selected: ['total'] });
  filters.push({ filter: AT_FILTER.homeDeliveryAdverts, selected: ['include'] });

  if (v.fuel) filters.push({ filter: AT_FILTER.fuelType, selected: [v.fuel] });
  if (v.transmission)
    filters.push({ filter: AT_FILTER.transmission, selected: [v.transmission] });

  return filters;
}
