/**
 * Per-vertical notification formatter registry.
 *
 * Maps notification_formatter name → a function that formats one listing
 * line for inclusion in the new-offer IPC task prompt.
 *
 * The formatter is cosmetic: it pre-renders the listing line so the
 * evaluator agent can see a formatted preview in the prompt.
 * The evaluator skill may still re-format for the final Telegram message.
 */

// Inline the minimal NormalisedListing type to avoid cross-rootDir import.
// Must stay in sync with watcher/src/sources/types.ts.
export interface FormattableListing {
  source: string;
  sourceId: string;
  title: string;
  url: string;
  priceGbp: number | null;
  currency: string;
  thumbnailUrl?: string;
  sellerType?: 'TRADE' | 'PRIVATE' | null;
  attributes: Record<string, unknown>;
}

export type FormatterFn = (listing: FormattableListing) => string;

const registry = new Map<string, FormatterFn>();

export function registerFormatter(name: string, fn: FormatterFn): void {
  registry.set(name, fn);
}

export function getFormatter(name: string): FormatterFn | undefined {
  return registry.get(name);
}

// ---- Built-in formatter registrations ----

// cars — delegates to verticals/cars/formatter.ts (loaded from compiled dist)
let _carsFormatter: FormatterFn | undefined;

async function loadCarsFormatter(): Promise<void> {
  try {
    const mod = await import('../../../verticals/dist/cars/formatter.js');
    _carsFormatter = mod.formatCarsNotification as FormatterFn;
    registerFormatter('cars', _carsFormatter);
  } catch {
    // Silently skip — if dist is absent, the generic formatter is used.
  }
}

// Eagerly load so it's ready by the first tick.
loadCarsFormatter().catch(() => {});
