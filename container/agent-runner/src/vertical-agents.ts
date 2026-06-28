/**
 * Builds per-vertical evaluator sub-agents from the vertical capabilities the watcher mirrors
 * into the deal-hunter DB. A vertical that declares an `agent` block in config/verticals.yml
 * gets an evaluator sub-agent here with no code change; its tools/mcpServers are derived from
 * the vertical's `sources`. Verticals without an `agent` block fall back to the hand-defined
 * generic-deal-evaluator.
 */

import Database from 'better-sqlite3';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

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
 */
export function loadVerticalCaps(dbPath: string = DEAL_HUNTER_DB_PATH): VerticalCaps[] {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verticals'")
        .get();
      if (!hasTable) return [];
      const rows = db.prepare('SELECT config_json FROM verticals').all() as Array<{ config_json: string }>;
      const out: VerticalCaps[] = [];
      for (const r of rows) {
        try {
          out.push(JSON.parse(r.config_json) as VerticalCaps);
        } catch {
          // skip malformed row
        }
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
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

export function toolGlobsForSource(source: string, ebayToken: string): string[] {
  switch (source) {
    case 'ebay':
      return [
        ...(ebayToken ? ['mcp__ebay-search__*'] : []),
        ...(process.env.EBAY_CLIENT_ID ? ['mcp__ebay-api__*'] : []),
      ];
    case 'autotrader':
      return ['mcp__autotrader-search__*'];
    default:
      return [];
  }
}

/**
 * Build one evaluator sub-agent per vertical that declares an `agent` block. Each gets the
 * vertical's evaluator skill plus the tools/servers its sources require.
 */
export function buildEvaluatorAgents(
  ebayToken: string,
  dbPath: string = DEAL_HUNTER_DB_PATH,
): Record<string, AgentDefinition> {
  const baseTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'];
  const out: Record<string, AgentDefinition> = {};
  for (const v of loadVerticalCaps(dbPath)) {
    if (!v.agent) continue;
    const servers: string[] = ['deal-hunter-db'];
    const tools: string[] = [...baseTools, 'mcp__deal-hunter-db__*'];
    for (const source of v.sources ?? []) {
      for (const glob of toolGlobsForSource(source, ebayToken)) {
        if (!tools.includes(glob)) tools.push(glob);
      }
      for (const srv of mcpServersForSource(source, ebayToken)) {
        if (!servers.includes(srv)) servers.push(srv);
      }
    }
    out[v.agent.name] = {
      description: v.agent.description,
      prompt: v.agent.prompt,
      tools,
      model: 'sonnet',
      skills: [v.evaluator_skill],
      mcpServers: servers,
    };
  }
  return out;
}
