/**
 * Deal Hunter DB Tool Server (MCP)
 *
 * SQLite-backed MCP server for structured deal-hunting operations.
 * Provides the agent with hunt management, offer tracking, price history,
 * evaluations, and alert operations.
 *
 * DB file persists in the group folder at /workspace/group/deal-hunter.db
 * (also accessible by the host for the future watcher service).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import {
  evaluateActivationGate,
  validateCriteriaForVertical,
  enumerateHuntTargetKeys,
  huntMustHaves,
  huntNiceToHaves,
  type HuntRow,
} from './deal-hunter-gate.js';

// --- DB Initialization ---
// Schema is owned by the watcher service. This MCP server only reads/writes.

const DB_PATH =
  process.env.DEAL_HUNTER_DB_PATH || '/workspace/group/deal-hunter.db';
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Verify the watcher has created the schema
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((r) => (r as { name: string }).name);
if (!tables.includes('hunts')) {
  console.error('deal-hunter.db has no schema. The watcher service must be running to create it.');
  process.exit(1);
}

// --- Helpers ---

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

// Resolve a hunt's gate_version (provenance regime). NULL/absent/legacy → 1; v2+ hunts must have
// their segment prices DERIVED from recorded comps rather than typed by the agent.
function huntGateVersion(huntId: number): number {
  try {
    const row = db.prepare('SELECT gate_version FROM hunts WHERE id = ?').get(huntId) as
      | { gate_version: number | null }
      | undefined;
    return row && typeof row.gate_version === 'number' ? row.gate_version : 1;
  } catch {
    return 1;
  }
}

// Validate a `target_key` argument against the hunt's enumerated criteria target keys — the SAME
// enumeration the activation gate anchors on (enumerateHuntTargetKeys, from the gate module). This
// blocks alias rows (e.g. target_key "EV6" when the criteria key is "Kia EV6"): the gate matches
// target keys as exact strings, so an alias KB/verification row satisfies nothing it checks yet can
// make segments look anchored. Returns an error message (write must be refused) or null when valid.
function validateTargetKeyForHunt(huntId: number, targetKey: string): string | null {
  const res = enumerateHuntTargetKeys(db, huntId);
  if (!res.ok) return `Cannot validate target_key: ${res.reason}`;
  if (res.keys.length === 0) {
    // Experimental fallback: a hunt whose criteria declare no target keys is gated under the
    // synthetic "_hunt" key — that is the only acceptable target_key for it.
    return targetKey === '_hunt'
      ? null
      : `Invalid target_key "${targetKey}": hunt ${huntId}'s criteria declare no target keys, so the only valid target_key is "_hunt". Pass target_key "_hunt" verbatim.`;
  }
  if (res.keys.includes(targetKey)) return null;
  return (
    `Invalid target_key "${targetKey}" for hunt ${huntId}. The activation gate matches target keys ` +
    `exactly, so this row would never satisfy it. Valid target keys for this hunt are: ` +
    `${res.keys.map((k) => `"${k}"`).join(', ')}. Pass one of these verbatim (the full criteria key, ` +
    `e.g. "Kia EV6" — not a shortened alias like "EV6").`
  );
}

// --- Per-offer requirement checks (record_evaluation) ---

interface RequirementCheckInput {
  requirement: string;
  verdict: 'verified' | 'unverified' | 'contradicted';
  evidence: string;
}

type RequirementCheckStored = RequirementCheckInput & { tier: 'must' | 'nice' };

// Validate record_evaluation's requirement_checks against the hunt's criteria and enforce the
// alert gate. Mirrors validateTargetKeyForHunt's exact-string discipline: a check is counted by
// verbatim match against intent.must_have / intent.nice_to_have, so a paraphrase satisfies
// nothing. Enforcement applies only to feature-led hunts (non-empty must_have) — legacy hunts
// with no intent zone are unaffected. Returns an error string (write must be refused) or the
// normalized checks (tier derived) ready to persist.
function validateRequirementChecks(
  huntId: number,
  decision: 'alert' | 'skip' | 'watch',
  checks: RequirementCheckInput[] | undefined,
): { error: string } | { normalized: RequirementCheckStored[] | null } {
  const hunt = db.prepare('SELECT criteria FROM hunts WHERE id = ?').get(huntId) as
    | { criteria: string | null }
    | undefined;
  if (!hunt) return { error: `Hunt not found: ${huntId}` };

  let criteria: unknown = null;
  try {
    criteria = hunt.criteria ? JSON.parse(hunt.criteria) : null;
  } catch {
    // Unparseable criteria: treat as not feature-led (matches the gate's grandfathering) —
    // but refuse checks we cannot anchor to anything.
    if (checks && checks.length > 0) {
      return {
        error: `Hunt ${huntId}'s criteria is not valid JSON — requirement_checks cannot be validated against it. Fix the criteria via manage_hunt first.`,
      };
    }
    return { normalized: null };
  }

  const must = huntMustHaves(criteria);
  const nice = huntNiceToHaves(criteria);

  const normalized: RequirementCheckStored[] = [];
  const seen = new Set<string>();
  for (const check of checks ?? []) {
    if (seen.has(check.requirement)) {
      return { error: `Duplicate requirement_check for "${check.requirement}" — pass one check per requirement.` };
    }
    seen.add(check.requirement);
    if (must.includes(check.requirement)) {
      normalized.push({ ...check, tier: 'must' });
    } else if (nice.includes(check.requirement)) {
      normalized.push({ ...check, tier: 'nice' });
    } else {
      const valid = [...must, ...nice];
      return {
        error:
          `Invalid requirement "${check.requirement}" for hunt ${huntId}. Per-offer checks are counted by ` +
          `exact string match against the hunt's criteria.intent.must_have / nice_to_have, so a paraphrase ` +
          `satisfies nothing. ` +
          (valid.length > 0
            ? `Valid requirements: ${valid.map((s) => `"${s}"`).join(', ')}. Pass one of these verbatim.`
            : `This hunt declares no intent.must_have / nice_to_have entries — omit requirement_checks. ` +
              `(If this hunt predates the intent.must_have convention, update its criteria via manage_hunt first.)`),
      };
    }
  }

  // Alert gate — feature-led hunts only.
  if (decision === 'alert' && must.length > 0) {
    const covered = new Set(normalized.filter((c) => c.tier === 'must').map((c) => c.requirement));
    const missing = must.filter((m) => !covered.has(m));
    if (missing.length > 0) {
      return {
        error:
          `decision "alert" requires a requirement_check for every must_have entry. Missing: ` +
          `${missing.map((s) => `"${s}"`).join(', ')}. Verify each against this listing's evidence and ` +
          `record verified/unverified/contradicted — or record watch/skip instead.`,
      };
    }
    const contradicted = normalized.find((c) => c.tier === 'must' && c.verdict === 'contradicted');
    if (contradicted) {
      return {
        error:
          `Cannot alert: must-have "${contradicted.requirement}" is contradicted by the listing evidence ` +
          `("${contradicted.evidence}"). A failed hard requirement is a skip (or a watch, if the evidence ` +
          `itself is doubtful) — not an alert.`,
      };
    }
  }

  return { normalized: normalized.length > 0 ? normalized : null };
}

// p25 / median / p75 of a numeric sample (linear interpolation), or null for an empty sample.
// Used to DERIVE a segment's price band from its sourced comps so the band can't be hallucinated.
function percentiles(values: number[]): { low: number; mid: number; high: number } | null {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const at = (p: number): number => {
    if (xs.length === 1) return xs[0];
    const idx = p * (xs.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return xs[lo];
    return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
  };
  return { low: at(0.25), mid: at(0.5), high: at(0.75) };
}

// Vertical capabilities are mirrored from config/verticals.yml into the `verticals` table
// by the watcher at startup (verticals.yml is not mounted in-container). These helpers read
// that table so the agent resolves vertical config at runtime instead of hardcoding it.
const hasVerticalsTable = tables.includes('verticals');

function getVerticalConfig(name: string): Record<string, unknown> | null {
  if (!hasVerticalsTable) return null;
  const row = db.prepare('SELECT config_json FROM verticals WHERE name = ?').get(name) as
    | { config_json: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.config_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listVerticalConfigs(): Array<Record<string, unknown>> {
  if (!hasVerticalsTable) return [];
  const rows = db.prepare('SELECT config_json FROM verticals ORDER BY name').all() as Array<{
    config_json: string;
  }>;
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.config_json) as Record<string, unknown>);
    } catch {
      // skip malformed rows
    }
  }
  return out;
}

// Default source list per vertical, resolved from the verticals table. Falls back to ['ebay']
// when the vertical is unknown or the table hasn't been populated yet.
function defaultSourcesForVertical(vertical: string): string[] {
  const cfg = getVerticalConfig(vertical);
  const sources = cfg?.sources;
  if (Array.isArray(sources) && sources.length > 0) return sources.map(String);
  return ['ebay'];
}

function parseSourcesJson(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// Whether a hunt searches eBay — used to gate eBay-only guidance (e.g. category_ids).
function huntUsesEbay(hunt: { vertical?: string | null; sources?: string | null }): boolean {
  const sources = parseSourcesJson(hunt.sources);
  if (sources.length > 0) return sources.includes('ebay');
  // No sources recorded (legacy hunt) — fall back to the vertical (default 'computers' = eBay).
  return (hunt.vertical ?? 'computers') === 'computers';
}

// --- MCP Server ---

const server = new McpServer({
  name: 'deal-hunter-db',
  version: '1.0.0',
});

// ============================================================
// Tool: list_verticals — discover available verticals + their capabilities
// ============================================================
server.tool(
  'list_verticals',
  "List the available hunt verticals (categories of thing being hunted, e.g. 'computers', 'cars') and the capabilities of each: which data sources it searches, the criteria fields it accepts, and the names of the skills that handle its market research and its listing evaluation. Call this to find out which verticals exist before creating or working a hunt.",
  {},
  async () => {
    const verticals = listVerticalConfigs();
    if (verticals.length === 0) {
      return jsonResult({
        verticals: [],
        note: 'No verticals recorded yet — the watcher populates this table at startup from config/verticals.yml.',
      });
    }
    return jsonResult({ verticals });
  },
);

// ============================================================
// Tool: get_vertical — resolve one vertical's capabilities
// ============================================================
server.tool(
  'get_vertical',
  "Look up one vertical's configuration by name. Returns: `sources` (the data sources to search for this vertical), `criteria_schema` (the criteria fields a hunt in this vertical accepts), `recon_tool` (the search tool to use for market reconnaissance), `knowledge_base_path` (file-path pattern for this vertical's reference knowledge), `sourcing_skill` (the skill describing how to research market prices for it), and `evaluator_skill` (the skill describing how to evaluate its listings). Call this when working a hunt to find the correct source, criteria, and skills for that hunt's vertical.",
  { name: z.string().describe("Vertical name, e.g. 'computers' or 'cars'") },
  async ({ name }) => {
    const cfg = getVerticalConfig(name);
    if (!cfg) {
      const known = listVerticalConfigs().map((v) => v.name);
      return errorResult(
        `Unknown vertical '${name}'. Known: ${known.length ? known.join(', ') : '(none recorded — is the watcher running?)'}`,
      );
    }
    return jsonResult(cfg);
  },
);

// ============================================================
// Tool 1: manage_hunt
// ============================================================
server.tool(
  'manage_hunt',
  "Manage a hunt's lifecycle. Lifecycle: create → (baseline) → activate → pause/resume → close. " +
    "`create` always makes a DRAFT hunt that is NOT monitored — record market segments via /price-baselining, then call `activate`. " +
    '`activate` is the gate: it refuses unless the criteria are valid for the vertical AND at least one market segment exists, then enables monitoring. ' +
    '`update` edits a hunt but cannot turn monitoring on (use `activate`). `resume` re-runs the gate. ' +
    '`close` cascades: dismisses hunt_offers and clears watches on associated offers.',
  {
    action: z.enum(['create', 'update', 'pause', 'resume', 'close', 'activate']),
    hunt_id: z.number().optional().describe('Required for update/pause/resume/close'),
    name: z.string().optional().describe('Hunt name (required for create)'),
    criteria: z.string().optional().describe('JSON string of criteria object'),
    search_terms: z.string().optional().describe('JSON string of search terms. Simple format: ["term1", "term2"]. Per-term categories: [{"terms": "term1", "category_ids": "1244"}, {"terms": "term2"}]. Per-term category_ids override hunt-level category_ids.'),
    cadence_minutes: z.number().optional(),
    monitoring: z.boolean().optional().describe('Only `false` is honoured here, to stop monitoring an active hunt via update. To START monitoring, use action:activate (it checks criteria + segments). Ignored on create — new hunts are always draft (unmonitored).'),
    category_ids: z.string().optional().describe('Comma-separated eBay category IDs to filter watcher searches (e.g. "179" for PC Desktops). Acts as the default for all search terms. Individual terms can override via per-term category_ids in search_terms. eBay-only.'),
    vertical: z.string().optional().describe("Vertical for this hunt, e.g. 'computers' (eBay) or 'cars' (AutoTrader). Defaults to 'computers' on create. Determines which evaluator/source the watcher uses."),
    sources: z.array(z.string()).optional().describe("Source adapters to poll, e.g. ['ebay'] or ['autotrader']. Defaults from the vertical when omitted on create."),
    poll_interval_minutes: z.number().optional().describe('Override the watcher poll interval (minutes). Omit to let the watcher derive cadence from the vertical policy.'),
    close_reason: z.string().optional().describe('Reason for closing (bought, changed_mind, etc.)'),
  },
  async ({ action, hunt_id, name, criteria, search_terms, cadence_minutes, monitoring, category_ids, vertical, sources, poll_interval_minutes, close_reason }) => {
    if (action === 'create') {
      if (!name) return errorResult('name is required for create');
      const huntVertical = vertical || 'computers';
      const huntSources = sources && sources.length > 0
        ? sources
        : defaultSourcesForVertical(huntVertical);
      // New hunts are always created as a DRAFT and never monitored. Monitoring is only enabled
      // by action:activate, which gates on valid criteria + at least one market segment.
      // gate_version 2 = the strict provenance regime (B/C/D). Every newly-created hunt is stamped
      // v2; pre-existing hunts keep gate_version NULL and are grandfathered by the activation gate.
      const result = db.prepare(`
        INSERT INTO hunts (name, status, criteria, search_terms, cadence_minutes, monitoring, category_ids, vertical, sources, poll_interval_minutes, gate_version)
        VALUES (?, 'draft', ?, ?, ?, 0, ?, ?, ?, ?, 2)
      `).run(
        name,
        criteria || '{}',
        search_terms || '[]',
        cadence_minutes || 60,
        category_ids || null,
        huntVertical,
        JSON.stringify(huntSources),
        poll_interval_minutes ?? null,
      );
      const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(result.lastInsertRowid);
      // Surface criteria problems now (non-blocking — criteria can be refined before activation).
      let criteria_warnings: string[] = [];
      try {
        criteria_warnings = validateCriteriaForVertical(db, huntVertical, JSON.parse(criteria || '{}'));
      } catch {
        criteria_warnings = ['criteria is not valid JSON'];
      }
      return jsonResult({
        action: 'created',
        hunt,
        criteria_warnings,
        next_step:
          'Hunt created as DRAFT (not monitored). Record market segments via /price-baselining, ' +
          'then call manage_hunt action:activate to start monitoring.',
      });
    }

    if (!hunt_id) return errorResult('hunt_id is required for ' + action);
    const existing = db.prepare('SELECT * FROM hunts WHERE id = ?').get(hunt_id) as HuntRow | undefined;
    if (!existing) return errorResult('Hunt not found: ' + hunt_id);

    if (action === 'activate' || action === 'resume') {
      const gate = evaluateActivationGate(db, existing);
      if (!gate.ok) {
        return errorResult(
          `Cannot ${action} hunt ${hunt_id} — activation gate not satisfied:\n- ${gate.errors.join('\n- ')}\n\n` +
            'Fix the criteria (manage_hunt action:update) and/or record market segments (/price-baselining), then try again.',
        );
      }
      db.prepare("UPDATE hunts SET status = 'active', monitoring = 1 WHERE id = ?").run(hunt_id);
    } else if (action === 'update') {
      if (monitoring === true) {
        return errorResult(
          'Cannot enable monitoring via update — use action:activate, which verifies the hunt has ' +
            'valid criteria and at least one market segment.',
        );
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined) { sets.push('name = ?'); params.push(name); }
      if (criteria !== undefined) { sets.push('criteria = ?'); params.push(criteria); }
      if (search_terms !== undefined) { sets.push('search_terms = ?'); params.push(search_terms); }
      if (cadence_minutes !== undefined) { sets.push('cadence_minutes = ?'); params.push(cadence_minutes); }
      if (monitoring === false) { sets.push('monitoring = ?'); params.push(0); }
      if (category_ids !== undefined) { sets.push('category_ids = ?'); params.push(category_ids || null); }
      if (vertical !== undefined) { sets.push('vertical = ?'); params.push(vertical); }
      if (sources !== undefined) { sets.push('sources = ?'); params.push(JSON.stringify(sources)); }
      if (poll_interval_minutes !== undefined) { sets.push('poll_interval_minutes = ?'); params.push(poll_interval_minutes); }
      if (sets.length === 0) return errorResult('Nothing to update');
      params.push(hunt_id);
      db.prepare(`UPDATE hunts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    } else if (action === 'pause') {
      db.prepare("UPDATE hunts SET status = 'paused', monitoring = 0 WHERE id = ?").run(hunt_id);
    } else if (action === 'close') {
      const closeHunt = db.transaction(() => {
        db.prepare(
          "UPDATE hunts SET status = 'closed', closed_at = datetime('now'), close_reason = ? WHERE id = ?",
        ).run(close_reason || null, hunt_id);
        // Dismiss all non-dismissed hunt_offers
        db.prepare(
          "UPDATE hunt_offers SET status = 'dismissed' WHERE hunt_id = ? AND status != 'dismissed'",
        ).run(hunt_id);
        // Clear watches on offers that were watched for this hunt
        db.prepare(`
          UPDATE offers SET watching = 0, watch_conditions = NULL
          WHERE id IN (
            SELECT offer_id FROM hunt_offers WHERE hunt_id = ?
          ) AND watching = 1
        `).run(hunt_id);
      });
      closeHunt();
    }

    const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(hunt_id);
    return jsonResult({ action, hunt });
  },
);

// ============================================================
// Tool 2: get_hunt
// ============================================================
server.tool(
  'get_hunt',
  'Get a single hunt with detail, or list all active hunts with summary counts. Omit hunt_id to list all active hunts.',
  {
    hunt_id: z.number().optional(),
    include_closed: z.boolean().optional().describe('Include closed hunts in list mode'),
  },
  async ({ hunt_id, include_closed }) => {
    if (hunt_id) {
      const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(hunt_id);
      if (!hunt) return errorResult('Hunt not found: ' + hunt_id);
      const counts = db.prepare(`
        SELECT status, COUNT(*) as count FROM hunt_offers WHERE hunt_id = ? GROUP BY status
      `).all(hunt_id);
      const lastSearch = db.prepare(`
        SELECT * FROM search_queries WHERE hunt_id = ? ORDER BY searched_at DESC LIMIT 1
      `).get(hunt_id);
      return jsonResult({ hunt, offer_counts: counts, last_search: lastSearch });
    }

    const whereClause = include_closed ? '' : "WHERE status != 'closed'";
    const hunts = db.prepare(`SELECT * FROM hunts ${whereClause} ORDER BY created_at DESC`).all();
    const result = hunts.map((h: any) => {
      const counts = db.prepare(
        'SELECT status, COUNT(*) as count FROM hunt_offers WHERE hunt_id = ? GROUP BY status',
      ).all(h.id);
      return { ...h, offer_counts: counts };
    });
    return jsonResult({ hunts: result });
  },
);

// ============================================================
// Tool 3: get_hunt_summary
// ============================================================
server.tool(
  'get_hunt_summary',
  'Orientation summary for a hunt: hunt config, offer counts, watched-offer headlines, recent price/status changes, market segments, and health warnings. Slim by design (progressive disclosure): watched offers exclude bulky attributes/specs — call get_offer(offer_id) for full detail on one offer; oversized criteria is truncated — call get_hunt(hunt_id) for the full config. Pass `since` (ISO timestamp) to filter to changes after that time — useful for event-driven and daily review runs. Omit for full summary.',
  {
    hunt_id: z.number(),
    since: z.string().optional().describe('ISO timestamp — only return changes after this time. Omit for full summary.'),
  },
  async ({ hunt_id, since }) => {
    // Explicit columns, not SELECT * — this tool is an orientation summary, and hunt rows can
    // carry multi-KB criteria/search_terms JSON. Oversized criteria is truncated with a pointer
    // to get_hunt (never hidden, just deferred).
    const hunt = db.prepare(`
      SELECT id, name, status, monitoring, vertical, sources, criteria, search_terms,
        cadence_minutes, poll_interval_minutes, category_ids, gate_version,
        created_at, last_reviewed_at
      FROM hunts WHERE id = ?
    `).get(hunt_id) as any;
    if (!hunt) return errorResult('Hunt not found: ' + hunt_id);

    const CRITERIA_CAP_CHARS = 4096;
    if (typeof hunt.criteria === 'string' && hunt.criteria.length > CRITERIA_CAP_CHARS) {
      // intent (must_have / reject / notes_by_model) is the evaluator's yardstick and sits LAST
      // in the criteria JSON, so a naive prefix cut drops exactly the part evaluation depends on.
      // Rebuild with intent kept whole (soft cap), then fill remaining keys in original order.
      let rebuilt: string | null = null;
      let omitted: string[] = [];
      try {
        const parsed = JSON.parse(hunt.criteria);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const kept: Record<string, unknown> = {};
          if ('intent' in parsed) kept.intent = parsed.intent;
          for (const key of Object.keys(parsed)) {
            if (key === 'intent') continue;
            const candidate = { ...kept, [key]: parsed[key] };
            if (JSON.stringify(candidate).length <= CRITERIA_CAP_CHARS) {
              kept[key] = parsed[key];
            } else {
              omitted.push(key);
            }
          }
          rebuilt = JSON.stringify(kept);
        }
      } catch {
        // Not valid JSON — fall through to the prefix slice
      }
      if (rebuilt !== null) {
        hunt.criteria = rebuilt;
        hunt.criteria_truncated = omitted.length > 0
          ? `criteria over ${CRITERIA_CAP_CHARS} chars — intent kept in full; omitted keys: ${omitted.join(', ')}. Call get_hunt(${hunt_id}) for the full criteria`
          : `criteria over ${CRITERIA_CAP_CHARS} chars — reordered with intent first, nothing omitted`;
      } else {
        hunt.criteria = hunt.criteria.slice(0, CRITERIA_CAP_CHARS);
        hunt.criteria_truncated = `criteria (not valid JSON) truncated at ${CRITERIA_CAP_CHARS} chars — call get_hunt(${hunt_id}) for the full criteria`;
      }
    }

    const newOffers = since
      ? db.prepare(`SELECT COUNT(*) as count FROM hunt_offers WHERE hunt_id = ? AND status = 'new' AND first_associated_at > ?`).get(hunt_id, since) as any
      : db.prepare(`SELECT COUNT(*) as count FROM hunt_offers WHERE hunt_id = ? AND status = 'new'`).get(hunt_id) as any;

    // Headline columns only — attributes/specs_extracted are the payload-bloat fields
    // (multi-KB JSON per offer). Full detail per offer stays one call away via get_offer.
    const watchedOffers = db.prepare(`
      SELECT o.id, o.title, o.source, o.source_id, o.url, o.status, o.condition,
        o.buying_format, o.auction_end_time, o.bid_count, o.watch_conditions,
        ho.status as hunt_offer_status,
        (SELECT p.total_landed_gbp FROM prices p WHERE p.offer_id = o.id ORDER BY p.observed_at DESC LIMIT 1) as latest_price_gbp
      FROM offers o
      JOIN hunt_offers ho ON ho.offer_id = o.id
      WHERE ho.hunt_id = ? AND o.watching = 1
      ORDER BY o.auction_end_time IS NULL, o.auction_end_time ASC
      LIMIT 20
    `).all(hunt_id);

    const priceTimeFilter = since ? '?' : "datetime('now', '-7 days')";
    const priceParams = since ? [hunt_id, since] : [hunt_id];
    const recentPriceChanges = db.prepare(`
      SELECT o.id, o.title, o.source, o.source_id,
        p1.total_landed_gbp as current_price,
        p2.total_landed_gbp as previous_price,
        p1.observed_at as current_observed,
        p2.observed_at as previous_observed
      FROM offers o
      JOIN hunt_offers ho ON ho.offer_id = o.id
      JOIN prices p1 ON p1.offer_id = o.id
      LEFT JOIN prices p2 ON p2.offer_id = o.id AND p2.observed_at < p1.observed_at
      WHERE ho.hunt_id = ?
        AND p1.observed_at = (SELECT MAX(observed_at) FROM prices WHERE offer_id = o.id)
        AND p2.observed_at = (SELECT MAX(observed_at) FROM prices WHERE offer_id = o.id AND observed_at < p1.observed_at)
        AND p1.total_landed_gbp != p2.total_landed_gbp
        AND p1.observed_at > ${priceTimeFilter}
      ORDER BY p1.observed_at DESC
      LIMIT 20
    `).all(...priceParams);

    // Status changes — offers that ended, were removed, or sold since the given time
    const statusChanges = since
      ? db.prepare(`
          SELECT o.id, o.title, o.source_id, o.status, o.last_status_change,
            ho.status as hunt_offer_status
          FROM offers o
          JOIN hunt_offers ho ON ho.offer_id = o.id
          WHERE ho.hunt_id = ? AND o.last_status_change > ?
          ORDER BY o.last_status_change DESC
        `).all(hunt_id, since)
      : [];

    const recentSearches = db.prepare(`
      SELECT * FROM search_queries WHERE hunt_id = ? ORDER BY searched_at DESC LIMIT 5
    `).all(hunt_id);

    const recentFeedback = db.prepare(`
      SELECT a.*, o.title as offer_title
      FROM alerts a
      JOIN offers o ON o.id = a.offer_id
      WHERE a.hunt_id = ? AND a.user_response IS NOT NULL
      ORDER BY a.responded_at DESC LIMIT 5
    `).all(hunt_id);

    const offerCounts = db.prepare(`
      SELECT status, COUNT(*) as count FROM hunt_offers WHERE hunt_id = ? GROUP BY status
    `).all(hunt_id);

    // Health warnings — surface issues the agent should address
    const healthWarnings: string[] = [];

    const segmentCount = (db.prepare(
      'SELECT COUNT(*) as count FROM market_segments WHERE hunt_id = ?',
    ).get(hunt_id) as any).count;

    if (segmentCount === 0) {
      healthWarnings.push(
        '⚠️ NO MARKET SEGMENTS — this hunt has no baseline data. The dashboard "vs Base" column is broken and your evaluations are not grounded in market data. Run /price-baselining to create market segments and record baseline prices before evaluating offers.',
      );
    } else {
      const latestBaseline = db.prepare(
        'SELECT MAX(bp.observed_at) as latest FROM baseline_prices bp JOIN market_segments ms ON ms.id = bp.segment_id WHERE ms.hunt_id = ?',
      ).get(hunt_id) as any;
      if (latestBaseline?.latest) {
        const ageMs = Date.now() - new Date(latestBaseline.latest + 'Z').getTime();
        const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        if (ageDays > 14) {
          healthWarnings.push(
            `⚠️ STALE BASELINE — last baseline data is ${ageDays} days old. Consider refreshing with /price-baselining.`,
          );
        }
      }
    }

    // category_ids is an eBay-only concept — don't warn for cars/AutoTrader (or other non-eBay) hunts.
    if (!(hunt as any).category_ids && huntUsesEbay(hunt as any)) {
      healthWarnings.push(
        '⚠️ NO CATEGORY FILTER — this hunt has no category_ids set. Watcher searches may return noise (accessories, parts, unrelated items). Set category_ids based on relevant eBay categories.',
      );
    }

    const marketSegments = db.prepare(
      'SELECT id, name, tags, price_low, price_mid, price_high, confidence FROM market_segments WHERE hunt_id = ?',
    ).all(hunt_id);

    return jsonResult({
      hunt,
      new_offer_count: (newOffers as any).count,
      watched_offers: watchedOffers,
      watched_offers_note: 'headline fields only (max 20, soonest-ending first) — call get_offer(offer_id) for full detail incl. attributes/specs',
      recent_price_changes: recentPriceChanges,
      status_changes: statusChanges,
      recent_searches: recentSearches,
      recent_feedback: recentFeedback,
      offer_counts: offerCounts,
      market_segments: marketSegments,
      health_warnings: healthWarnings,
    });
  },
);

// ============================================================
// Tool 4: mark_hunt_reviewed
// ============================================================
server.tool(
  'mark_hunt_reviewed',
  'Mark a hunt as reviewed (updates last_reviewed_at). Call at the end of each daily review.',
  {
    hunt_id: z.number(),
  },
  async ({ hunt_id }) => {
    const existing = db.prepare('SELECT id FROM hunts WHERE id = ?').get(hunt_id);
    if (!existing) return errorResult('Hunt not found: ' + hunt_id);
    db.prepare("UPDATE hunts SET last_reviewed_at = datetime('now') WHERE id = ?").run(hunt_id);
    const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(hunt_id);
    return jsonResult({ hunt });
  },
);

// ============================================================
// Tool 5: get_market_overview
// ============================================================
server.tool(
  'get_market_overview',
  'Price aggregates and trends for offers associated with a hunt or filtered by source/condition. Returns median, min, max, volume, and trend.',
  {
    hunt_id: z.number().optional(),
    source: z.string().optional(),
    condition: z.string().optional(),
    days: z.number().optional().describe('Lookback period in days (default 30)'),
  },
  async ({ hunt_id, source, condition, days }) => {
    const lookback = days || 30;
    const conditions: string[] = [`p.observed_at > datetime('now', '-${lookback} days')`];
    const params: unknown[] = [];

    if (hunt_id) {
      conditions.push('ho.hunt_id = ?');
      params.push(hunt_id);
    }
    if (source) {
      conditions.push('o.source = ?');
      params.push(source);
    }
    if (condition) {
      conditions.push('o.condition = ?');
      params.push(condition);
    }

    const joinHuntOffers = hunt_id ? 'JOIN hunt_offers ho ON ho.offer_id = o.id' : '';
    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const stats = db.prepare(`
      SELECT
        COUNT(DISTINCT o.id) as offer_count,
        COUNT(p.id) as observation_count,
        MIN(p.total_landed_gbp) as min_price,
        MAX(p.total_landed_gbp) as max_price,
        AVG(p.total_landed_gbp) as avg_price
      FROM prices p
      JOIN offers o ON o.id = p.offer_id
      ${joinHuntOffers}
      ${whereClause}
      AND p.total_landed_gbp IS NOT NULL
    `).get(...params);

    // Median calculation
    const allPrices = db.prepare(`
      SELECT p.total_landed_gbp as price
      FROM prices p
      JOIN offers o ON o.id = p.offer_id
      ${joinHuntOffers}
      ${whereClause}
      AND p.total_landed_gbp IS NOT NULL
      ORDER BY p.total_landed_gbp
    `).all(...params) as any[];

    let median = null;
    if (allPrices.length > 0) {
      const mid = Math.floor(allPrices.length / 2);
      median = allPrices.length % 2 !== 0
        ? allPrices[mid].price
        : (allPrices[mid - 1].price + allPrices[mid].price) / 2;
    }

    // Trend: compare first half vs second half average
    let trend = 'insufficient_data';
    if (allPrices.length >= 4) {
      const half = Math.floor(allPrices.length / 2);
      // Re-query ordered by time for trend analysis
      const byTime = db.prepare(`
        SELECT p.total_landed_gbp as price
        FROM prices p
        JOIN offers o ON o.id = p.offer_id
        ${joinHuntOffers}
        ${whereClause}
        AND p.total_landed_gbp IS NOT NULL
        ORDER BY p.observed_at
      `).all(...params) as any[];

      const firstHalf = byTime.slice(0, half);
      const secondHalf = byTime.slice(half);
      const avgFirst = firstHalf.reduce((s: number, r: any) => s + r.price, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s: number, r: any) => s + r.price, 0) / secondHalf.length;
      const changePct = ((avgSecond - avgFirst) / avgFirst) * 100;

      if (changePct > 5) trend = 'rising';
      else if (changePct < -5) trend = 'falling';
      else trend = 'stable';
    }

    return jsonResult({
      period_days: lookback,
      stats,
      median_price: median,
      trend,
    });
  },
);

// ============================================================
// Tool 6: record_offer
// ============================================================
server.tool(
  'record_offer',
  'Upsert an offer (by source + source_id). Optionally record a price observation and associate with a hunt — all in one call.',
  {
    source: z.string(),
    source_id: z.string(),
    title: z.string(),
    url: z.string().optional(),
    seller: z.string().optional(),
    seller_rating: z.number().optional(),
    condition: z.string().optional(),
    specs_extracted: z.string().optional().describe('JSON string'),
    attributes: z.record(z.string(), z.unknown()).optional().describe('Structured source attributes object (stored as JSON). For cars: subTitle, attentionGrabber, year, distance_miles, price_tier, etc. — these power list_offers triage columns.'),
    vertical: z.string().optional().describe("Vertical this offer belongs to, e.g. 'computers' or 'cars'. Sets offers.vertical."),
    buying_format: z.string().optional(),
    auction_end_time: z.string().optional(),
    bid_count: z.number().optional(),
    price: z.number().optional().describe('If provided, records a price observation'),
    shipping: z.number().optional(),
    currency: z.string().optional().describe('Default GBP'),
    total_landed_gbp: z.number().optional(),
    hunt_id: z.number().optional().describe('If provided, associates offer with this hunt'),
    search_query_id: z.number().optional(),
  },
  async (args) => {
    const recordOffer = db.transaction(() => {
      // Upsert offer
      const existing = db.prepare(
        'SELECT id FROM offers WHERE source = ? AND source_id = ?',
      ).get(args.source, args.source_id) as any;

      let offerId: number;
      if (existing) {
        const sets: string[] = ["last_seen_at = datetime('now')"];
        const params: unknown[] = [];
        if (args.title) { sets.push('title = ?'); params.push(args.title); }
        if (args.url !== undefined) { sets.push('url = ?'); params.push(args.url); }
        if (args.seller !== undefined) { sets.push('seller = ?'); params.push(args.seller); }
        if (args.seller_rating !== undefined) { sets.push('seller_rating = ?'); params.push(args.seller_rating); }
        if (args.condition !== undefined) { sets.push('condition = ?'); params.push(args.condition); }
        if (args.specs_extracted !== undefined) { sets.push('specs_extracted = ?'); params.push(args.specs_extracted); }
        if (args.attributes !== undefined) { sets.push('attributes = ?'); params.push(JSON.stringify(args.attributes)); }
        if (args.vertical !== undefined) { sets.push('vertical = ?'); params.push(args.vertical); }
        if (args.buying_format !== undefined) { sets.push('buying_format = ?'); params.push(args.buying_format); }
        if (args.auction_end_time !== undefined) { sets.push('auction_end_time = ?'); params.push(args.auction_end_time); }
        if (args.bid_count !== undefined) { sets.push('bid_count = ?'); params.push(args.bid_count); }
        params.push(existing.id);
        db.prepare(`UPDATE offers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        offerId = existing.id;
      } else {
        const result = db.prepare(`
          INSERT INTO offers (source, source_id, title, url, seller, seller_rating, condition,
            specs_extracted, attributes, vertical, buying_format, auction_end_time, bid_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          args.source, args.source_id, args.title, args.url || null,
          args.seller || null, args.seller_rating ?? null, args.condition || null,
          args.specs_extracted || '{}',
          args.attributes !== undefined ? JSON.stringify(args.attributes) : '{}',
          args.vertical || null, args.buying_format || null,
          args.auction_end_time || null, args.bid_count ?? null,
        );
        offerId = result.lastInsertRowid as number;
      }

      // Record price if provided
      let priceId: number | null = null;
      if (args.price !== undefined) {
        const priceResult = db.prepare(`
          INSERT INTO prices (offer_id, price, shipping, currency, total_landed_gbp)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          offerId, args.price, args.shipping ?? null,
          args.currency || 'GBP', args.total_landed_gbp ?? null,
        );
        priceId = priceResult.lastInsertRowid as number;
      }

      // Associate with hunt if provided
      if (args.hunt_id) {
        db.prepare(`
          INSERT OR IGNORE INTO hunt_offers (hunt_id, offer_id, search_query_id)
          VALUES (?, ?, ?)
        `).run(args.hunt_id, offerId, args.search_query_id ?? null);
      }

      const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
      return { offer, price_id: priceId, is_new: !existing };
    });

    const result = recordOffer();
    return jsonResult(result);
  },
);

// ============================================================
// Tool 7: update_offer
// ============================================================
server.tool(
  'update_offer',
  'Update an offer\'s status or watch settings. Can also update the hunt_offer status for a specific hunt.',
  {
    offer_id: z.number().optional(),
    source: z.string().optional().describe('Alternative to offer_id: lookup by source + source_id'),
    source_id: z.string().optional(),
    status: z.enum(['active', 'ended', 'removed', 'sold']).optional(),
    watching: z.boolean().optional(),
    watch_conditions: z.string().optional().describe('JSON string. Canonical keys: alert_if_price_below_gbp (number), max_price (number), verify_required (string[] of unverified must-have requirements — auto-populated by record_evaluation on watch; carried over from the existing conditions unless you explicitly set or clear it).'),
    attributes: z.record(z.string(), z.unknown()).optional().describe('Structured source attributes object (stored as JSON). Powers list_offers triage columns — e.g. for cars: subTitle, attentionGrabber, year, distance_miles, price_tier.'),
    vertical: z.string().optional().describe("Vertical this offer belongs to, e.g. 'computers' or 'cars'."),
    hunt_id: z.number().optional().describe('If provided with hunt_offer_status, updates the hunt_offer'),
    hunt_offer_status: z.enum(['new', 'evaluated', 'watching', 'dismissed']).optional(),
  },
  async (args) => {
    let offerId = args.offer_id;
    if (!offerId && args.source && args.source_id) {
      const row = db.prepare('SELECT id FROM offers WHERE source = ? AND source_id = ?').get(args.source, args.source_id) as any;
      if (!row) return errorResult(`Offer not found: ${args.source}/${args.source_id}`);
      offerId = row.id;
    }
    if (!offerId) return errorResult('Provide offer_id or source + source_id');

    const sets: string[] = [];
    const params: unknown[] = [];
    if (args.status) { sets.push('status = ?'); params.push(args.status); }
    if (args.watching !== undefined) {
      sets.push('watching = ?'); params.push(args.watching ? 1 : 0);
      if (!args.watching) { sets.push("notified_thresholds = '[]'"); }
    }
    if (args.watch_conditions !== undefined) {
      // Preserve verify_required (auto-populated by record_evaluation) unless the caller
      // explicitly sets or clears it — a routine price-threshold update must not silently
      // drop the "confirm this must-have" flag.
      let newConditions = args.watch_conditions;
      try {
        const incoming = JSON.parse(args.watch_conditions);
        if (incoming && typeof incoming === 'object' && !Array.isArray(incoming) && !('verify_required' in incoming)) {
          const row = db.prepare('SELECT watch_conditions FROM offers WHERE id = ?').get(offerId) as
            | { watch_conditions: string | null }
            | undefined;
          if (row?.watch_conditions) {
            const existing = JSON.parse(row.watch_conditions);
            if (existing && typeof existing === 'object' && Array.isArray(existing.verify_required) && existing.verify_required.length > 0) {
              incoming.verify_required = existing.verify_required;
              newConditions = JSON.stringify(incoming);
            }
          }
        }
      } catch {
        // Either value isn't valid JSON — store the caller's value as-is (matches prior behavior)
      }
      sets.push('watch_conditions = ?'); params.push(newConditions);
    }
    if (args.attributes !== undefined) { sets.push('attributes = ?'); params.push(JSON.stringify(args.attributes)); }
    if (args.vertical !== undefined) { sets.push('vertical = ?'); params.push(args.vertical); }

    if (sets.length > 0) {
      params.push(offerId);
      db.prepare(`UPDATE offers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }

    if (args.hunt_id && args.hunt_offer_status) {
      db.prepare('UPDATE hunt_offers SET status = ? WHERE hunt_id = ? AND offer_id = ?')
        .run(args.hunt_offer_status, args.hunt_id, offerId);
    }

    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
    return jsonResult({ offer });
  },
);

// ============================================================
// Tool 8: get_offer
// ============================================================
// --- Tool 8a: list_offers (triage scan — slim rows for batch decisions) ---

server.tool(
  'list_offers',
  'List offers with slim triage-weight rows. Use for scanning new offers, reviewing watched items, or any batch view. Returns only the fields needed for quick decisions — use get_offer to dive deeper on specific items.',
  {
    hunt_id: z.number().optional().describe('Filter by hunt association'),
    hunt_offer_status: z.string().optional().describe('Filter by hunt_offer status (new, evaluated, watching, dismissed)'),
    condition: z.string().optional(),
    min_price: z.number().optional().describe('Min latest total_landed_gbp'),
    max_price: z.number().optional().describe('Max latest total_landed_gbp'),
    watching_only: z.boolean().optional(),
    limit: z.number().optional().describe('Max results (default 50, max 200)'),
    page: z.number().min(1).default(1).describe('Page number for pagination'),
    order: z
      .enum(['newest', 'queued_oldest_first'])
      .optional()
      .describe(
        "Row order. 'newest' (default): last_seen_at DESC. 'queued_oldest_first': first_associated_at ASC — use when triaging a hunt backlog so the oldest queued offers are evaluated before the stale-queue flush can dismiss them (requires hunt_id).",
      ),
  },
  async (args) => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const joins: string[] = [];

    // Always join prices for the latest price subquery
    joins.push(`LEFT JOIN (
      SELECT offer_id, price, shipping, total_landed_gbp, observed_at,
        ROW_NUMBER() OVER (PARTITION BY offer_id ORDER BY observed_at DESC) AS rn
      FROM prices
    ) lp ON lp.offer_id = o.id AND lp.rn = 1`);

    if (args.hunt_id) {
      joins.push('JOIN hunt_offers ho ON ho.offer_id = o.id');
      conditions.push('ho.hunt_id = ?');
      params.push(args.hunt_id);
      if (args.hunt_offer_status) {
        conditions.push('ho.status = ?');
        params.push(args.hunt_offer_status);
      }
    }
    if (args.condition) {
      conditions.push('o.condition = ?');
      params.push(args.condition);
    }
    if (args.watching_only) {
      conditions.push('o.watching = 1');
    }
    if (args.min_price !== undefined) {
      conditions.push('lp.total_landed_gbp >= ?');
      params.push(args.min_price);
    }
    if (args.max_price !== undefined) {
      conditions.push('lp.total_landed_gbp <= ?');
      params.push(args.max_price);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = Math.min(args.limit || 50, 200);
    const offset = ((args.page || 1) - 1) * limit;

    // Slim triage columns. The json_extract fields are cheap free-text/spec signals that
    // let the agent triage without a per-row get_offer or any detail fetch — critical for
    // cars, where the trim/engine/body live in subTitle and extras in attentionGrabber
    // (the bare title is just make/model). They are null for sources that don't set them.
    const triageExtras = `json_extract(o.attributes, '$.price_tier') AS price_tier,
         json_extract(o.attributes, '$.subTitle') AS sub_title,
         json_extract(o.attributes, '$.attentionGrabber') AS attention_grabber,
         json_extract(o.attributes, '$.year') AS year,
         json_extract(o.attributes, '$.distance_miles') AS distance_miles`;
    const selectCols = args.hunt_id
      ? `o.id, o.title, o.source_id, o.condition, o.buying_format, o.status, o.last_seen_at,
         lp.price, lp.shipping, lp.total_landed_gbp,
         ${triageExtras},
         ho.status AS hunt_offer_status`
      : `o.id, o.title, o.source_id, o.condition, o.buying_format, o.status, o.last_seen_at,
         lp.price, lp.shipping, lp.total_landed_gbp,
         ${triageExtras}`;

    // queued_oldest_first only makes sense (and only has ho.* available) with a hunt_id filter.
    const orderClause =
      args.order === 'queued_oldest_first' && args.hunt_id
        ? 'ORDER BY ho.first_associated_at ASC'
        : 'ORDER BY o.last_seen_at DESC';
    const query = `SELECT ${selectCols} FROM offers o ${joins.join(' ')} ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
    params.push(limit + 1, offset); // fetch one extra to detect has_more

    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const offers = hasMore ? rows.slice(0, limit) : rows;

    return jsonResult({ offers, count: offers.length, page: args.page || 1, limit, has_more: hasMore });
  },
);

// --- Tool 8b: get_offer (single offer deep dive) ---

server.tool(
  'get_offer',
  'Get full details for a single offer by ID or source+source_id. Returns all offer fields, latest price, and most recent evaluation. Use list_offers for batch scanning, get_offer_history for price trends.',
  {
    offer_id: z.number().optional(),
    source: z.string().optional(),
    source_id: z.string().optional(),
  },
  async (args) => {
    let offer: any;
    if (args.offer_id) {
      offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(args.offer_id);
    } else if (args.source && args.source_id) {
      offer = db.prepare('SELECT * FROM offers WHERE source = ? AND source_id = ?').get(args.source, args.source_id);
    } else {
      return errorResult('Provide offer_id or source+source_id');
    }
    if (!offer) return errorResult('Offer not found');

    const latestPrice = db.prepare(
      'SELECT * FROM prices WHERE offer_id = ? ORDER BY observed_at DESC LIMIT 1',
    ).get(offer.id) || null;

    const lastEvaluation = db.prepare(
      'SELECT e.*, h.name as hunt_name FROM evaluations e JOIN hunts h ON h.id = e.hunt_id WHERE e.offer_id = ? ORDER BY e.evaluated_at DESC LIMIT 1',
    ).get(offer.id) || null;

    const huntAssociations = db.prepare(`
      SELECT ho.hunt_id, ho.status, h.name as hunt_name FROM hunt_offers ho
      JOIN hunts h ON h.id = ho.hunt_id WHERE ho.offer_id = ?
    `).all(offer.id);

    return jsonResult({ offer, latest_price: latestPrice, last_evaluation: lastEvaluation, hunt_associations: huntAssociations });
  },
);

// --- Tool 8c: get_offer_history (price/evaluation/alert history for one offer) ---

server.tool(
  'get_offer_history',
  'Get historical prices, evaluations, or alerts for a single offer. Use when you need price trends for a watched offer or want to review past evaluation decisions.',
  {
    offer_id: z.number().describe('Offer ID'),
    type: z.enum(['prices', 'evaluations', 'alerts']).describe('Which history to fetch'),
    limit: z.number().min(1).max(100).default(20).describe('Max records to return (default 20)'),
    page: z.number().min(1).default(1).describe('Page number for pagination'),
  },
  async (args) => {
    const offer = db.prepare('SELECT id FROM offers WHERE id = ?').get(args.offer_id);
    if (!offer) return errorResult('Offer not found');

    const limit = args.limit;
    const offset = (args.page - 1) * limit;

    let rows: any[];
    switch (args.type) {
      case 'prices':
        rows = db.prepare(
          'SELECT price, shipping, currency, total_landed_gbp, observed_at FROM prices WHERE offer_id = ? ORDER BY observed_at DESC LIMIT ? OFFSET ?',
        ).all(args.offer_id, limit + 1, offset);
        break;
      case 'evaluations':
        rows = db.prepare(
          'SELECT e.decision, e.reasoning, e.evaluated_at, h.name as hunt_name FROM evaluations e JOIN hunts h ON h.id = e.hunt_id WHERE e.offer_id = ? ORDER BY e.evaluated_at DESC LIMIT ? OFFSET ?',
        ).all(args.offer_id, limit + 1, offset);
        break;
      case 'alerts':
        rows = db.prepare(
          'SELECT a.urgency, a.message_sent, a.alerted_at, a.user_response, a.feedback_extracted, a.responded_at, h.name as hunt_name FROM alerts a JOIN hunts h ON h.id = a.hunt_id WHERE a.offer_id = ? ORDER BY a.alerted_at DESC LIMIT ? OFFSET ?',
        ).all(args.offer_id, limit + 1, offset);
        break;
    }

    const hasMore = rows.length > limit;
    const records = hasMore ? rows.slice(0, limit) : rows;

    return jsonResult({ [args.type]: records, count: records.length, page: args.page, limit, has_more: hasMore });
  },
);

// ============================================================
// Tool 9: record_evaluation
// ============================================================
server.tool(
  'record_evaluation',
  'Record an evaluation decision for an offer against a hunt. Updates hunt_offer status accordingly. Watch decision sets offer.watching=1. For feature-led hunts (criteria.intent.must_have non-empty), decision "alert" REQUIRES requirement_checks covering every must_have entry (verbatim strings) and is refused if any is contradicted — a failed hard requirement is a skip, not an alert. A watch with unverified checks auto-populates watch_conditions.verify_required on the offer.',
  {
    offer_id: z.number(),
    hunt_id: z.number(),
    decision: z.enum(['alert', 'skip', 'watch']),
    reasoning: z.string(),
    requirement_checks: z
      .array(
        z.object({
          requirement: z
            .string()
            .describe("Verbatim entry from the hunt's criteria.intent.must_have (or nice_to_have) — exact string, not a paraphrase"),
          verdict: z.enum(['verified', 'unverified', 'contradicted']),
          evidence: z
            .string()
            .describe('What in THIS listing supports the verdict — e.g. the equipment-list entry, or its absence'),
        }),
      )
      .optional()
      .describe('Per-requirement verdicts for this specific listing. Required (full must_have coverage) when decision is "alert" on a feature-led hunt.'),
  },
  async ({ offer_id, hunt_id, decision, reasoning, requirement_checks }) => {
    const validated = validateRequirementChecks(hunt_id, decision, requirement_checks);
    if ('error' in validated) return errorResult(validated.error);
    const checksJson = validated.normalized ? JSON.stringify(validated.normalized) : null;

    const recordEval = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO evaluations (offer_id, hunt_id, decision, reasoning, requirement_checks)
        VALUES (?, ?, ?, ?, ?)
      `).run(offer_id, hunt_id, decision, reasoning, checksJson);

      // Update hunt_offer status
      let hoStatus: string;
      if (decision === 'watch') hoStatus = 'watching';
      else if (decision === 'skip') hoStatus = 'dismissed';
      else hoStatus = 'evaluated';

      db.prepare('UPDATE hunt_offers SET status = ? WHERE hunt_id = ? AND offer_id = ?')
        .run(hoStatus, hunt_id, offer_id);

      // If watch, set offer.watching — and surface unverified requirements as a machine-readable
      // verify_required list in watch_conditions (merged, preserving any price keys already set).
      if (decision === 'watch') {
        db.prepare('UPDATE offers SET watching = 1 WHERE id = ?').run(offer_id);
        const unverified = (validated.normalized ?? [])
          .filter((c) => c.verdict === 'unverified')
          .map((c) => c.requirement);
        if (unverified.length > 0) {
          const row = db.prepare('SELECT watch_conditions FROM offers WHERE id = ?').get(offer_id) as
            | { watch_conditions: string | null }
            | undefined;
          let conditions: Record<string, unknown> = {};
          try {
            const parsed = row?.watch_conditions ? JSON.parse(row.watch_conditions) : {};
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) conditions = parsed;
          } catch {
            // Invalid existing JSON — replace rather than propagate garbage
          }
          conditions.verify_required = unverified;
          db.prepare('UPDATE offers SET watch_conditions = ? WHERE id = ?')
            .run(JSON.stringify(conditions), offer_id);
        }
      }

      return db.prepare('SELECT * FROM evaluations WHERE id = ?').get(result.lastInsertRowid);
    });

    const evaluation = recordEval();
    return jsonResult({ evaluation });
  },
);

// ============================================================
// Tool 9b: batch_dismiss
// ============================================================
server.tool(
  'batch_dismiss',
  'Dismiss multiple offers in one call. Use during triage to quickly clear obvious mismatches (wrong product, accessories, way over budget) without deep-diving each one.',
  {
    hunt_id: z.number(),
    dismissals: z.array(z.object({
      offer_id: z.number(),
      reasoning: z.string().describe('Brief reason, e.g. "accessory not product", "£400 over budget", "wrong category"'),
    })),
  },
  async ({ hunt_id, dismissals }) => {
    const batchDismiss = db.transaction(() => {
      const results: Array<{ offer_id: number; status: string }> = [];
      for (const d of dismissals) {
        db.prepare(`
          INSERT INTO evaluations (offer_id, hunt_id, decision, reasoning)
          VALUES (?, ?, 'skip', ?)
        `).run(d.offer_id, hunt_id, d.reasoning);

        db.prepare("UPDATE hunt_offers SET status = 'dismissed' WHERE hunt_id = ? AND offer_id = ?")
          .run(hunt_id, d.offer_id);

        results.push({ offer_id: d.offer_id, status: 'dismissed' });
      }
      return results;
    });

    const results = batchDismiss();
    return jsonResult({ dismissed: results.length, results });
  },
);

// ============================================================
// Tool 10: record_alert
// ============================================================
server.tool(
  'record_alert',
  'Record that an alert was sent to the user about an offer.',
  {
    offer_id: z.number(),
    hunt_id: z.number(),
    urgency: z.enum(['high', 'medium', 'low']),
    message_sent: z.string(),
  },
  async ({ offer_id, hunt_id, urgency, message_sent }) => {
    const result = db.prepare(`
      INSERT INTO alerts (offer_id, hunt_id, urgency, message_sent)
      VALUES (?, ?, ?, ?)
    `).run(offer_id, hunt_id, urgency, message_sent);
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(result.lastInsertRowid);
    return jsonResult({ alert });
  },
);

// ============================================================
// Tool 11: record_alert_response
// ============================================================
server.tool(
  'record_alert_response',
  'Record the user\'s response to an alert and any extracted feedback/preferences.',
  {
    alert_id: z.number(),
    user_response: z.string(),
    feedback_extracted: z.string().optional().describe('Structured preference extracted from the response'),
  },
  async ({ alert_id, user_response, feedback_extracted }) => {
    db.prepare(`
      UPDATE alerts SET user_response = ?, feedback_extracted = ?, responded_at = datetime('now')
      WHERE id = ?
    `).run(user_response, feedback_extracted || null, alert_id);
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert_id);
    if (!alert) return errorResult('Alert not found: ' + alert_id);
    return jsonResult({ alert });
  },
);

// ============================================================
// Tool 12: get_prices
// ============================================================
server.tool(
  'get_prices',
  'Get price data. Modes: "history" (for a single offer), "aggregates" (median/range/trend across offers), "changes" (offers with price changes since a timestamp).',
  {
    mode: z.enum(['history', 'aggregates', 'changes']),
    offer_id: z.number().optional().describe('Required for history mode'),
    hunt_id: z.number().optional().describe('Filter by hunt (aggregates/changes modes)'),
    source: z.string().optional(),
    condition: z.string().optional(),
    days: z.number().optional().describe('Lookback period (default 30)'),
    since: z.string().optional().describe('ISO timestamp for changes mode'),
  },
  async (args) => {
    if (args.mode === 'history') {
      if (!args.offer_id) return errorResult('offer_id required for history mode');
      const prices = db.prepare(
        'SELECT * FROM prices WHERE offer_id = ? ORDER BY observed_at DESC',
      ).all(args.offer_id);
      return jsonResult({ prices });
    }

    if (args.mode === 'changes') {
      const since = args.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const huntJoin = args.hunt_id ? 'JOIN hunt_offers ho ON ho.offer_id = o.id AND ho.hunt_id = ?' : '';
      const huntParams = args.hunt_id ? [args.hunt_id] : [];

      const changes = db.prepare(`
        SELECT o.id, o.title, o.source, o.source_id, o.url,
          p_new.total_landed_gbp as new_price,
          p_new.observed_at as new_observed,
          p_prev.total_landed_gbp as prev_price,
          p_prev.observed_at as prev_observed
        FROM offers o
        ${huntJoin}
        JOIN prices p_new ON p_new.offer_id = o.id
        LEFT JOIN prices p_prev ON p_prev.offer_id = o.id
          AND p_prev.observed_at = (
            SELECT MAX(observed_at) FROM prices
            WHERE offer_id = o.id AND observed_at < p_new.observed_at
          )
        WHERE p_new.observed_at > ?
          AND p_new.observed_at = (SELECT MAX(observed_at) FROM prices WHERE offer_id = o.id)
          AND (p_prev.total_landed_gbp IS NULL OR p_new.total_landed_gbp != p_prev.total_landed_gbp)
        ORDER BY p_new.observed_at DESC
      `).all(...huntParams, since);
      return jsonResult({ changes, since });
    }

    // Aggregates mode — delegate to get_market_overview logic
    const lookback = args.days || 30;
    const conditions: string[] = [`p.observed_at > datetime('now', '-${lookback} days')`, 'p.total_landed_gbp IS NOT NULL'];
    const params: unknown[] = [];
    const joins: string[] = ['JOIN offers o ON o.id = p.offer_id'];

    if (args.hunt_id) {
      joins.push('JOIN hunt_offers ho ON ho.offer_id = o.id');
      conditions.push('ho.hunt_id = ?');
      params.push(args.hunt_id);
    }
    if (args.source) { conditions.push('o.source = ?'); params.push(args.source); }
    if (args.condition) { conditions.push('o.condition = ?'); params.push(args.condition); }

    const stats = db.prepare(`
      SELECT COUNT(DISTINCT o.id) as offer_count, COUNT(p.id) as observations,
        MIN(p.total_landed_gbp) as min_price, MAX(p.total_landed_gbp) as max_price,
        AVG(p.total_landed_gbp) as avg_price
      FROM prices p ${joins.join(' ')}
      WHERE ${conditions.join(' AND ')}
    `).get(...params);

    return jsonResult({ aggregates: stats, period_days: lookback });
  },
);

// ============================================================
// Tool 13: record_search
// ============================================================
server.tool(
  'record_search',
  'Record a search execution and its result counts. Returns the search_query ID for use when associating offers.',
  {
    hunt_id: z.number(),
    source: z.string(),
    terms: z.string(),
    result_count: z.number(),
    new_offer_count: z.number(),
    relevant_count: z.number(),
  },
  async ({ hunt_id, source, terms, result_count, new_offer_count, relevant_count }) => {
    const result = db.prepare(`
      INSERT INTO search_queries (hunt_id, source, terms, result_count, new_offer_count, relevant_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hunt_id, source, terms, result_count, new_offer_count, relevant_count);
    const query = db.prepare('SELECT * FROM search_queries WHERE id = ?').get(result.lastInsertRowid);
    return jsonResult({ search_query: query });
  },
);

// ============================================================
// Tool 14: search_evaluations
// ============================================================
server.tool(
  'search_evaluations',
  'Search past evaluations by text (in reasoning), decision type, or hunt. Optionally includes user feedback from alerts.',
  {
    query: z.string().optional().describe('Text search in evaluation reasoning'),
    hunt_id: z.number().optional(),
    decision: z.enum(['alert', 'skip', 'watch']).optional(),
    days: z.number().optional().describe('Lookback period (default 90)'),
    include_feedback: z.boolean().optional().describe('Join with alert user_response data'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async (args) => {
    const lookback = args.days || 90;
    const limit = args.limit || 20;
    const conditions: string[] = [`e.evaluated_at > datetime('now', '-${lookback} days')`];
    const params: unknown[] = [];

    if (args.query) {
      conditions.push('e.reasoning LIKE ?');
      params.push(`%${args.query}%`);
    }
    if (args.hunt_id) {
      conditions.push('e.hunt_id = ?');
      params.push(args.hunt_id);
    }
    if (args.decision) {
      conditions.push('e.decision = ?');
      params.push(args.decision);
    }

    const feedbackJoin = args.include_feedback
      ? 'LEFT JOIN alerts a ON a.offer_id = e.offer_id AND a.hunt_id = e.hunt_id'
      : '';
    const feedbackCols = args.include_feedback
      ? ', a.user_response, a.feedback_extracted, a.urgency as alert_urgency'
      : '';

    const evaluations = db.prepare(`
      SELECT e.*, o.title, o.source, o.source_id, o.condition, o.url,
        h.name as hunt_name${feedbackCols}
      FROM evaluations e
      JOIN offers o ON o.id = e.offer_id
      JOIN hunts h ON h.id = e.hunt_id
      ${feedbackJoin}
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.evaluated_at DESC
      LIMIT ?
    `).all(...params, limit);

    return jsonResult({ evaluations, count: evaluations.length });
  },
);

// ============================================================
// Tool 15: create_market_segment
// ============================================================
server.tool(
  'create_market_segment',
  'Create or update a market segment for a hunt. Segments group items by variant/category for price comparison (e.g. "M90q Gen 1 i5", "Budget tier under £150"). Upserts by (hunt_id, name). Returns all hunt segments so you can see existing tag vocabulary.',
  {
    hunt_id: z.number(),
    name: z.string().describe('Short descriptive name for this grouping — also used for offer matching, so include the product name/model'),
    description: z.string().optional().describe('What defines this segment'),
    tags: z.string().optional().describe('JSON array of tags used to match offers to this segment. Include the product model (e.g. "5650G") AND attribute tags (e.g. "ECC-confirmed", "ATX"). For feature-led hunts the exact criteria target key must be included verbatim as one of the tags (e.g. "Kia EV6", not just "EV6") — the activation gate anchors segments to researched targets via tags. Reuse tags from existing segments for consistency — check all_hunt_segments in the response.'),
    filter_patterns: z.string().optional().describe('JSON object gating how the dashboard matches offers to this segment: {"require": [...], "exclude": [...]}. Terms are whole-token, case-insensitive matches against the listing title + subtitle. require: at least one term must appear; exclude: any term present disqualifies. Use when two segments differ only by a token the source omits on the default variant — e.g. AutoTrader labels AWD cars "AWD" but RWD cars carry no drivetrain token, so give the AWD segment {"require": ["AWD"]} and the RWD segment {"exclude": ["AWD"]}. Omit otherwise.'),
    price_low: z.number().optional().describe('DEPRECATED for v2 hunts — price bands are DERIVED from recorded comps. Record comps via record_baseline_price then call recompute_segment_prices. (Legacy v1 hunts: good-deal threshold.)'),
    price_mid: z.number().optional().describe('DEPRECATED for v2 hunts (derived). Legacy v1: typical/fair market price.'),
    price_high: z.number().optional().describe('DEPRECATED for v2 hunts (derived). Legacy v1: overpriced threshold.'),
    sample_size: z.number().optional().describe('DEPRECATED for v2 hunts (derived from comp count). Legacy v1: data points informing the tiers.'),
    confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional().describe('DEPRECATED for v2 hunts (derived). Legacy v1: HIGH 20+ consistent / MEDIUM 10-20 or some variance / LOW <10 or variable.'),
    notes: z.string().optional().describe('Market observations, gotchas, caveats'),
  },
  async (args) => {
    const hunt = db.prepare('SELECT id FROM hunts WHERE id = ?').get(args.hunt_id);
    if (!hunt) return errorResult(`Hunt ${args.hunt_id} not found`);

    // v2 hunts: price bands + sample_size + confidence are DERIVED from sourced comps by
    // recompute_segment_prices, so agent-supplied values for those are ignored here (the agent's job
    // is the bucketing: name, tags, description). Legacy v1 hunts keep accepting them.
    const v2 = huntGateVersion(args.hunt_id) >= 2;
    const note = v2
      ? 'v2 hunt: price_low/mid/high, sample_size and confidence are DERIVED — record comps via record_baseline_price then call recompute_segment_prices. Any price values passed here were ignored.'
      : undefined;

    const existing = db.prepare(
      'SELECT * FROM market_segments WHERE hunt_id = ? AND name = ?',
    ).get(args.hunt_id, args.name) as Record<string, unknown> | undefined;

    if (existing) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const params: unknown[] = [];
      if (args.description !== undefined) { sets.push('description = ?'); params.push(args.description); }
      if (args.tags !== undefined) { sets.push('tags = ?'); params.push(args.tags); }
      if (args.filter_patterns !== undefined) { sets.push('filter_patterns = ?'); params.push(args.filter_patterns); }
      if (!v2 && args.price_low !== undefined) { sets.push('price_low = ?'); params.push(args.price_low); }
      if (!v2 && args.price_mid !== undefined) { sets.push('price_mid = ?'); params.push(args.price_mid); }
      if (!v2 && args.price_high !== undefined) { sets.push('price_high = ?'); params.push(args.price_high); }
      if (!v2 && args.sample_size !== undefined) { sets.push('sample_size = ?'); params.push(args.sample_size); }
      if (!v2 && args.confidence !== undefined) { sets.push('confidence = ?'); params.push(args.confidence); }
      if (args.notes !== undefined) { sets.push('notes = ?'); params.push(args.notes); }
      params.push(existing.id);
      db.prepare(`UPDATE market_segments SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      const updated = db.prepare('SELECT * FROM market_segments WHERE id = ?').get(existing.id);
      const allSegments = db.prepare('SELECT id, name, tags FROM market_segments WHERE hunt_id = ?').all(args.hunt_id);
      return jsonResult({ action: 'updated', segment: updated, all_hunt_segments: allSegments, note });
    } else {
      const result = db.prepare(`
        INSERT INTO market_segments (hunt_id, name, description, tags, filter_patterns, price_low, price_mid, price_high, sample_size, confidence, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        args.hunt_id, args.name, args.description || null,
        args.tags || '[]', args.filter_patterns || '{}',
        v2 ? null : (args.price_low ?? null), v2 ? null : (args.price_mid ?? null), v2 ? null : (args.price_high ?? null),
        v2 ? 0 : (args.sample_size ?? 0), v2 ? 'LOW' : (args.confidence || 'LOW'), args.notes || null,
      );
      const segment = db.prepare('SELECT * FROM market_segments WHERE id = ?').get(result.lastInsertRowid);
      const allSegments = db.prepare('SELECT id, name, tags FROM market_segments WHERE hunt_id = ?').all(args.hunt_id);
      return jsonResult({ action: 'created', segment, all_hunt_segments: allSegments, note });
    }
  },
);

// ============================================================
// Tool 16: record_baseline_price
// ============================================================
server.tool(
  'record_baseline_price',
  'Record one or more baseline price data points for a hunt. These are research data (sold listings, observed active prices) — not live offer tracking. Use after calling get_sold_prices or reviewing active listings.',
  {
    hunt_id: z.number(),
    segment_id: z.number().optional().describe('Segment ID to associate with'),
    segment_name: z.string().optional().describe('Alternative to segment_id: resolve by name within the hunt'),
    items: z.array(z.object({
      source_type: z.enum(['sold', 'active', 'auction_completed']),
      title: z.string(),
      price: z.number(),
      shipping: z.number().optional(),
      total_landed_gbp: z.number().optional(),
      condition: z.string().optional(),
      sold_date: z.string().optional().describe('ISO date when item sold'),
      source_url: z.string().optional(),
      source_item_id: z.string().optional(),
      tags: z.string().optional().describe('JSON array of attribute tags'),
      attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Structured comp attributes using the vertical contract keys. For cars comps record {"mileage_num": <miles as number>, "year": <year>} — mileage makes the comp usable in the depreciation-trend fit.'),
    })).describe('Array of price data points to record'),
  },
  async (args) => {
    const hunt = db.prepare('SELECT id FROM hunts WHERE id = ?').get(args.hunt_id);
    if (!hunt) return errorResult(`Hunt ${args.hunt_id} not found`);

    let segmentId: number | null = args.segment_id ?? null;
    if (!segmentId && args.segment_name) {
      const seg = db.prepare(
        'SELECT id FROM market_segments WHERE hunt_id = ? AND name = ?',
      ).get(args.hunt_id, args.segment_name) as { id: number } | undefined;
      if (!seg) return errorResult(`Segment "${args.segment_name}" not found for hunt ${args.hunt_id}`);
      segmentId = seg.id;
    }

    const insert = db.prepare(`
      INSERT INTO baseline_prices (segment_id, hunt_id, source_type, title, price, shipping, total_landed_gbp, condition, sold_date, source_url, source_item_id, tags, attributes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const recordAll = db.transaction(() => {
      for (const item of args.items) {
        insert.run(
          segmentId, args.hunt_id, item.source_type, item.title, item.price,
          item.shipping ?? null, item.total_landed_gbp ?? null,
          item.condition || null, item.sold_date || null,
          item.source_url || null, item.source_item_id || null,
          item.tags || '[]',
          JSON.stringify(item.attributes ?? {}),
        );
      }
    });
    recordAll();

    return jsonResult({ recorded: args.items.length, segment_id: segmentId });
  },
);

// ============================================================
// Tool 17: get_baseline_summary
// ============================================================
server.tool(
  'get_baseline_summary',
  'Get baseline research summary for a hunt: segments with price tiers, data point counts, and latest research date.',
  {
    hunt_id: z.number(),
    segment_id: z.number().optional().describe('Get summary for a specific segment only'),
  },
  async (args) => {
    const hunt = db.prepare('SELECT id, name FROM hunts WHERE id = ?').get(args.hunt_id) as { id: number; name: string } | undefined;
    if (!hunt) return errorResult(`Hunt ${args.hunt_id} not found`);

    const segmentCondition = args.segment_id ? 'AND ms.id = ?' : '';
    const segmentParams = args.segment_id ? [args.hunt_id, args.segment_id] : [args.hunt_id];

    const segments = db.prepare(`
      SELECT ms.*,
        COALESCE(bp.data_point_count, 0) as data_point_count,
        COALESCE(bp.sold_count, 0) as sold_count,
        COALESCE(bp.active_count, 0) as active_count,
        bp.earliest_data,
        bp.latest_data
      FROM market_segments ms
      LEFT JOIN (
        SELECT segment_id,
          COUNT(*) as data_point_count,
          SUM(CASE WHEN source_type = 'sold' THEN 1 ELSE 0 END) as sold_count,
          SUM(CASE WHEN source_type = 'active' THEN 1 ELSE 0 END) as active_count,
          MIN(observed_at) as earliest_data,
          MAX(observed_at) as latest_data
        FROM baseline_prices
        GROUP BY segment_id
      ) bp ON bp.segment_id = ms.id
      WHERE ms.hunt_id = ? ${segmentCondition}
      ORDER BY ms.created_at ASC
    `).all(...segmentParams);

    const unclassified = db.prepare(
      'SELECT COUNT(*) as count FROM baseline_prices WHERE hunt_id = ? AND segment_id IS NULL',
    ).get(args.hunt_id) as { count: number };

    return jsonResult({
      hunt_id: args.hunt_id,
      hunt_name: hunt.name,
      segments,
      unclassified_count: unclassified.count,
    });
  },
);

// ============================================================
// Tool 18: log_hunt_run
// ============================================================
server.tool(
  'log_hunt_run',
  'Log a summary of an agent run against a hunt. Call at the end of each invocation with your synthesis — observations, patterns, strategy notes, issues. Per-offer details belong in evaluations, not here.',
  {
    hunt_id: z.number(),
    trigger: z.string().describe('What caused this run: new-offers, price-change, auction-countdown, watch-condition, daily-review, user'),
    summary: z.string().describe('Agent narrative: search quality observations, market patterns, strategy recommendations, system issues'),
    offers_evaluated: z.number().optional().default(0),
    offers_alerted: z.number().optional().default(0),
    offers_watched: z.number().optional().default(0),
    offers_skipped: z.number().optional().default(0),
  },
  async ({ hunt_id, trigger, summary, offers_evaluated, offers_alerted, offers_watched, offers_skipped }) => {
    const hunt = db.prepare('SELECT id FROM hunts WHERE id = ?').get(hunt_id);
    if (!hunt) return errorResult('Hunt not found: ' + hunt_id);

    const result = db.prepare(`
      INSERT INTO hunt_log (hunt_id, trigger, summary, offers_evaluated, offers_alerted, offers_watched, offers_skipped)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(hunt_id, trigger, summary, offers_evaluated, offers_alerted, offers_watched, offers_skipped);

    return jsonResult({ logged: true, id: result.lastInsertRowid });
  },
);

// ============================================================
// Tool 19: get_hunt_history
// ============================================================
server.tool(
  'get_hunt_history',
  'Review past activity for a hunt over a time range. Returns agent run summaries, aggregated search stats, evaluation counts, alerts, and offer status changes.',
  {
    hunt_id: z.number(),
    since: z.string().optional().describe('ISO timestamp — default 7 days ago'),
    until: z.string().optional().describe('ISO timestamp — default now'),
    limit: z.number().optional().default(50).describe('Max log entries to return'),
  },
  async ({ hunt_id, since, until, limit }) => {
    const hunt = db.prepare('SELECT id FROM hunts WHERE id = ?').get(hunt_id);
    if (!hunt) return errorResult('Hunt not found: ' + hunt_id);

    const sinceTs = since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const untilTs = until || new Date().toISOString().replace('T', ' ').slice(0, 19);

    const logEntries = db.prepare(`
      SELECT * FROM hunt_log
      WHERE hunt_id = ? AND logged_at >= ? AND logged_at <= ?
      ORDER BY logged_at DESC
      LIMIT ?
    `).all(hunt_id, sinceTs, untilTs, limit);

    const searchSummary = db.prepare(`
      SELECT terms,
        COUNT(*) as search_count,
        SUM(result_count) as total_results,
        SUM(new_offer_count) as total_new_offers
      FROM search_queries
      WHERE hunt_id = ? AND searched_at >= ? AND searched_at <= ?
      GROUP BY terms
      ORDER BY search_count DESC
    `).all(hunt_id, sinceTs, untilTs);

    const evalRows = db.prepare(`
      SELECT decision, COUNT(*) as count
      FROM evaluations
      WHERE hunt_id = ? AND evaluated_at >= ? AND evaluated_at <= ?
      GROUP BY decision
    `).all(hunt_id, sinceTs, untilTs) as Array<{ decision: string; count: number }>;

    const evaluationSummary: Record<string, number> = {};
    for (const row of evalRows) {
      evaluationSummary[row.decision] = row.count;
    }

    const alerts = db.prepare(`
      SELECT a.id, a.offer_id, o.title as offer_title, a.urgency, a.message_sent, a.alerted_at, a.user_response
      FROM alerts a
      JOIN offers o ON o.id = a.offer_id
      WHERE a.hunt_id = ? AND a.alerted_at >= ? AND a.alerted_at <= ?
      ORDER BY a.alerted_at DESC
    `).all(hunt_id, sinceTs, untilTs);

    const statusChanges = db.prepare(`
      SELECT o.id as offer_id, o.title, o.source_id, o.status, o.last_status_change
      FROM offers o
      JOIN hunt_offers ho ON ho.offer_id = o.id
      WHERE ho.hunt_id = ? AND o.last_status_change >= ? AND o.last_status_change <= ?
      ORDER BY o.last_status_change DESC
    `).all(hunt_id, sinceTs, untilTs);

    return jsonResult({
      period: { since: sinceTs, until: untilTs },
      log_entries: logEntries,
      search_summary: searchSummary,
      evaluation_summary: evaluationSummary,
      alerts,
      status_changes: statusChanges,
    });
  },
);

// ============================================================
// Tool 20: recompute_segment_prices  (provenance gating — B)
// ============================================================
server.tool(
  'recompute_segment_prices',
  "Derive a segment's price band (low/mid/high) from its recorded baseline_prices comps — the ONLY way v2 hunts get prices (they are never typed). Computes p25/median/p75 of each comp's landed price (total_landed_gbp, else price), counts only comps with a source_url AND source_item_id (sourced) AND non-empty tags (bucketed), updates sample_size, and derives confidence from comp count + spread. Returns the band, sample size and the within-segment spread so a too-wide bucket (mixed trims/packs) is obvious. Run after record_baseline_price. Omit segment_id to recompute every segment of the hunt.",
  {
    hunt_id: z.number(),
    segment_id: z.number().optional().describe('Recompute one segment; omit to recompute all segments of the hunt'),
  },
  async (args) => {
    const hunt = db.prepare('SELECT id FROM hunts WHERE id = ?').get(args.hunt_id);
    if (!hunt) return errorResult(`Hunt ${args.hunt_id} not found`);

    const segments = (args.segment_id
      ? db.prepare('SELECT id, name FROM market_segments WHERE hunt_id = ? AND id = ?').all(args.hunt_id, args.segment_id)
      : db.prepare('SELECT id, name FROM market_segments WHERE hunt_id = ?').all(args.hunt_id)
    ) as Array<{ id: number; name: string }>;
    if (segments.length === 0) return errorResult('No matching segments to recompute');

    const compStmt = db.prepare(
      `SELECT total_landed_gbp, price, tags FROM baseline_prices
       WHERE segment_id = ?
         AND source_url IS NOT NULL AND trim(source_url) != ''
         AND source_item_id IS NOT NULL AND trim(source_item_id) != ''`,
    );
    const hasTags = (raw: string | null): boolean => {
      if (!raw || raw.trim() === '' || raw.trim() === '[]') return false;
      try {
        const a = JSON.parse(raw);
        return Array.isArray(a) && a.some((t) => typeof t === 'string' && t.trim() !== '');
      } catch {
        return raw.trim() !== '';
      }
    };

    const results = [];
    for (const seg of segments) {
      const comps = compStmt.all(seg.id) as Array<{ total_landed_gbp: number | null; price: number | null; tags: string | null }>;
      const prices = comps
        .filter((c) => hasTags(c.tags))
        .map((c) => (typeof c.total_landed_gbp === 'number' ? c.total_landed_gbp : c.price))
        .filter((p): p is number => typeof p === 'number' && p > 0);
      const band = percentiles(prices);
      const n = prices.length;
      const spread = n >= 2 ? Math.max(...prices) / Math.min(...prices) : 1;
      // Confidence from sample size AND tightness: a wide spread can't be HIGH even with many comps.
      let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
      if (n >= 8 && spread <= 1.6) confidence = 'HIGH';
      else if (n >= 4 && spread <= 2.2) confidence = 'MEDIUM';
      if (band) {
        db.prepare(
          "UPDATE market_segments SET price_low = ?, price_mid = ?, price_high = ?, sample_size = ?, confidence = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(Math.round(band.low), Math.round(band.mid), Math.round(band.high), n, confidence, seg.id);
      } else {
        db.prepare(
          "UPDATE market_segments SET sample_size = 0, confidence = 'LOW', updated_at = datetime('now') WHERE id = ?",
        ).run(seg.id);
      }
      results.push({
        segment_id: seg.id,
        name: seg.name,
        sourced_comps: n,
        price_low: band ? Math.round(band.low) : null,
        price_mid: band ? Math.round(band.mid) : null,
        price_high: band ? Math.round(band.high) : null,
        spread_ratio: n >= 2 ? Number(spread.toFixed(2)) : null,
        confidence,
        warning:
          n === 0
            ? 'No sourced+tagged comps — record real comps with source_url, source_item_id and trim tags.'
            : spread > 2.5
              ? 'Spread > 2.5× — this bucket likely mixes trims/packs. Split it into tighter segments.'
              : undefined,
      });
    }
    return jsonResult({ hunt_id: args.hunt_id, recomputed: results.length, segments: results });
  },
);

// ============================================================
// Tool 21: record_kb_coverage  (provenance gating — C)
// ============================================================
server.tool(
  'record_kb_coverage',
  "Register that a per-target spec knowledge base has been built and cited, so a feature-led hunt can pass the activation gate's KB check (C). Call once per criteria.targets key after /car-spec-research writes the KB file. must_have_citations maps each of the hunt's intent.must_have features to the count of distinct source URLs that substantiate it in the KB — every must-have needs ≥1 cited source or the gate blocks. Upserts by (hunt_id, target_key).",
  {
    hunt_id: z.number(),
    target_key: z.string().describe('The criteria.targets key this KB covers, e.g. "Polestar 2" (must match exactly)'),
    kb_path: z.string().describe('Path to the KB file, e.g. references/product-knowledge/cars/polestar-polestar-2.md'),
    must_have_citations: z.record(z.string(), z.number()).describe('JSON object mapping each must-have feature → number of distinct cited source URLs in the KB, e.g. {"Adaptive cruise control (ACC)": 2}'),
    citation_count: z.number().optional().describe('Total distinct source URLs in the KB (optional, for reporting)'),
  },
  async (args) => {
    const hunt = db.prepare('SELECT id, vertical FROM hunts WHERE id = ?').get(args.hunt_id) as { id: number; vertical: string } | undefined;
    if (!hunt) return errorResult(`Hunt ${args.hunt_id} not found`);
    const targetKeyError = validateTargetKeyForHunt(args.hunt_id, args.target_key);
    if (targetKeyError) return errorResult(targetKeyError);
    const totalCitations =
      args.citation_count ?? Object.values(args.must_have_citations).reduce((a, b) => a + (b || 0), 0);
    db.prepare(
      `INSERT INTO knowledge_base (hunt_id, vertical, target_key, kb_path, citation_count, must_have_citations, built_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(hunt_id, target_key) DO UPDATE SET
         vertical = excluded.vertical, kb_path = excluded.kb_path,
         citation_count = excluded.citation_count, must_have_citations = excluded.must_have_citations,
         built_at = excluded.built_at`,
    ).run(args.hunt_id, hunt.vertical, args.target_key, args.kb_path, totalCitations, JSON.stringify(args.must_have_citations));
    return jsonResult({ action: 'recorded', hunt_id: args.hunt_id, target_key: args.target_key, kb_path: args.kb_path, citation_count: totalCitations });
  },
);

// ============================================================
// Tool 22: record_claim_verification  (provenance gating — D)
// ============================================================
server.tool(
  'record_claim_verification',
  "Record the adversarial verdict for one (target, must-have feature) pair, from independently re-fetched sources — the activation gate (D) blocks until every must-have for every target is 'verified'. Use 'contradicted' when a source shows the feature is NOT standard/available as claimed (e.g. it's an optional pack), with the evidence URL. Upserts by (hunt_id, target_key, feature). This is the check that catches a hallucinated spec before a hunt goes live.",
  {
    hunt_id: z.number(),
    target_key: z.string().describe('The criteria.targets key, e.g. "Polestar 2"'),
    feature: z.string().describe('The exact intent.must_have string being verified'),
    verdict: z.enum(['verified', 'unverified', 'contradicted']).describe("'verified': a source confirms it; 'contradicted': a source refutes it (e.g. optional-only); 'unverified': could not confirm either way"),
    evidence_url: z.string().optional().describe('URL of the source consulted (required in practice for verified/contradicted)'),
    notes: z.string().optional().describe('What the source said; any caveats'),
  },
  async (args) => {
    const hunt = db.prepare('SELECT id FROM hunts WHERE id = ?').get(args.hunt_id);
    if (!hunt) return errorResult(`Hunt ${args.hunt_id} not found`);
    const targetKeyError = validateTargetKeyForHunt(args.hunt_id, args.target_key);
    if (targetKeyError) return errorResult(targetKeyError);
    db.prepare(
      `INSERT INTO claim_verifications (hunt_id, target_key, feature, verdict, evidence_url, notes, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(hunt_id, target_key, feature) DO UPDATE SET
         verdict = excluded.verdict, evidence_url = excluded.evidence_url,
         notes = excluded.notes, checked_at = excluded.checked_at`,
    ).run(args.hunt_id, args.target_key, args.feature, args.verdict, args.evidence_url || null, args.notes || null);
    return jsonResult({ action: 'recorded', hunt_id: args.hunt_id, target_key: args.target_key, feature: args.feature, verdict: args.verdict });
  },
);

// ============================================================
// Tool 23: waive_must_have  (provenance gating — D escape hatch)
// ============================================================
server.tool(
  'waive_must_have',
  "Waive the verification requirement for one (target, must-have) pair when it genuinely can't be confirmed online — records a 'verified' verdict tagged as user-waived (auditable, distinct from a real verification). Use ONLY on explicit user instruction. Lets the activation gate (D) pass for that pair.",
  {
    hunt_id: z.number(),
    target_key: z.string(),
    feature: z.string().describe('The exact intent.must_have string to waive'),
    reason: z.string().describe('Why it is being waived (recorded for audit)'),
  },
  async (args) => {
    const hunt = db.prepare('SELECT id FROM hunts WHERE id = ?').get(args.hunt_id);
    if (!hunt) return errorResult(`Hunt ${args.hunt_id} not found`);
    const targetKeyError = validateTargetKeyForHunt(args.hunt_id, args.target_key);
    if (targetKeyError) return errorResult(targetKeyError);
    db.prepare(
      `INSERT INTO claim_verifications (hunt_id, target_key, feature, verdict, evidence_url, notes, checked_at)
       VALUES (?, ?, ?, 'verified', NULL, ?, datetime('now'))
       ON CONFLICT(hunt_id, target_key, feature) DO UPDATE SET
         verdict = 'verified', evidence_url = NULL, notes = excluded.notes, checked_at = excluded.checked_at`,
    ).run(args.hunt_id, args.target_key, args.feature, `USER-WAIVED: ${args.reason}`);
    return jsonResult({ action: 'waived', hunt_id: args.hunt_id, target_key: args.target_key, feature: args.feature });
  },
);

// --- Start Server ---

const transport = new StdioServerTransport();
await server.connect(transport);
