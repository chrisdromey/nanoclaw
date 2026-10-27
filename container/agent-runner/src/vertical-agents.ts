/**
 * Builds per-vertical evaluator sub-agents from the vertical capabilities the watcher mirrors
 * into the deal-hunter DB. A vertical that declares an `agent` block in config/verticals.yml
 * gets an evaluator sub-agent here with no code change; its tools/mcpServers are derived from
 * the vertical's `sources`. Verticals without an `agent` block fall back to the hand-defined
 * generic-deal-evaluator.
 */

import Database from 'better-sqlite3';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { EVALUATOR_MODEL } from './models.js';
import {
  AUTOTRADER_SEARCH_TOOLS,
  DEAL_HUNTER_DB_TOOLS,
  EBAY_API_TOOLS,
  EBAY_SEARCH_TOOLS,
  mcpToolNames,
} from './mcp-tool-names.js';

export const DEAL_HUNTER_DB_PATH =
  process.env.DEAL_HUNTER_DB_PATH || '/workspace/group/deal-hunter.db';

export interface VerticalCaps {
  name: string;
  evaluator_skill: string;
  sourcing_skill: string;
  sources: string[];
  agent?: { name: string; description: string; prompt: string };
}

/**
 * Read vertical capabilities from the DB. Returns [] if the DB or the verticals table isn't
 * present yet (the watcher populates it at startup), so callers fall back to hand-defined agents.
 * Failures are logged (not silent): a missing verticals table would otherwise make evaluator
 * sub-agents silently not exist, which breaks the delegation-only evaluation flow.
 */
export function loadVerticalCaps(dbPath: string = DEAL_HUNTER_DB_PATH): VerticalCaps[] {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verticals'")
        .get();
      if (!hasTable) {
        console.error(`[vertical-agents] verticals table missing in ${dbPath} — has the watcher run ensureSchema()?`);
        return [];
      }
      const rows = db.prepare('SELECT config_json FROM verticals').all() as Array<{ config_json: string }>;
      const out: VerticalCaps[] = [];
      for (const r of rows) {
        try {
          out.push(JSON.parse(r.config_json) as VerticalCaps);
        } catch (err) {
          console.error(`[vertical-agents] skipping malformed verticals row: ${err}`);
        }
      }
      return out;
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`[vertical-agents] could not read vertical caps from ${dbPath}: ${err}`);
    return [];
  }
}

// Source → MCP wiring. A data source is infrastructure (not vertical policy), so this mapping
// lives in code; verticals declare which sources they use, this resolves each to its MCP server
// + tool globs. Env gating mirrors the orchestrator's own credential checks.
export function mcpServersForSource(source: string, ebayToken: string): string[] {
  switch (source) {
    case 'ebay':
      return [
        ...(ebayToken ? ['ebay-search'] : []),
        ...(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET ? ['ebay-api'] : []),
      ];
    case 'autotrader':
      return ['autotrader-search'];
    default:
      return [];
  }
}

// Exact names only: AgentDefinition.tools has no glob expansion — a wildcard entry is
// silently dropped and the sub-agent ends up with no MCP tools at all.
export function toolNamesForSource(source: string, ebayToken: string): string[] {
  switch (source) {
    case 'ebay':
      return [
        ...(ebayToken ? mcpToolNames('ebay-search', EBAY_SEARCH_TOOLS) : []),
        ...(process.env.EBAY_CLIENT_ID ? mcpToolNames('ebay-api', EBAY_API_TOOLS) : []),
      ];
    case 'autotrader':
      return mcpToolNames('autotrader-search', AUTOTRADER_SEARCH_TOOLS);
    default:
      return [];
  }
}

// No Bash: evaluators must write through the deal-hunter-db MCP tools (record_evaluation etc.),
// which carry the requirement-check validation and hunt_offers status transitions. A shell would
// reopen the raw-sqlite bypass that left skip decisions mis-filed as 'evaluated'.
const BASE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'];

/** Assemble one evaluator agent definition from vertical caps (shared by DB and fallback paths). */
function evaluatorFromCaps(v: VerticalCaps & { agent: NonNullable<VerticalCaps['agent']> }, ebayToken: string): AgentDefinition {
  const servers: string[] = ['deal-hunter-db'];
  const tools: string[] = [...BASE_TOOLS, ...mcpToolNames('deal-hunter-db', DEAL_HUNTER_DB_TOOLS)];
  for (const source of v.sources ?? []) {
    for (const name of toolNamesForSource(source, ebayToken)) {
      if (!tools.includes(name)) tools.push(name);
    }
    for (const srv of mcpServersForSource(source, ebayToken)) {
      if (!servers.includes(srv)) servers.push(srv);
    }
  }
  return {
    description: v.agent.description,
    prompt: v.agent.prompt,
    tools,
    model: EVALUATOR_MODEL,
    skills: [v.evaluator_skill],
    mcpServers: servers,
  };
}

/**
 * Hand-defined fallback caps for the known verticals, used when the DB `verticals` table is
 * missing or unpopulated (e.g. the watcher hasn't run yet). Evaluation is delegation-only —
 * the orchestrator has no batch-triage tools — so an evaluator MUST exist for every vertical
 * or new-offer triage fails outright. These mirror the `agent` blocks in config/verticals.yml;
 * the DB-driven definitions win whenever they load. Keep the names in sync with verticals.yml.
 */
const FALLBACK_VERTICAL_CAPS: Array<VerticalCaps & { agent: NonNullable<VerticalCaps['agent']> }> = [
  {
    name: 'computers',
    evaluator_skill: 'listing-evaluation',
    sourcing_skill: 'ebay-sourcing',
    sources: ['ebay'],
    agent: {
      name: 'deal-evaluator',
      description:
        'Evaluates listings for the computers vertical (eBay-sourced). Delegate to this agent to evaluate offers, check a listing, or assess deal value for computer hardware. Returns a concise evaluation summary to relay to the user. (Fallback definition — verticals table was unavailable.)',
      prompt: `You are a deal evaluation specialist. Follow the listing-evaluation skill instructions precisely.

Key rules:
- Do NOT message the user directly — you have no access to the nanoclaw MCP
- Return a concise summary (under 500 words) of your evaluation findings
- Include: what you evaluated, decisions (ALERT/WATCH/SKIP with reasons), and any market observations
- Record all evaluations to the database before returning
- If you encounter products you cannot evaluate, note the gap`,
    },
  },
  {
    name: 'cars',
    evaluator_skill: 'car-listing-evaluation',
    sourcing_skill: 'cars-sourcing',
    sources: ['autotrader'],
    agent: {
      name: 'cars-evaluator',
      description:
        'Evaluates car listings (cars vertical). Use for hunts where vertical=cars. Returns a concise evaluation summary including price-tier signal, mileage/spec assessment, and comp comparison. (Fallback definition — verticals table was unavailable.)',
      prompt: `You are a car deal evaluation specialist. Follow the car-listing-evaluation skill instructions precisely.

Key rules:
- Do NOT message the user directly — you have no access to the nanoclaw MCP
- Return a concise summary (under 500 words) of your evaluation findings
- Include: what you evaluated, decisions (ALERT/WATCH/SKIP with reasons), price-tier signals used, and any notable patterns
- Record all evaluations to the database before returning
- For alerts, compose the cars notification format string yourself and pass it as record_alert's message_sent (there is no downstream formatter on the agent path)`,
    },
  },
];

/**
 * Build one evaluator sub-agent per vertical that declares an `agent` block. Each gets the
 * vertical's evaluator skill plus the tools/servers its sources require.
 *
 * Resilience: if the DB yields nothing (or is missing a known vertical's evaluator), the
 * hand-defined fallbacks fill the gaps so delegation never silently loses its target agents.
 */
export function buildEvaluatorAgents(
  ebayToken: string,
  dbPath: string = DEAL_HUNTER_DB_PATH,
): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {};
  for (const v of loadVerticalCaps(dbPath)) {
    if (!v.agent) continue;
    out[v.agent.name] = evaluatorFromCaps(v as VerticalCaps & { agent: NonNullable<VerticalCaps['agent']> }, ebayToken);
  }
  for (const fallback of FALLBACK_VERTICAL_CAPS) {
    if (!out[fallback.agent.name]) {
      console.error(
        `[vertical-agents] evaluator "${fallback.agent.name}" missing from DB-driven verticals — using hand-defined fallback`,
      );
      out[fallback.agent.name] = evaluatorFromCaps(fallback, ebayToken);
    }
  }
  return out;
}
