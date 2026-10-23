/**
 * Vertical configuration loader.
 * Loads config/verticals.yml and resolves `inherit:` chains.
 * Stream C (Phase 2) extends verticals.yml with `cars` and other entries.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const DEFAULT_VERTICALS_PATH = resolve(
  fileURLToPath(import.meta.url),
  '../../../config/verticals.yml',
);

export interface VerticalAgentConfig {
  name: string;
  description: string;
  prompt: string;
}

export interface VerticalConfig {
  name: string;
  evaluator_skill: string;
  sourcing_skill: string;
  recon_tool: string;
  knowledge_base_path: string;
  sources: string[];
  default_poll_minutes: number;
  /** Cadence for re-checking WATCHED offers of this vertical (minutes). Absent → watcher default (2h). */
  watch_poll_minutes?: number;
  criteria_schema: Record<string, unknown>;
  notification_formatter?: string;
  attributes_required?: string[];
  agent?: VerticalAgentConfig;
}

type RawBlock = {
  inherit?: string;
  evaluator_skill?: string;
  sourcing_skill?: string;
  recon_tool?: string;
  knowledge_base_path?: string;
  sources?: string[];
  default_poll_minutes?: number;
  watch_poll_minutes?: number;
  criteria_schema?: Record<string, unknown>;
  notification_formatter?: string;
  attributes_required?: string[];
  agent?: VerticalAgentConfig;
};

let _cache: Map<string, VerticalConfig> | null = null;

/**
 * Load and parse verticals.yml. Returns a Map keyed by vertical name (excluding '_default').
 * Resolves `inherit: _default` (shallow merge, child overrides parent).
 * Throws on: missing _default, circular inherit, invalid inherit references.
 */
export function loadVerticals(path?: string): Map<string, VerticalConfig> {
  const filePath = path ?? DEFAULT_VERTICALS_PATH;
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parse(raw) as Record<string, RawBlock> | null;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`verticals.yml is empty or invalid at ${filePath}`);
  }

  if (!('_default' in parsed)) {
    throw new Error('verticals.yml must define a _default block');
  }

  const defaultBlock = parsed['_default'];
  if (!defaultBlock.evaluator_skill) {
    throw new Error('_default block must define evaluator_skill');
  }

  const result = new Map<string, VerticalConfig>();

  for (const [key, block] of Object.entries(parsed)) {
    if (key === '_default') continue;

    // Detect circular inherit (only single-level supported per spec)
    if (block.inherit === key) {
      throw new Error(
        `Circular inherit: vertical '${key}' inherits from itself`,
      );
    }

    let resolved: RawBlock;
    if (block.inherit) {
      if (block.inherit !== '_default') {
        // Validate the referenced key exists
        if (!(block.inherit in parsed)) {
          throw new Error(
            `Vertical '${key}' inherits from unknown key '${block.inherit}'`,
          );
        }
        // Detect circular (A → B → A or A → A)
        const parent = parsed[block.inherit];
        if (parent.inherit === key) {
          throw new Error(`Circular inherit: '${key}' <-> '${block.inherit}'`);
        }
      }

      const parent =
        block.inherit === '_default' ? defaultBlock : parsed[block.inherit];
      // Shallow merge: parent values, then child overrides
      resolved = { ...parent, ...block };
      delete resolved.inherit;
    } else {
      resolved = { ...block };
    }

    // Validate required fields after resolution
    if (!resolved.evaluator_skill) {
      throw new Error(
        `Vertical '${key}' is missing evaluator_skill (and does not inherit it)`,
      );
    }

    result.set(key, {
      name: key,
      evaluator_skill: resolved.evaluator_skill,
      sourcing_skill: resolved.sourcing_skill ?? 'ebay-sourcing',
      recon_tool: resolved.recon_tool ?? 'mcp__ebay-search__search_ebay',
      knowledge_base_path:
        resolved.knowledge_base_path ??
        'references/product-knowledge/{product}.md',
      sources: resolved.sources ?? [],
      default_poll_minutes: resolved.default_poll_minutes ?? 60,
      watch_poll_minutes: resolved.watch_poll_minutes,
      criteria_schema: resolved.criteria_schema ?? {},
      notification_formatter: resolved.notification_formatter,
      attributes_required: resolved.attributes_required,
      agent: resolved.agent,
    });
  }

  return result;
}

/** Load verticals with module-level caching. Suitable for production use. */
export function getVerticals(path?: string): Map<string, VerticalConfig> {
  if (!_cache) {
    _cache = loadVerticals(path);
  }
  return _cache;
}

/** Get a single vertical by name. Throws if not found. */
export function getVertical(name: string, path?: string): VerticalConfig {
  const map = getVerticals(path);
  const v = map.get(name);
  if (!v) {
    throw new Error(
      `Unknown vertical: '${name}'. Available: ${[...map.keys()].join(', ')}`,
    );
  }
  return v;
}

/** List all loaded verticals (excluding _default). */
export function listVerticals(path?: string): VerticalConfig[] {
  return [...getVerticals(path).values()];
}

/** Reset the module-level cache (for testing). */
export function _resetCache(): void {
  _cache = null;
}
