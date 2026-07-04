/**
 * Deal Hunter — activation gate (shared)
 *
 * A hunt is created as a `draft` and can only become `active` (monitored) once it passes the
 * gate: its criteria are valid for its vertical AND it has at least one market segment. This
 * guarantees the watcher never polls a malformed hunt (which would throw and auto-pause the
 * source) and the dashboard never shows an empty hunt.
 *
 * These functions are parameterised by a better-sqlite3 `Database` so they can be reused by both
 * the MCP server (deal-hunter-mcp.ts) and the container's Agent SDK hooks (index.ts) without
 * importing the MCP server module (which has side effects on import).
 *
 * The criteria validation is data-driven from the vertical's `criteria_schema` (mirrored from
 * config/verticals.yml into the `verticals` table). It intentionally reproduces the watcher
 * translator's hard requirements (e.g. cars: shared.postcode + per-target make) without
 * hardcoding any single vertical — see verticals/cars/translators/autotrader.ts.
 *
 * VENDORED: this file is kept byte-identical between container/agent-runner/src/ (the canonical
 * copy, imported by the MCP + hooks) and dashboard/server/ (imported by the dashboard HTTP routes,
 * a second writer to the same DB). The two live in separate compilation roots that cannot import
 * each other, so the copy is locked together by a byte-identity drift-guard test. Edit BOTH.
 */

import type Database from 'better-sqlite3';

export interface HuntRow {
  id: number;
  criteria: string;
  vertical: string | null;
  status: string;
  // The hunt's search_terms JSON (e.g. `[{"terms":"Jaguar I-Pace"}]` or `["term"]`). Optional on the
  // type, but every gate caller MUST select it: the activation gate cross-checks it against any
  // `<...>` wildcard-map criteria (e.g. cars `targets`). Omitting it would make a populated map look
  // term-less and fail parity. null/undefined is treated as "no search terms".
  search_terms?: string | null;
}

// Result of resolving a vertical's config from the `verticals` table. We distinguish "config is
// genuinely available (possibly with an empty schema, e.g. computers)" from "config is missing or
// unparseable" so the gate can FAIL CLOSED on the latter instead of waving a hunt through with no
// checks. A null/absent row, an unreadable table, or invalid JSON are all treated as unavailable.
type VerticalConfigResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; reason: string };

function getVerticalConfig(db: Database.Database, name: string): VerticalConfigResult {
  let row: { config_json: string } | undefined;
  try {
    row = db.prepare('SELECT config_json FROM verticals WHERE name = ?').get(name) as
      | { config_json: string }
      | undefined;
  } catch {
    return {
      ok: false,
      reason: `vertical config unavailable for '${name}' — cannot read the verticals table (is the watcher running?)`,
    };
  }
  if (!row) {
    return {
      ok: false,
      reason: `vertical config unavailable for '${name}' — no row in the verticals table (is the watcher running?)`,
    };
  }
  try {
    return { ok: true, config: JSON.parse(row.config_json) as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      reason: `vertical config unavailable for '${name}' — config_json is not valid JSON`,
    };
  }
}

export function getSegmentCount(db: Database.Database, huntId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM market_segments WHERE hunt_id = ?')
    .get(huntId) as { count: number };
  return row.count;
}

const WILDCARD_KEY = /^<.*>$/;

// criteria_schema convention: a leaf is a type string and is REQUIRED unless it ends with '?'.
// A key wrapped in <...> is a wildcard map (e.g. cars `targets`) whose entries are each
// validated against the template value.
function isOptionalLeaf(typeStr: string): boolean {
  return typeStr.trim().endsWith('?');
}

function isMissingValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

// Strip the optional marker ('?') and array suffix ('[]') to get the base primitive type name.
function baseLeafType(typeStr: string): { base: string; isArray: boolean } {
  let t = typeStr.trim();
  if (t.endsWith('?')) t = t.slice(0, -1).trim();
  let isArray = false;
  if (t.endsWith('[]')) {
    isArray = true;
    t = t.slice(0, -2).trim();
  }
  return { base: t, isArray };
}

// Does a present value match the schema's declared leaf type? Only the primitive/array shapes the
// schema actually uses are enforced; an unrecognised type name is not constrained (don't
// over-validate). Used for REQUIRED leaves so e.g. shared.postcode = 12345 (number where the schema
// says `string`) is rejected at the gate rather than crashing the translator's `.trim()` at search.
function leafValueMatchesType(typeStr: string, value: unknown): boolean {
  const { base, isArray } = baseLeafType(typeStr);
  if (isArray) return Array.isArray(value);
  switch (base) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true; // unknown type name — don't enforce a shape we don't understand
  }
}

function describeLeafType(typeStr: string): string {
  const { base, isArray } = baseLeafType(typeStr);
  return isArray ? `a ${base} array` : `a ${base}`;
}

// Does this schema subtree contain at least one required leaf (recursively, incl. wildcard templates)?
function schemaHasRequiredLeaf(node: unknown): boolean {
  if (typeof node === 'string') return !isOptionalLeaf(node);
  if (node && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).some(schemaHasRequiredLeaf);
  }
  return false;
}

function walkCriteriaSchema(
  schemaNode: Record<string, unknown>,
  criteriaNode: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  for (const [key, schemaVal] of Object.entries(schemaNode)) {
    if (WILDCARD_KEY.test(key)) {
      // criteriaNode is itself a map of arbitrary keys, each validated against schemaVal.
      const entries = Object.entries(criteriaNode);
      if (entries.length === 0) {
        if (schemaHasRequiredLeaf(schemaVal)) {
          errors.push(`${path.replace(/\.$/, '') || 'criteria'} must have at least one entry`);
        }
        continue;
      }
      for (const [actualKey, actualVal] of entries) {
        const childObj =
          actualVal && typeof actualVal === 'object' ? (actualVal as Record<string, unknown>) : {};
        walkCriteriaSchema(schemaVal as Record<string, unknown>, childObj, `${path}${actualKey}.`, errors);
      }
      continue;
    }
    if (typeof schemaVal === 'string') {
      if (!isOptionalLeaf(schemaVal)) {
        const value = criteriaNode[key];
        if (isMissingValue(value)) {
          errors.push(`${path}${key} is required`);
        } else if (!leafValueMatchesType(schemaVal, value)) {
          // Present but wrong-typed (e.g. a number where the schema names `string`). The watcher
          // translator would later trust the declared type and crash, so reject it here.
          errors.push(`${path}${key} must be ${describeLeafType(schemaVal)}`);
        }
      }
      continue;
    }
    if (schemaVal && typeof schemaVal === 'object') {
      const child = criteriaNode[key];
      // Only descend (emitting required-field errors) if the block is present or has required leaves.
      if (child !== undefined || schemaHasRequiredLeaf(schemaVal)) {
        const childObj = child && typeof child === 'object' ? (child as Record<string, unknown>) : {};
        walkCriteriaSchema(schemaVal as Record<string, unknown>, childObj, `${path}${key}.`, errors);
      }
    }
  }
}

// Validate criteria against a vertical's criteria_schema. Returns human-readable problems
// (empty = valid). A vertical with a genuinely empty schema (e.g. computers) imposes no criteria
// checks and passes; a vertical whose config is missing/unparseable FAILS CLOSED (the watcher
// could not safely poll it) rather than silently passing.
export function validateCriteriaForVertical(
  db: Database.Database,
  vertical: string,
  criteria: unknown,
): string[] {
  const cfg = getVerticalConfig(db, vertical);
  if (!cfg.ok) return [cfg.reason];
  const schema = (cfg.config.criteria_schema ?? {}) as Record<string, unknown>;
  const criteriaObj =
    criteria && typeof criteria === 'object' ? (criteria as Record<string, unknown>) : {};
  const errors: string[] = [];
  walkCriteriaSchema(schema, criteriaObj, '', errors);
  return errors;
}

// Collect the schema paths that declare a `<...>` wildcard MAP (e.g. cars `targets`): an object node
// at least one of whose keys is a wildcard. The criteria value at that path is a user-keyed map
// whose keys, by the term-keyed-targets convention, must line up 1:1 with the hunt's search_terms.
function collectWildcardMapPaths(schemaNode: unknown, path: string[], out: string[][]): void {
  if (!schemaNode || typeof schemaNode !== 'object' || Array.isArray(schemaNode)) return;
  const entries = Object.entries(schemaNode as Record<string, unknown>);
  if (entries.some(([k]) => WILDCARD_KEY.test(k))) {
    out.push(path);
    return; // this node IS the map; its wildcard template is validated by walkCriteriaSchema
  }
  for (const [k, v] of entries) {
    collectWildcardMapPaths(v, [...path, k], out);
  }
}

// Resolve a nested object by key path and return its own keys, or null when the path is absent or
// the value there is not a plain object.
function mapKeysAtPath(criteria: Record<string, unknown>, path: string[]): string[] | null {
  let node: unknown = criteria;
  for (const key of path) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    node = (node as Record<string, unknown>)[key];
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  return Object.keys(node as Record<string, unknown>);
}

// The set of `terms` strings a hunt's search_terms declares. Accepts both shapes the system uses:
// ["term", ...] and [{ "terms": "term", ... }, ...]. Returns ok:false when the raw value is present
// but not a JSON array, so the gate can flag that distinctly from "empty".
function parseSearchTermSet(raw: string | null | undefined): { ok: boolean; terms: Set<string> } {
  if (raw === null || raw === undefined || raw.trim() === '') return { ok: true, terms: new Set() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, terms: new Set() };
  }
  if (!Array.isArray(parsed)) return { ok: false, terms: new Set() };
  const terms = new Set<string>();
  for (const el of parsed) {
    if (typeof el === 'string') {
      if (el.trim() !== '') terms.add(el);
    } else if (el && typeof el === 'object') {
      const t = (el as { terms?: unknown }).terms;
      if (typeof t === 'string' && t.trim() !== '') terms.add(t);
    }
  }
  return { ok: true, terms };
}

// Cross-check, for every `<...>` wildcard map the schema declares, that the keys present in the
// hunt's criteria map exactly equal the hunt's search_terms. This catches a hunt whose search_terms
// don't line up with its term-keyed targets — which passes the per-field criteria checks but makes
// the watcher translator throw on EVERY poll (it resolves targets by the exact term string). Driven
// purely off the schema's wildcard-map convention, so any vertical using the pattern is covered and
// verticals without a wildcard map (e.g. computers) are unaffected. An EMPTY map is left to the
// criteria validator ("must have at least one entry"); parity only fires once the map has entries.
function checkSearchTermParity(
  schema: Record<string, unknown>,
  criteria: Record<string, unknown>,
  searchTermsRaw: string | null | undefined,
): string[] {
  const mapPaths: string[][] = [];
  collectWildcardMapPaths(schema, [], mapPaths);
  if (mapPaths.length === 0) return []; // vertical has no term-keyed map — nothing to cross-check
  const errors: string[] = [];
  const parsed = parseSearchTermSet(searchTermsRaw);
  for (const path of mapPaths) {
    const field = path.join('.') || 'criteria';
    const keys = mapKeysAtPath(criteria, path) ?? [];
    if (keys.length === 0) continue; // emptiness is the criteria validator's job, not parity's
    if (!parsed.ok) {
      errors.push(
        `search_terms is not a valid JSON array, but criteria.${field} declares ` +
          `${keys.length} entr${keys.length === 1 ? 'y' : 'ies'} (${keys.map((k) => `"${k}"`).join(', ')}). ` +
          `search_terms must list exactly one entry per criteria.${field} key.`,
      );
      continue;
    }
    const targetsWithoutTerm = keys.filter((k) => !parsed.terms.has(k));
    const termsWithoutTarget = [...parsed.terms].filter((t) => !keys.includes(t));
    if (targetsWithoutTerm.length > 0) {
      errors.push(
        `criteria.${field} ${targetsWithoutTerm.length === 1 ? 'key' : 'keys'} ` +
          `${targetsWithoutTerm.map((k) => `"${k}"`).join(', ')} ` +
          `${targetsWithoutTerm.length === 1 ? 'has' : 'have'} no matching search_term — every ` +
          `criteria.${field} key must appear as a search term (else the watcher translator throws every poll).`,
      );
    }
    if (termsWithoutTarget.length > 0) {
      errors.push(
        `search_term ${termsWithoutTarget.map((t) => `"${t}"`).join(', ')} ` +
          `${termsWithoutTarget.length === 1 ? 'has' : 'have'} no matching criteria.${field} entry — ` +
          `every search term must match a criteria.${field} key.`,
      );
    }
  }
  return errors;
}

// ============================================================================
// Provenance gating (gate_version >= 2)
// ============================================================================
// Legacy hunts (gate_version NULL/absent → resolved to 1) are grandfathered past these checks. The
// strict regime makes the gate verify PROVENANCE, not mere existence: segment prices must derive from
// recorded comps (B), and feature-led hunts must carry a cited spec KB (C) and pass adversarial
// must-have verification (D). All three are driven off DB tables the gate can read.

const MIN_COMPS_PER_SEGMENT = 3;
// Lenient starting threshold for the within-segment dispersion guard: a (max/min) landed-price ratio
// above this is a strong mis-bucketing signal (different trims/packs lumped together). Tune per
// vertical as real data accrues — start lenient so legitimate mileage/condition spread doesn't block.
const SEGMENT_SPREAD_BLOCK_RATIO = 2.5;

// Resolve the hunt's gate version with a guarded re-query (mirrors getVerticalConfig's fail-safe): a
// legacy row (NULL), a DB without the column (older fixtures), or any read error all resolve to 1, so
// the strict B/C/D checks are skipped and existing callers/tests are unaffected.
function getGateVersion(db: Database.Database, huntId: number): number {
  try {
    const row = db.prepare('SELECT gate_version FROM hunts WHERE id = ?').get(huntId) as
      | { gate_version: number | null }
      | undefined;
    return row && typeof row.gate_version === 'number' ? row.gate_version : 1;
  } catch {
    return 1;
  }
}

// A hunt is "feature-led" when its criteria carry non-empty intent.must_have — it is bought by
// feature, so it needs a spec KB (C) and must-have verification (D). Per-hunt (not per-vertical), so
// computers (empty criteria_schema, no must_have) naturally skips C/D while any future vertical that
// adds must_have is covered automatically.
function huntMustHaves(criteria: unknown): string[] {
  if (!criteria || typeof criteria !== 'object') return [];
  const intent = (criteria as Record<string, unknown>).intent;
  if (!intent || typeof intent !== 'object') return [];
  const mh = (intent as Record<string, unknown>).must_have;
  if (!Array.isArray(mh)) return [];
  return mh.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
}

// Candidate target keys for a feature-led hunt: the keys of every `<...>` wildcard map the schema
// declares (e.g. cars `targets`). Reuses the same enumeration the parity check uses, so it stays
// driven off the schema convention rather than hardcoding any vertical.
function enumerateTargetKeys(
  schema: Record<string, unknown>,
  criteria: Record<string, unknown>,
): string[] {
  const mapPaths: string[][] = [];
  collectWildcardMapPaths(schema, [], mapPaths);
  const keys = new Set<string>();
  for (const path of mapPaths) {
    for (const k of mapKeysAtPath(criteria, path) ?? []) keys.add(k);
  }
  return [...keys];
}

interface SegmentRow {
  id: number;
  name: string;
  tags: string;
}
interface CompRow {
  total_landed_gbp: number | null;
  price: number | null;
  tags: string | null;
}

// Does a JSON-array tag string carry at least one real tag? Distinguishes '[]'/''/whitespace from an
// actually-tagged comp — a tagged comp is the signal it was deliberately bucketed by trim/spec.
function hasTags(raw: string | null | undefined): boolean {
  if (!raw || raw.trim() === '' || raw.trim() === '[]') return false;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.some((t) => typeof t === 'string' && t.trim() !== '');
  } catch {
    return raw.trim() !== '';
  }
}

// The strict provenance regime (gate_version >= 2). Returns human-readable failures (empty = passes).
function checkProvenanceGate(
  db: Database.Database,
  hunt: HuntRow,
  criteria: Record<string, unknown>,
  schema: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const mustHaves = huntMustHaves(criteria);
  const featureLed = mustHaves.length > 0;

  const segments = db
    .prepare('SELECT id, name, tags FROM market_segments WHERE hunt_id = ?')
    .all(hunt.id) as SegmentRow[];

  let targetKeys = featureLed ? enumerateTargetKeys(schema, criteria) : [];
  if (featureLed && targetKeys.length === 0) targetKeys = ['_hunt']; // experimental fallback

  const kbRows = featureLed
    ? (db
        .prepare(
          'SELECT target_key, kb_path, must_have_citations FROM knowledge_base WHERE hunt_id = ?',
        )
        .all(hunt.id) as Array<{ target_key: string; kb_path: string; must_have_citations: string }>)
    : [];
  const coveredTargets = new Set(
    kbRows.filter((r) => r.kb_path && r.kb_path.trim() !== '').map((r) => r.target_key),
  );

  // --- B: every segment's price band must derive from sourced, tagged comps (ALL verticals) ---
  for (const seg of segments) {
    const comps = db
      .prepare(
        `SELECT total_landed_gbp, price, tags FROM baseline_prices
         WHERE segment_id = ?
           AND source_url IS NOT NULL AND trim(source_url) != ''
           AND source_item_id IS NOT NULL AND trim(source_item_id) != ''`,
      )
      .all(seg.id) as CompRow[];
    const tagged = comps.filter((c) => hasTags(c.tags));
    if (tagged.length < MIN_COMPS_PER_SEGMENT) {
      errors.push(
        `segment "${seg.name}" has ${tagged.length} sourced+tagged comp(s) — needs ≥${MIN_COMPS_PER_SEGMENT} ` +
          `baseline_prices rows with source_url, source_item_id and trim tags. Record real comps via ` +
          `/price-baselining (segment prices are derived from comps, not typed).`,
      );
      continue;
    }
    if (featureLed) {
      // Dispersion guard: a too-wide spread means the bucket mixes trims/packs.
      const prices = tagged
        .map((c) => c.total_landed_gbp ?? c.price)
        .filter((p): p is number => typeof p === 'number' && p > 0)
        .sort((a, b) => a - b);
      if (prices.length >= 2) {
        const ratio = prices[prices.length - 1] / prices[0];
        if (ratio > SEGMENT_SPREAD_BLOCK_RATIO) {
          errors.push(
            `segment "${seg.name}" price spread is ${ratio.toFixed(1)}× ` +
              `(min £${Math.round(prices[0])}, max £${Math.round(prices[prices.length - 1])}) — ` +
              `likely mixing trims/packs. Split it into tighter, comparable segments.`,
          );
        }
      }
      // KB-anchor: a feature-led segment must map to a researched target (its name references a
      // KB-covered target), so buckets come from the spec research, not invented. Skipped until at
      // least one KB row exists (the C check reports the missing KB instead).
      if (coveredTargets.size > 0) {
        const segName = seg.name.toLowerCase();
        const anchored = [...coveredTargets].some((tk) => segName.includes(tk.toLowerCase()));
        if (!anchored) {
          errors.push(
            `segment "${seg.name}" does not map to any researched target (${[...coveredTargets]
              .map((t) => `"${t}"`)
              .join(', ')}) — name segments after a KB-covered trim/target.`,
          );
        }
      }
    }
  }

  if (!featureLed) return errors;

  // --- C: each target needs a cited KB covering every must-have ---
  const kbByTarget = new Map(kbRows.map((r) => [r.target_key, r]));
  for (const tk of targetKeys) {
    const kb = kbByTarget.get(tk);
    if (!kb || !kb.kb_path || kb.kb_path.trim() === '') {
      errors.push(
        `target "${tk}" has no spec knowledge base — run /car-spec-research and record_kb_coverage before activating.`,
      );
      continue;
    }
    let citations: Record<string, unknown> = {};
    try {
      citations = JSON.parse(kb.must_have_citations || '{}') as Record<string, unknown>;
    } catch {
      citations = {};
    }
    for (const mh of mustHaves) {
      const n = citations[mh];
      if (!(typeof n === 'number' && n >= 1)) {
        errors.push(
          `target "${tk}" knowledge base has no cited source for must-have "${mh}" — research and cite it.`,
        );
      }
    }
  }

  // --- D: every (target, must-have) must be independently verified ---
  const verRows = db
    .prepare('SELECT target_key, feature, verdict FROM claim_verifications WHERE hunt_id = ?')
    .all(hunt.id) as Array<{ target_key: string; feature: string; verdict: string }>;
  const verdictByKey = new Map(
    verRows.map((r) => [JSON.stringify([r.target_key, r.feature]), r.verdict]),
  );
  for (const tk of targetKeys) {
    for (const mh of mustHaves) {
      const verdict = verdictByKey.get(JSON.stringify([tk, mh]));
      if (verdict !== 'verified') {
        errors.push(
          `must-have "${mh}" for target "${tk}" is ${verdict ?? 'unverified (no record)'} — run the ` +
            `musthave-verification sub-agent (or waive_must_have with a reason) before activating.`,
        );
      }
    }
  }

  return errors;
}

// Evaluate the draft→active gate for a hunt row. Returns all failures (empty = ready to activate).
export function evaluateActivationGate(
  db: Database.Database,
  hunt: HuntRow,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  let criteria: unknown = {};
  try {
    criteria = JSON.parse(hunt.criteria || '{}');
  } catch {
    errors.push('criteria is not valid JSON');
  }
  const vertical = hunt.vertical || 'computers';
  errors.push(...validateCriteriaForVertical(db, vertical, criteria));
  // Term/target parity: only meaningful when the vertical config is readable AND criteria is an
  // object. Skipped silently otherwise (those cases are already reported by the checks above).
  const cfg = getVerticalConfig(db, vertical);
  if (cfg.ok && criteria && typeof criteria === 'object' && !Array.isArray(criteria)) {
    const schema = (cfg.config.criteria_schema ?? {}) as Record<string, unknown>;
    errors.push(
      ...checkSearchTermParity(schema, criteria as Record<string, unknown>, hunt.search_terms),
    );
  }
  if (getSegmentCount(db, hunt.id) === 0) {
    errors.push('0 market segments recorded — run /price-baselining to record at least one segment');
  }
  // Strict provenance regime for gate_version >= 2 hunts (legacy hunts grandfathered). Guarded the
  // same way as the parity check: only runs when the vertical config is readable and criteria is an
  // object — and only queries the v2 tables (knowledge_base/claim_verifications) behind that gate,
  // so legacy hunts and column-less fixtures never touch them.
  if (
    getGateVersion(db, hunt.id) >= 2 &&
    cfg.ok &&
    criteria &&
    typeof criteria === 'object' &&
    !Array.isArray(criteria)
  ) {
    const schema = (cfg.config.criteria_schema ?? {}) as Record<string, unknown>;
    errors.push(...checkProvenanceGate(db, hunt, criteria as Record<string, unknown>, schema));
  }
  return { ok: errors.length === 0, errors };
}
