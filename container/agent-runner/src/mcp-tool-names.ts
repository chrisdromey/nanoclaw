/**
 * Canonical MCP tool-name lists for every server referenced by sub-agent definitions.
 *
 * AgentDefinition.tools is matched by EXACT tool name — the CLI does not expand
 * `mcp__server__*` globs there (they are silently dropped, leaving the sub-agent with no
 * MCP tools at all). Every agent definition must therefore list exact names, built from
 * these constants via mcpToolNames(). Globs remain fine in the main session's
 * allowedTools, which uses permission-rule syntax.
 *
 * Kept in lockstep with the server.tool() registrations in each *-mcp.ts file —
 * src/mcp-tool-names.test.ts (root vitest suite) fails if they drift.
 */

export const DEAL_HUNTER_DB_TOOLS = [
  'list_verticals',
  'get_vertical',
  'manage_hunt',
  'get_hunt',
  'get_hunt_summary',
  'mark_hunt_reviewed',
  'get_market_overview',
  'record_offer',
  'update_offer',
  'list_offers',
  'get_offer',
  'get_offer_history',
  'record_evaluation',
  'batch_dismiss',
  'record_alert',
  'record_alert_response',
  'get_prices',
  'record_search',
  'search_evaluations',
  'create_market_segment',
  'record_baseline_price',
  'get_baseline_summary',
  'log_hunt_run',
  'get_hunt_history',
  'recompute_segment_prices',
  'record_kb_coverage',
  'record_claim_verification',
  'waive_must_have',
] as const;

export const AUTOTRADER_SEARCH_TOOLS = ['autotrader_search', 'autotrader_detail'] as const;

export const EBAY_SEARCH_TOOLS = ['search_ebay'] as const;

export const SOLD_DATA_TOOLS = ['get_sold_prices'] as const;

// ebay-api is the external @ebay/npm-public-api-mcp package (launched via
// container/ebay-mcp-wrapper.sh), so its tool set can't be enumerated from this repo.
// These are the tools the skills actually direct agents to use (ebay-sourcing and
// listing-evaluation SKILL.md); extend if an agent reports a missing ebay-api tool.
export const EBAY_API_TOOLS = ['search', 'getItem'] as const;

export function mcpToolNames(server: string, tools: readonly string[]): string[] {
  return tools.map((t) => `mcp__${server}__${t}`);
}
