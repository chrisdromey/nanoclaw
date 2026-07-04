/**
 * Cars criteria → AutoTrader GraphQL filter array translator.
 *
 * A cars hunt is a WIDE NET cast across one or more candidate models that share
 * the same budget / location / mileage / fuel constraints. The watcher's
 * scheduler iterates the hunt's `search_terms` and calls this translator once
 * per term; each term names one model and maps to one entry in `criteria.targets`.
 *
 * Criteria shape (verticals.yml → cars.criteria_schema):
 *   {
 *     shared:  { postcode, max_price?, max_mileage?, fuel?, transmission? },
 *     targets: { "<term>": { make, model?, year_min?, year_max? }, ... },
 *     intent:  { ... }   // evaluator-only — NOT read here
 *   }
 *
 * IMPORTANT — what this translator can and cannot express:
 *   AutoTrader can only filter on make / model / year / price / mileage / fuel /
 *   transmission / postcode. Everything else in the brief (must-have features,
 *   trim/pack minimums, reject rules, per-model notes) lives in `criteria.intent`
 *   and is applied AFTER the search by the car-listing-evaluation skill against
 *   the returned listings. The search deliberately over-returns a coarse set;
 *   the evaluator triages it. Do not try to encode feature/trim intent here.
 *
 * Why one search per model (not one combined search): AutoTrader's make/model
 * filters cross-product, so make:[Jaguar,Kia] × model:[I-Pace,EV6] would also
 * match a "Jaguar EV6". The only faithful way to express N specific make+model
 * pairs is N searches — which is exactly what the scheduler's term loop drives.
 *
 * Back-compat: a flat single-model criteria ({ make, model, postcode, ... } with
 * no `targets`) is still accepted — the whole object is treated as one target
 * plus the shared constraints.
 *
 * Filter enum casing rules (spike #1 confirmed):
 *   - make/model: proper case, e.g. "Audi", "A4" (NOT "AUDI")
 *   - min_year_manufactured / max_year_manufactured: 4-digit year string
 *     (NOT "min_year"/"max_year" — those are rejected by the FilterName enum;
 *     confirmed by live probe during the cars-first test)
 *   - max_price: integer string
 *   - max_mileage: integer string (NOT "maximum_mileage" — also enum-rejected)
 *   - postcode: as-is, e.g. "LE11AB"
 *   - price_search_type: constant "total"
 *   - home_delivery_adverts: constant "include"
 *   - fuel_type: as supplied, e.g. "Electric", "Petrol" (NOT "fuel-type" — that
 *     name is rejected by the FilterName enum; confirmed during cars-first test)
 *   - transmission: as supplied, e.g. "Automatic", "Manual"
 */

// Filter NAMES and the per-filter build live in the vendored single-source-of-
// truth module (kept byte-identical in container/agent-runner/src) so the watcher
// translator and the agent recon MCP can't drift again. AutotraderFilterInput is
// re-exported here so existing importers keep their import path.
import { buildAutotraderFilters } from './autotrader-filters.js';
export type { AutotraderFilterInput } from './autotrader-filters.js';
import type { AutotraderFilterInput } from './autotrader-filters.js';

export interface AutotraderSearchParams {
  filters: AutotraderFilterInput[];
  page?: number;
  sortBy?: 'relevance' | 'price_asc' | 'price_desc' | 'distance';
}

/** One candidate model — the searchable, per-model part of a cars hunt. */
export interface CarsTarget {
  make: string;
  model?: string;
  year_min?: number;
  year_max?: number;
}

/** Constraints shared by every model in a cars hunt. */
export interface CarsShared {
  postcode: string;
  max_price?: number;
  max_mileage?: number;
  fuel?: string;
  transmission?: string;
}

/**
 * A cars hunt's criteria object. Supports the multi-model shape (`shared` +
 * `targets` + evaluator-only `intent`) and the legacy flat single-model shape
 * (top-level `make`/`model`/`postcode`/...).
 */
export interface CarsCriteria {
  // Multi-model shape
  shared?: CarsShared;
  targets?: Record<string, CarsTarget>;
  intent?: unknown; // evaluator-only; never read by this translator

  // Legacy flat shape (back-compat)
  make?: string;
  model?: string;
  postcode?: string;
  year_min?: number;
  year_max?: number;
  max_price?: number;
  max_mileage?: number;
  fuel?: string;
  transmission?: string;
}

/**
 * Resolve the (target, shared) pair for a given search term, handling both the
 * multi-model and the legacy flat criteria shapes.
 *
 * @throws {Error} if the term names no known target, or the criteria has neither
 *   `targets` nor a flat `make`.
 */
export function resolveCarsTarget(
  criteria: CarsCriteria,
  terms: string,
): { target: CarsTarget; shared: CarsShared } {
  // Multi-model shape: the term string is the key into `targets`. The match is
  // STRICT — `search_terms` strings MUST equal `targets` keys (enforced by the
  // skills). A mismatch is a misconfiguration, not something to paper over: a
  // single-target hunt with multiple search_terms would otherwise silently
  // re-search the lone target for every term, never searching the intended
  // models and emitting no error. A translator throw is a non-budget-burning
  // config error (Issue 5), so failing loudly here is safe and self-heals once
  // the criteria is fixed.
  if (criteria.targets && typeof criteria.targets === 'object') {
    const keys = Object.keys(criteria.targets);
    const target = criteria.targets[terms];
    if (!target) {
      throw new Error(
        `cars/autotrader: no target matches search term "${terms}". ` +
          `Available targets: ${keys.map((k) => `"${k}"`).join(', ') || '(none)'}. ` +
          'search_terms must use the same keys as criteria.targets.',
      );
    }
    return { target, shared: criteria.shared ?? ({} as CarsShared) };
  }

  // Legacy flat shape (no `targets`): the whole object is one target plus the
  // shared constraints. Required-field validation (make/postcode) is left to
  // translateCarsTargetToAutotrader so empty values still surface a clear error.
  return {
    target: {
      make: criteria.make ?? '',
      model: criteria.model,
      year_min: criteria.year_min,
      year_max: criteria.year_max,
    },
    shared: {
      postcode: criteria.postcode ?? '',
      max_price: criteria.max_price,
      max_mileage: criteria.max_mileage,
      fuel: criteria.fuel,
      transmission: criteria.transmission,
    },
  };
}

/**
 * Translate a cars hunt's criteria + the current search term into an AutoTrader
 * filter array. Resolves which model the term refers to, then merges that
 * model's searchable fields with the hunt's shared constraints.
 *
 * @throws {Error} if required fields (make, postcode) are missing
 */
export function translateCarsCriteriaToAutotrader(
  criteria: CarsCriteria,
  terms = '',
): AutotraderSearchParams & { filters: AutotraderFilterInput[] } {
  const { target, shared } = resolveCarsTarget(criteria, terms);
  return translateCarsTargetToAutotrader(target, shared);
}

/**
 * Build the AutoTrader filter array for one resolved model + shared constraints.
 * Only emits the filters AutoTrader actually supports — feature/trim/reject
 * intent is the evaluator's job, not the search's.
 *
 * @throws {Error} if required fields (make, postcode) are missing
 */
export function translateCarsTargetToAutotrader(
  target: CarsTarget,
  shared: CarsShared,
): AutotraderSearchParams & { filters: AutotraderFilterInput[] } {
  if (!target.make || target.make.trim() === '') {
    throw new Error(
      'translateCarsTargetToAutotrader: target.make is required. ' +
        'AutoTrader searches require a make filter to avoid returning all cars.',
    );
  }
  if (!shared.postcode || shared.postcode.trim() === '') {
    throw new Error(
      'translateCarsTargetToAutotrader: shared.postcode is required. ' +
        'AutoTrader uses postcode for proximity sorting and distance filtering.',
    );
  }

  const filters = buildAutotraderFilters({
    make: target.make,
    model: target.model,
    year_min: target.year_min,
    year_max: target.year_max,
    max_price: shared.max_price,
    max_mileage: shared.max_mileage,
    postcode: shared.postcode,
    fuel: shared.fuel,
    transmission: shared.transmission,
  });

  return { filters };
}
