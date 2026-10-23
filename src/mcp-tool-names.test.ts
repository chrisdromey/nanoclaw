/**
 * Drift guard for container/agent-runner/src/mcp-tool-names.ts.
 *
 * AgentDefinition.tools is matched by exact tool name — the CLI silently drops
 * `mcp__server__*` globs, leaving sub-agents with no MCP tools (the Jun 28 → Jul 8
 * evaluator outage). Agent definitions therefore list exact names from mcp-tool-names.ts;
 * these tests fail if that file drifts from the actual server.tool() registrations, or if
 * a glob sneaks back into an agent definition.
 *
 * Sources are parsed as text (no cross-package imports — agent-runner is its own package).
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const AGENT_RUNNER_SRC = path.join(__dirname, '..', 'container', 'agent-runner', 'src');

function read(file: string): string {
  return fs.readFileSync(path.join(AGENT_RUNNER_SRC, file), 'utf8');
}

/** Tool names registered via server.tool('name', ...) — name on the line after the call. */
function registeredToolNames(mcpSource: string): string[] {
  return [...mcpSource.matchAll(/server\.tool\(\s*'([A-Za-z_]+)'/g)].map((m) => m[1]);
}

/** Parse an exported const string-array literal out of mcp-tool-names.ts. */
function declaredToolNames(constantsSource: string, exportName: string): string[] {
  const m = constantsSource.match(
    new RegExp(`export const ${exportName} = \\[([^\\]]*)\\]`, 's'),
  );
  if (!m) throw new Error(`export const ${exportName} not found in mcp-tool-names.ts`);
  return [...m[1].matchAll(/'([A-Za-z_]+)'/g)].map((x) => x[1]);
}

describe('mcp-tool-names.ts stays in lockstep with MCP server registrations', () => {
  const constants = read('mcp-tool-names.ts');

  const cases: Array<{ exportName: string; mcpFile: string }> = [
    { exportName: 'DEAL_HUNTER_DB_TOOLS', mcpFile: 'deal-hunter-mcp.ts' },
    { exportName: 'AUTOTRADER_SEARCH_TOOLS', mcpFile: 'autotrader-search-mcp.ts' },
    { exportName: 'EBAY_SEARCH_TOOLS', mcpFile: 'ebay-search-mcp.ts' },
    { exportName: 'SOLD_DATA_TOOLS', mcpFile: 'sold-data-mcp.ts' },
  ];

  for (const { exportName, mcpFile } of cases) {
    it(`${exportName} matches server.tool() calls in ${mcpFile}`, () => {
      const registered = registeredToolNames(read(mcpFile));
      expect(registered.length).toBeGreaterThan(0);
      expect([...declaredToolNames(constants, exportName)].sort()).toEqual(
        [...registered].sort(),
      );
    });
  }

  // EBAY_API_TOOLS covers an external server (@ebay/npm-public-api-mcp) — nothing to
  // parse locally, but it must exist and be non-empty.
  it('EBAY_API_TOOLS is declared and non-empty', () => {
    expect(declaredToolNames(constants, 'EBAY_API_TOOLS').length).toBeGreaterThan(0);
  });
});

describe('no MCP globs in AgentDefinition tool lists', () => {
  it('vertical-agents.ts contains no mcp__…__* glob', () => {
    expect(read('vertical-agents.ts')).not.toMatch(/mcp__[\w-]+__\*/);
  });

  it("index.ts only uses mcp__…__* globs inside the main session's allowedTools", () => {
    const src = read('index.ts');
    // Globs are permission-rule syntax, valid only in the allowedTools array. Everything
    // from the start of the agents block onward (AgentDefinitions) must be glob-free.
    const agentsBlock = src.slice(src.indexOf('agents: {'));
    expect(agentsBlock.length).toBeGreaterThan(0);
    expect(agentsBlock).not.toMatch(/mcp__[\w-]+__\*/);
  });
});
