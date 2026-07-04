/**
 * Deal Hunter — Agent SDK hooks (behavioural guard for the activation gate)
 *
 * These complement the hard server-side gate in deal-hunter-mcp.ts (action:activate). They make
 * the agent get it right by default rather than discovering the rejection after the fact:
 *
 *  - PreToolUse (manage_hunt): when the agent tries to activate/resume a hunt that won't pass the
 *    gate, deny early with a precise reason instead of letting the tool return an error.
 *  - Stop: when the agent tries to finish a session in which it created a hunt that never reached
 *    'active' (still draft — no baseline / invalid criteria), block once and tell it to finish.
 *
 * Both reuse the shared gate (deal-hunter-gate.ts) against a read-only DB connection.
 */

import fs from 'fs';
import Database from 'better-sqlite3';
import type { HookCallback, PreToolUseHookInput, StopHookInput } from '@anthropic-ai/claude-agent-sdk';
import { DEAL_HUNTER_DB_PATH } from './vertical-agents.js';
import { evaluateActivationGate, type HuntRow } from './deal-hunter-gate.js';

const MANAGE_HUNT_TOOL = 'mcp__deal-hunter-db__manage_hunt';

function openRead(): Database.Database | null {
  try {
    return new Database(DEAL_HUNTER_DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function loadHunt(db: Database.Database, huntId: number): HuntRow | undefined {
  return db.prepare('SELECT id, criteria, vertical, status, search_terms FROM hunts WHERE id = ?').get(huntId) as
    | HuntRow
    | undefined;
}

/**
 * PreToolUse hook: deny manage_hunt activate/resume early if the activation gate won't pass,
 * surfacing exactly what's missing. The MCP server enforces the same gate authoritatively.
 */
export function createManageHuntGateHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name !== MANAGE_HUNT_TOOL) return {};
    const ti = pre.tool_input as { action?: string; hunt_id?: number } | undefined;
    if (!ti || (ti.action !== 'activate' && ti.action !== 'resume')) return {};
    if (typeof ti.hunt_id !== 'number') return {};

    const db = openRead();
    if (!db) return {};
    try {
      const hunt = loadHunt(db, ti.hunt_id);
      if (!hunt) return {};
      const gate = evaluateActivationGate(db, hunt);
      if (gate.ok) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason:
            `Hunt ${hunt.id} can't be ${ti.action}d yet — activation gate not satisfied:\n- ${gate.errors.join('\n- ')}\n\n` +
            'Fix the criteria (manage_hunt action:update) and/or record market segments (/price-baselining), then retry.',
        },
      };
    } finally {
      db.close();
    }
  };
}

// Extract the hunt id from a manage_hunt create tool_result (its text is the JSON we returned).
function extractHuntId(resultContent: unknown): number | null {
  let text = '';
  if (typeof resultContent === 'string') text = resultContent;
  else if (Array.isArray(resultContent)) {
    text = resultContent
      .map((c) => (c && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('');
  }
  if (!text) return null;
  try {
    const obj = JSON.parse(text) as { hunt?: { id?: unknown } };
    return typeof obj?.hunt?.id === 'number' ? obj.hunt.id : null;
  } catch {
    return null;
  }
}

// Scan the JSONL transcript for hunts created by manage_hunt action:create this session.
function findCreatedHuntIds(content: string): number[] {
  const createToolUseIds = new Set<string>();
  const huntIds = new Set<number>();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;
    if (entry.type === 'assistant') {
      for (const block of blocks as Array<Record<string, unknown>>) {
        if (
          block?.type === 'tool_use' &&
          block?.name === MANAGE_HUNT_TOOL &&
          (block?.input as { action?: string } | undefined)?.action === 'create' &&
          typeof block?.id === 'string'
        ) {
          createToolUseIds.add(block.id as string);
        }
      }
    } else if (entry.type === 'user') {
      for (const block of blocks as Array<Record<string, unknown>>) {
        if (block?.type === 'tool_result' && createToolUseIds.has(block?.tool_use_id as string)) {
          const id = extractHuntId(block.content);
          if (id != null) huntIds.add(id);
        }
      }
    }
  }
  return [...huntIds];
}

/**
 * Stop hook: if the agent created a hunt this session that never reached 'active' (still a draft
 * with no baseline / invalid criteria), block the stop once with guidance. stop_hook_active
 * guards against loops — we nudge at most once.
 */
export function createDraftGuardStopHook(): HookCallback {
  return async (input) => {
    const stop = input as StopHookInput;
    if (stop.stop_hook_active) return {};
    const transcriptPath = stop.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};

    let createdHuntIds: number[];
    try {
      createdHuntIds = findCreatedHuntIds(fs.readFileSync(transcriptPath, 'utf-8'));
    } catch {
      return {};
    }
    if (createdHuntIds.length === 0) return {};

    const db = openRead();
    if (!db) return {};
    try {
      const problems: string[] = [];
      for (const id of createdHuntIds) {
        const hunt = loadHunt(db, id);
        if (!hunt) continue;
        // active = done; closed = deliberately abandoned. Anything else is an unfinished draft.
        if (hunt.status === 'active' || hunt.status === 'closed') continue;
        const gate = evaluateActivationGate(db, hunt);
        problems.push(`Hunt ${hunt.id} is still '${hunt.status}':\n    - ${gate.errors.join('\n    - ')}`);
      }
      if (problems.length === 0) return {};
      const plural = problems.length > 1;
      return {
        decision: 'block' as const,
        reason:
          `You created ${plural ? 'hunts' : 'a hunt'} this session that ${plural ? 'are' : 'is'} not yet monitored. ` +
          'A hunt only starts working once you record market segments (/price-baselining) and call ' +
          `manage_hunt action:activate. Finish ${plural ? 'them' : 'it'}:\n\n${problems.join('\n\n')}`,
      };
    } finally {
      db.close();
    }
  };
}

// ============================================================
// Triage delegation gate
// ============================================================

/**
 * Batch-triage tools that must only run inside evaluator sub-agents, never in the
 * orchestrator's long-lived main context (inline triage was the dominant token sink
 * in the Jun 2026 burn incident). Single-offer lookups (get_offer, get_offer_history)
 * stay orchestrator-accessible and are deliberately NOT listed here.
 */
const ORCHESTRATOR_FORBIDDEN_TOOLS = new Set([
  'mcp__deal-hunter-db__get_hunt_summary',
  'mcp__deal-hunter-db__list_offers',
  'mcp__deal-hunter-db__record_evaluation',
  'mcp__deal-hunter-db__batch_dismiss',
  'mcp__deal-hunter-db__update_offer',
]);
const ORCHESTRATOR_FORBIDDEN_PREFIXES = ['mcp__autotrader-search__'];

/**
 * PreToolUse hook: HARD enforcement of evaluator-sub-agent delegation.
 *
 * Why a hook and not the allowedTools list: under permissionMode 'bypassPermissions'
 * the SDK's allowedTools only controls auto-approval, not availability — every MCP tool
 * remains callable. This hook is the actual enforcement: it denies the batch-triage
 * tools on the MAIN thread while letting sub-agents through (BaseHookInput.agent_id is
 * present only when a hook fires from within a sub-agent).
 */
export function createTriageDelegationGateHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    if (pre.hook_event_name !== 'PreToolUse') return {};
    // Sub-agent call → allowed (that's where triage is supposed to run).
    if (pre.agent_id) return {};
    const name = pre.tool_name;
    const forbidden =
      ORCHESTRATOR_FORBIDDEN_TOOLS.has(name) ||
      ORCHESTRATOR_FORBIDDEN_PREFIXES.some((p) => name.startsWith(p));
    if (!forbidden) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason:
          `${name} is a batch-triage tool and is not available in the main session — offer evaluation must run ` +
          "inside an evaluator sub-agent so its context is discarded when it returns. Spawn the hunt's evaluator " +
          '(cars → "cars-evaluator", computers → "deal-evaluator", otherwise "generic-deal-evaluator") via the ' +
          'Task/Agent tool with the hunt id and offer count, then relay its compact summary. ' +
          'For a single-offer question use get_offer / get_offer_history instead.',
      },
    };
  };
}
