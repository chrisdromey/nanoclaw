/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { buildEvaluatorAgents } from './vertical-agents.js';
import { MODEL, EVALUATOR_MODEL } from './models.js';
import {
  AUTOTRADER_SEARCH_TOOLS,
  DEAL_HUNTER_DB_TOOLS,
  EBAY_API_TOOLS,
  EBAY_SEARCH_TOOLS,
  SOLD_DATA_TOOLS,
  mcpToolNames,
} from './mcp-tool-names.js';
import { createManageHuntGateHook, createDraftGuardStopHook, createTriageDelegationGateHook } from './deal-hunter-hooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deal Hunter spend accounting: one row per SDK result message, written straight into the
// group's deal-hunter.db (present only for the deal-hunter group; silently skipped elsewhere).
// The watcher's ensureSchema() owns the agent_runs table.
const DEAL_HUNTER_DB = '/workspace/group/deal-hunter.db';
interface AgentRunRow {
  session_id: string | undefined;
  prompt_head: string;
  models: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number | undefined;
  num_turns: number | undefined;
}
function recordAgentRun(row: AgentRunRow): void {
  if (!fs.existsSync(DEAL_HUNTER_DB)) return;
  try {
    const db = new Database(DEAL_HUNTER_DB);
    try {
      db.pragma('busy_timeout = 5000');
      db.prepare(`INSERT INTO agent_runs
        (session_id, prompt_head, models, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, duration_ms, num_turns)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.session_id ?? null, row.prompt_head, row.models, row.input_tokens, row.cache_read_tokens,
        row.cache_write_tokens, row.output_tokens, row.cost_usd, row.duration_ms ?? null, row.num_turns ?? null,
      );
    } finally {
      db.close();
    }
  } catch (err) {
    log(`agent_runs insert failed (non-fatal): ${err}`);
  }
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
// 100K (was 150K): long-lived sessions re-write their whole context to cache every turn,
// so cost grows with context size × turn count — compact earlier to keep the ceiling down.
const COMPACT_THRESHOLD_TOKENS = parseInt(process.env.COMPACT_THRESHOLD_TOKENS || '100000', 10);

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Fetch an eBay OAuth application token using client credentials.
 * Returns the access_token string, or empty string on failure.
 */
async function fetchEbayToken(clientId: string, clientSecret: string): Promise<string> {
  try {
    const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    });
    if (!resp.ok) {
      log(`eBay OAuth failed: ${resp.status} ${resp.statusText}`);
      return '';
    }
    const data = await resp.json() as { access_token?: string };
    return data.access_token || '';
  } catch (err) {
    log(`eBay OAuth error: ${err}`);
    return '';
  }
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);
  let lastPromptHead = prompt.slice(0, 200);
  // Cumulative totals seen on the previous result message; agent_runs stores per-result deltas.
  const prevTotals = { cost: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      lastPromptHead = text.slice(0, 200);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let cumulativeInputTokens = 0;
  let compactRequested = false;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  const feedbackInstructions = `
## Feedback on tools & systems

Surface problems instead of working around them silently. If you hit any of these, tell the user in the same response:

- A tool errors, returns unexpected results, or behaves inconsistently with its documentation
- A skill's workflow doesn't match how the tools actually behave
- You're missing context, reference data, or a tool/capability that would help you do a better job
- You have an idea for improving the workflow or user experience

If something fails, say so — don't retry silently. Say what went wrong and what you're trying next.`;

  const systemPromptAppend = globalClaudeMd
    ? `${globalClaudeMd}\n${feedbackInstructions}`
    : feedbackInstructions;

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Fetch eBay OAuth token for the custom search MCP (if credentials are available)
  let ebayAccessToken = '';
  if (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET) {
    ebayAccessToken = await fetchEbayToken(process.env.EBAY_CLIENT_ID, process.env.EBAY_CLIENT_SECRET);
    if (ebayAccessToken) {
      log('eBay OAuth token fetched for ebay-search MCP');
    }
  }

  // Per-vertical evaluator sub-agents, built from the verticals the watcher mirrored into the
  // DB. Adding a vertical with an `agent` block in config/verticals.yml adds its evaluator here
  // with no code change. market-researcher and generic-deal-evaluator stay hand-defined below.
  const evaluatorAgents = buildEvaluatorAgents(ebayAccessToken);
  if (Object.keys(evaluatorAgents).length === 0) {
    // Should be unreachable (buildEvaluatorAgents merges hand-defined fallbacks), but if it
    // ever happens, delegation-only evaluation has no target agents and triage will fail.
    log('ERROR: no evaluator agents registered — new-offer triage will fail (delegation-only, no inline fallback)');
  } else {
    log(`Built ${Object.keys(evaluatorAgents).length} vertical evaluator agents: ${Object.keys(evaluatorAgents).join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      // Orchestrator runs on sonnet: it routes/dispatches and handles interactive chat, while the
      // judgment-heavy work is delegated to sub-agents (also sonnet). Opus isn't needed for routing.
      model: MODEL,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend },
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'Agent',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        // Orchestrator tool scoping (reduce tool bloat AND context bloat):
        // - eBay tools (ebay-api/ebay-search/sold-data): kept because orchestrator-level
        //   skills run them INLINE — requirements-discovery & hunt-management do eBay market
        //   recon via ebay-search; /research uses ebay-api/ebay-search/sold-data directly.
        // - autotrader-search: NOT exposed here. Every cars workflow is delegated to a scoped
        //   sub-agent (cars-evaluator, market-researcher), so the orchestrator never calls it
        //   directly. The server is still defined in mcpServers below so those sub-agents can
        //   reference it by name.
        // - deal-hunter-db: explicit subset, NOT the wildcard. Batch-triage tools
        //   (get_hunt_summary, list_offers, record_evaluation, batch_dismiss, update_offer)
        //   are deliberately absent: offer evaluation must run inside evaluator sub-agents
        //   (which grant the full deal-hunter-db tool set themselves), never in this long-lived main
        //   context — inline triage was the biggest token sink in the Jun 2026 burn incident.
        //   Single-item deep dives (get_offer, get_offer_history) stay available here for
        //   interactive chat; they're bounded, unlike batch scans.
        'mcp__ebay-api__*',
        'mcp__ebay-search__*',
        'mcp__sold-data__*',
        // hunt lifecycle + dispatch
        'mcp__deal-hunter-db__list_verticals',
        'mcp__deal-hunter-db__get_vertical',
        'mcp__deal-hunter-db__manage_hunt',
        'mcp__deal-hunter-db__get_hunt',
        'mcp__deal-hunter-db__mark_hunt_reviewed',
        'mcp__deal-hunter-db__log_hunt_run',
        'mcp__deal-hunter-db__get_hunt_history',
        // bounded single-item lookups (progressive disclosure, not batch triage)
        'mcp__deal-hunter-db__record_offer',
        'mcp__deal-hunter-db__get_offer',
        'mcp__deal-hunter-db__get_offer_history',
        // alerts + market context
        'mcp__deal-hunter-db__record_alert',
        'mcp__deal-hunter-db__record_alert_response',
        'mcp__deal-hunter-db__get_market_overview',
        'mcp__deal-hunter-db__get_prices',
        'mcp__deal-hunter-db__record_search',
        'mcp__deal-hunter-db__search_evaluations',
        // baselining + provenance gate
        'mcp__deal-hunter-db__create_market_segment',
        'mcp__deal-hunter-db__record_baseline_price',
        'mcp__deal-hunter-db__get_baseline_summary',
        'mcp__deal-hunter-db__recompute_segment_prices',
        'mcp__deal-hunter-db__record_kb_coverage',
        'mcp__deal-hunter-db__record_claim_verification',
        'mcp__deal-hunter-db__waive_must_have',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        ...(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET ? {
          'ebay-api': {
            command: '/usr/local/bin/ebay-mcp-wrapper.sh',
            env: {
              EBAY_CLIENT_ID: process.env.EBAY_CLIENT_ID,
              EBAY_CLIENT_SECRET: process.env.EBAY_CLIENT_SECRET,
            },
          },
          ...(ebayAccessToken ? {
            'ebay-search': {
              command: 'node',
              args: [path.join(__dirname, 'ebay-search-mcp.js')],
              env: {
                EBAY_ACCESS_TOKEN: ebayAccessToken,
              },
            },
          } : {}),
        } : {}),
        'deal-hunter-db': {
          command: 'node',
          args: [path.join(__dirname, 'deal-hunter-mcp.js')],
          env: {
            DEAL_HUNTER_DB_PATH: '/workspace/group/deal-hunter.db',
          },
        },
        'sold-data': {
          command: 'node',
          args: [path.join(__dirname, 'sold-data-mcp.js')],
        },
        // Cars vertical source. Defined here (not in the orchestrator's allowedTools) so the
        // scoped sub-agents — cars-evaluator and market-researcher — can reference it by name.
        // The runtime JS file is only loaded when a cars hunt actually runs.
        'autotrader-search': {
          command: 'node',
          args: [path.join(__dirname, 'autotrader-search-mcp.js')],
        },
      },
      agents: {
        // Per-vertical evaluators (deal-evaluator, cars-evaluator, …) are built from
        // config/verticals.yml — see buildEvaluatorAgents. market-researcher and
        // generic-deal-evaluator are cross-vertical, so they stay hand-defined here.
        ...evaluatorAgents,
        'market-researcher': {
          description: 'Researches market pricing and builds product knowledge for a hunt, recording market segments and baseline prices to the database. Delegate for price baselining, market analysis, building a product/trim knowledge base, or refreshing a stale baseline (>14 days).',
          prompt: `You are a market research specialist serving every vertical.

Resolve the hunt's vertical with get_vertical, then follow the price-baselining skill — it directs you to the vertical's sourcing skill for how to gather comparables, and you record segments and baseline prices the same way for every vertical. When a feature-led hunt needs product/trim knowledge that doesn't exist yet, build it via the knowledge-building skill the sourcing skill points you to.

Key rules:
- Do NOT message the user directly — you have no access to the nanoclaw MCP
- Return a concise summary (under 500 words) of your research findings
- Include: search terms used, segments identified, price ranges found, and any market observations
- Record all structured data (market segments, baseline prices) to the database before returning
- For a feature-led hunt, bucketing comes BEFORE pricing: read/build the per-model knowledge base first, then define segments from its trim ladder, record sourced comps (with source_url, source_item_id and trim tags) into each, and call recompute_segment_prices to DERIVE the band — never type prices. After writing each KB file, call record_kb_coverage so the activation gate can see it.
- Do NOT activate a feature-led hunt yourself before its must-have features have been independently verified — that is the musthave-verifier's job (the gate will block otherwise)
- Write prose findings to the hunt file (and knowledge-base files) as the skills instruct`,
          tools: [
            // No Bash: all DB writes go through the deal-hunter-db MCP tools (raw-sqlite bypass
            // is closed for every deal-hunter sub-agent); files are covered by Read/Write/Edit.
            // Exact MCP tool names only — AgentDefinition.tools silently drops globs.
            'Read', 'Write', 'Edit', 'Glob', 'Grep',
            'WebSearch', 'WebFetch',
            'TodoWrite',
            ...mcpToolNames('deal-hunter-db', DEAL_HUNTER_DB_TOOLS),
            ...mcpToolNames('sold-data', SOLD_DATA_TOOLS),
            // Cross-vertical researcher: needs every source's search tools for baselining.
            ...mcpToolNames('autotrader-search', AUTOTRADER_SEARCH_TOOLS),
            ...(ebayAccessToken ? mcpToolNames('ebay-search', EBAY_SEARCH_TOOLS) : []),
            ...(process.env.EBAY_CLIENT_ID ? mcpToolNames('ebay-api', EBAY_API_TOOLS) : []),
          ],
          model: EVALUATOR_MODEL,
          skills: ['price-baselining', 'ebay-sourcing', 'cars-sourcing', 'car-spec-research'],
          mcpServers: [
            'deal-hunter-db',
            'sold-data',
            'autotrader-search',
            ...(ebayAccessToken ? ['ebay-search'] : []),
            ...(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET ? ['ebay-api'] : []),
          ],
        },
        'musthave-verifier': {
          description: "Adversarially verifies a feature-led hunt's must-have features for each target model BEFORE activation, from independently re-fetched primary sources (not the hunt's own knowledge base). Delegate when a feature-led hunt is ready to activate, or to re-check a contradicted/unverified must-have. Records a verdict per (target, must-have) so the activation gate can pass.",
          prompt: `You are an adversarial spec verifier. Your job is to CONFIRM OR REFUTE, from primary sources, that each must-have feature is actually available on each target model in the hunt — catching hallucinated or over-stated spec claims before a hunt goes live.

Process:
1. Read the hunt with get_hunt: take criteria.intent.must_have (the features) and criteria.targets (the models, keyed by search term).
2. For every (target, must-have) pair, independently WebSearch/WebFetch authoritative UK sources (Parkers, manufacturer brochures, What Car?, owner forums). Do NOT trust the hunt's knowledge-base file as ground truth — re-derive it; the whole point is an independent check.
3. Be sceptical and contradiction-seeking. A feature being *standard on all trims* is a stronger claim than *available as an option*. If it's only an optional pack (e.g. Pilot Assist on the Polestar 2 Pilot Pack), the claim "standard" is CONTRADICTED.
4. Record each verdict with record_claim_verification (verified / unverified / contradicted) plus the evidence_url and a short note of what the source said.

Key rules:
- Do NOT message the user directly — you have no access to the nanoclaw MCP
- Verify every (target × must-have) pair — partial coverage leaves the gate blocked
- Prefer 'unverified' over a guess when sources are silent or conflicting; never invent a verdict
- Return a concise summary (under 500 words): per target, which must-haves verified / unverified / contradicted, with the key evidence`,
          tools: [
            'Read', 'Glob', 'Grep',
            'WebSearch', 'WebFetch',
            'TodoWrite',
            ...mcpToolNames('deal-hunter-db', DEAL_HUNTER_DB_TOOLS),
          ],
          model: EVALUATOR_MODEL,
          skills: ['musthave-verification'],
          mcpServers: ['deal-hunter-db'],
        },
        'generic-deal-evaluator': {
          description: 'Default deal evaluator for verticals without a bespoke skill. Use as fallback for T1 verticals (cookers, AC units, generic categories) where no vertical-specific evaluator exists.',
          prompt: `You are a general-purpose deal evaluation specialist. Follow the generic-deal-evaluator skill instructions precisely.

Key rules:
- Do NOT message the user directly — you have no access to the nanoclaw MCP
- Return a concise summary (under 500 words) of your evaluation findings
- Include: what you evaluated, decisions (ALERT/WATCH/SKIP with reasons), comp baseline used, and any market observations
- Record all evaluations to the database before returning
- Keep notification format source-agnostic (no eBay-specific language)`,
          tools: [
            'Read', 'Write', 'Edit', 'Glob', 'Grep',
            'TodoWrite',
            ...mcpToolNames('deal-hunter-db', DEAL_HUNTER_DB_TOOLS),
            ...mcpToolNames('sold-data', SOLD_DATA_TOOLS),
          ],
          // Same model as the other evaluators (was haiku; owner wants evaluation quality).
          model: EVALUATOR_MODEL,
          skills: ['generic-deal-evaluator'],
          mcpServers: [
            'deal-hunter-db',
            'sold-data',
          ],
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
        // Deal Hunter activation gate (behavioural): deny premature activate/resume early, and
        // block finishing a session that left a freshly-created hunt as an un-baselined draft.
        PreToolUse: [
          { matcher: 'mcp__deal-hunter-db__manage_hunt', hooks: [createManageHuntGateHook()] },
          // HARD delegation enforcement: allowedTools does NOT restrict availability under
          // bypassPermissions (it only controls auto-approval), so this hook is what actually
          // blocks batch-triage tools on the main thread. Sub-agent calls pass through
          // (BaseHookInput.agent_id present). No matcher — the hook filters by tool name.
          { hooks: [createTriageDelegationGateHook()] },
        ],
        Stop: [{ hooks: [createDraftGuardStopHook()] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
      const compactMsg = message as { compact_metadata?: { pre_tokens?: number } };
      log(`Compact boundary: pre_tokens=${compactMsg.compact_metadata?.pre_tokens ?? 'unknown'}`);
      cumulativeInputTokens = 0;
      compactRequested = false;
    }

    if (message.type === 'result') {
      resultCount++;

      // Track cumulative input tokens for auto-compact
      const resultMsg = message as { modelUsage?: Record<string, { inputTokens?: number }> };
      if (resultMsg.modelUsage) {
        for (const usage of Object.values(resultMsg.modelUsage)) {
          cumulativeInputTokens += usage.inputTokens || 0;
        }
      }
      if (cumulativeInputTokens > COMPACT_THRESHOLD_TOKENS && !compactRequested) {
        log(`Auto-compact: ${cumulativeInputTokens} input tokens exceed threshold of ${COMPACT_THRESHOLD_TOKENS}`);
        compactRequested = true;
        stream.push('/compact');
      }

      // Spend accounting (Deal Hunter only). modelUsage and total_cost_usd are cumulative for the
      // process, so store the delta since the previous result.
      {
        const r = message as {
          total_cost_usd?: number; duration_ms?: number; num_turns?: number; session_id?: string;
          modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
        };
        const totals = { cost: r.total_cost_usd ?? 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
        for (const u of Object.values(r.modelUsage ?? {})) {
          totals.input += u.inputTokens ?? 0;
          totals.cacheRead += u.cacheReadInputTokens ?? 0;
          totals.cacheWrite += u.cacheCreationInputTokens ?? 0;
          totals.output += u.outputTokens ?? 0;
        }
        recordAgentRun({
          session_id: r.session_id ?? newSessionId,
          prompt_head: lastPromptHead,
          models: Object.keys(r.modelUsage ?? {}).join(','),
          input_tokens: totals.input - prevTotals.input,
          cache_read_tokens: totals.cacheRead - prevTotals.cacheRead,
          cache_write_tokens: totals.cacheWrite - prevTotals.cacheWrite,
          output_tokens: totals.output - prevTotals.output,
          cost_usd: totals.cost - prevTotals.cost,
          duration_ms: r.duration_ms,
          num_turns: r.num_turns,
        });
        Object.assign(prevTotals, totals);
      }

      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
