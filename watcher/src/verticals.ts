/**
 * Vertical configuration loader — watcher module.
 * Thin re-implementation that reads the same config/verticals.yml as the root loader.
 * Kept separate because the watcher is a standalone TS project with its own rootDir.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
// watcher/src/ → watcher/ → project root → config/verticals.yml
const DEFAULT_VERTICALS_PATH = resolve(__dirname, '../../config/verticals.yml');

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

export function loadVerticals(filePath?: string): Map<string, VerticalConfig> {
  const path = filePath ?? DEFAULT_VERTICALS_PATH;
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw) as Record<string, RawBlock> | null;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`verticals.yml is empty or invalid at ${path}`);
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

    if (block.inherit === key) {
      throw new Error(`Circular inherit: vertical '${key}' inherits from itself`);
    }

    let resolved: RawBlock;
    if (block.inherit) {
      if (block.inherit !== '_default' && !(block.inherit in parsed)) {
        throw new Error(`Vertical '${key}' inherits from unknown key '${block.inherit}'`);
      }
      const parent = block.inherit === '_default' ? defaultBlock : parsed[block.inherit];
      if (parent.inherit === key) {
        throw new Error(`Circular inherit: '${key}' <-> '${block.inherit}'`);
      }
      resolved = { ...parent, ...block };
      delete resolved.inherit;
    } else {
      resolved = { ...block };
    }

    if (!resolved.evaluator_skill) {
      throw new Error(`Vertical '${key}' is missing evaluator_skill`);
    }

    result.set(key, {
      name: key,
      evaluator_skill: resolved.evaluator_skill,
      sourcing_skill: resolved.sourcing_skill ?? 'ebay-sourcing',
      recon_tool: resolved.recon_tool ?? 'mcp__ebay-search__search_ebay',
      knowledge_base_path:
        resolved.knowledge_base_path ?? 'references/product-knowledge/{product}.md',
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

export function getVerticals(filePath?: string): Map<string, VerticalConfig> {
  if (!_cache) {
    _cache = loadVerticals(filePath);
  }
  return _cache;
}

export function getVertical(name: string, filePath?: string): VerticalConfig {
  const map = getVerticals(filePath);
  const v = map.get(name);
  if (!v) {
    throw new Error(`Unknown vertical: '${name}'. Available: ${[...map.keys()].join(', ')}`);
  }
  return v;
}

/** Reset the cache (for testing). */
export function _resetCache(): void {
  _cache = null;
}
