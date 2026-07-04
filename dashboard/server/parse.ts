/**
 * Parse a JSON column value, returning `fallback` for NULL/empty/malformed
 * input. The shared convention for turning TEXT JSON columns into objects at
 * the API boundary (offers.attributes, hunts.sources, kb.must_have_citations…).
 */
export function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
