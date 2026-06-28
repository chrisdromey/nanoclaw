/**
 * Source adapter registry.
 * Each source's index.ts calls registerAdapter() as a side-effect on import.
 * The scheduler imports adapters via side-effect imports (e.g. import './sources/ebay/index.js').
 */

import type { SourceAdapter } from './types.js';

const adapters = new Map<string, SourceAdapter>();

export function registerAdapter(a: SourceAdapter): void {
  adapters.set(a.id, a);
}

export function getAdapter(id: string): SourceAdapter {
  const a = adapters.get(id);
  if (!a) throw new Error(`Unknown source adapter: ${id}`);
  return a;
}

export function listAdapters(): SourceAdapter[] {
  return [...adapters.values()];
}

export function hasAdapter(id: string): boolean {
  return adapters.has(id);
}
