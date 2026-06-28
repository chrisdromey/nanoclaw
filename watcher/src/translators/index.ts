/**
 * Per-(vertical, source) translator registry.
 *
 * Maps `${vertical}/${source}` → a function that converts a Hunt's criteria
 * and search terms into the source-native search params expected by that
 * adapter's search() method.
 *
 * Each translator must be registered at module load time. The scheduler
 * calls getTranslator() at dispatch time; if no translator is registered
 * for the (vertical, source) pair, the source is skipped with a warning.
 */

import type { Hunt } from '../db.js';

/**
 * A translator function converts a hunt's parsed criteria and the current
 * search term string into the native params object for one source adapter.
 */
export type TranslatorFn = (hunt: Hunt, terms: string) => unknown;

const registry = new Map<string, TranslatorFn>();

/** Register a translator for the given vertical/source pair. */
export function registerTranslator(vertical: string, source: string, fn: TranslatorFn): void {
  registry.set(`${vertical}/${source}`, fn);
}

/**
 * Look up a translator for the given vertical/source pair.
 * Returns undefined if no translator is registered — caller should skip + warn.
 */
export function getTranslator(vertical: string, source: string): TranslatorFn | undefined {
  return registry.get(`${vertical}/${source}`);
}

// ---- Built-in registrations ----

// computers / ebay — existing inline logic, promoted to a named translator
import type { EbaySearchParams } from '../sources/ebay/index.js';

const ebayComputersTranslator: TranslatorFn = (hunt, terms): EbaySearchParams => ({
  terms,
  categoryIds: hunt.category_ids ?? undefined,
});

registerTranslator('computers', 'ebay', ebayComputersTranslator);

// cars / autotrader — calls the cars-vertical translator from the compiled dist.
// The verticals/ directory is a sibling TS project with its own rootDir; we
// import from its pre-compiled dist/ to avoid cross-rootDir TS issues.
// Fallback: if dist is absent (fresh checkout), the import will throw and the
// source will be skipped with a descriptive error logged by the scheduler.
import type { CarsCriteria } from '../../../verticals/dist/cars/translators/autotrader.js';

let _carsAtTranslator: ((criteria: CarsCriteria) => unknown) | undefined;

async function loadCarsAtTranslator(): Promise<((criteria: CarsCriteria) => unknown) | undefined> {
  if (_carsAtTranslator !== undefined) return _carsAtTranslator;
  try {
    const mod = await import('../../../verticals/dist/cars/translators/autotrader.js');
    _carsAtTranslator = mod.translateCarsCriteriaToAutotrader as (criteria: CarsCriteria) => unknown;
    return _carsAtTranslator;
  } catch {
    return undefined;
  }
}

const carsAutotraderTranslator: TranslatorFn = (hunt, _terms) => {
  // Criteria is stored as JSON in hunt.criteria
  let criteria: CarsCriteria;
  try {
    criteria = JSON.parse(hunt.criteria) as CarsCriteria;
  } catch {
    throw new Error(`cars/autotrader translator: hunt.criteria is not valid JSON for hunt ${hunt.id}`);
  }

  // We use a sync call pattern here; the translator itself is sync once loaded.
  // On first call, if the module hasn't been loaded yet we throw to signal the
  // scheduler to skip — it will succeed on the next tick once loadCarsAtTranslator
  // has been awaited. In practice, we eagerly pre-load it below.
  if (_carsAtTranslator === undefined) {
    throw new Error('cars/autotrader translator: module not yet loaded — will retry next tick');
  }

  return _carsAtTranslator(criteria);
};

registerTranslator('cars', 'autotrader', carsAutotraderTranslator);

// Eagerly load the cars/autotrader translator module so it's ready for the first tick.
// Fire-and-forget — errors are swallowed here; the scheduler's catch block will log them.
loadCarsAtTranslator().catch(() => {
  // Silently ignored; the scheduler will warn on first use if undefined.
});
