/**
 * Agent notifier — writes IPC task files to trigger agent invocations.
 *
 * Three notification types:
 * - Urgent: auction countdown, watch condition met (sendUrgentNotification)
 * - New offers: batched per tick across hunts (sendNewOffersNotification)
 * - Price changes: watched offer price moved (sendPriceChangeNotification)
 *
 * Prompts are source-aware (source id in labels) and vertical-aware (evaluator_skill from config).
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { IPC_DIR, CHAT_JID } from './config.js';
import { logger } from './logger.js';
import type { Change } from './change-detector.js';
import { getVertical } from './verticals.js';
import { getFormatter } from './formatters/index.js';
import type { FormattableListing } from './formatters/index.js';

function writeIpcTask(taskId: string, prompt: string): void {
  const taskPayload = {
    type: 'schedule_task',
    taskId,
    prompt,
    schedule_type: 'once',
    schedule_value: new Date().toISOString().replace('Z', '').replace(/\.\d+$/, ''),
    targetJid: CHAT_JID,
    context_mode: 'isolated',
  };

  const tasksDir = path.join(IPC_DIR, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, `${randomUUID()}.json`), JSON.stringify(taskPayload));
}

/**
 * Look up the evaluator sub-agent name for a vertical (the `agent.name` block in verticals.yml).
 * Falls back to 'generic-deal-evaluator' (always registered by the agent-runner) if the vertical
 * is missing, has no agent block, or the loader fails.
 */
function resolveEvaluatorAgent(vertical: string): string {
  try {
    const v = getVertical(vertical);
    return v.agent?.name ?? 'generic-deal-evaluator';
  } catch (err) {
    logger.warn({ vertical, err }, 'Could not load vertical config; falling back to generic-deal-evaluator agent');
    return 'generic-deal-evaluator';
  }
}

/**
 * Standard delegation coda for watcher-triggered evaluation prompts.
 * The orchestrator has NO batch-triage tools (get_hunt_summary/list_offers/record_evaluation/
 * batch_dismiss) — evaluation must run inside the named evaluator sub-agent, whose context is
 * discarded when it returns. Keeps the long-lived main context small.
 */
const DELEGATION_RULES = [
  'Do NOT evaluate listings yourself — batch triage tools are not available in this context.',
  'If a named sub-agent is unavailable, report the failure to the user — do not attempt inline evaluation.',
];

function buildUrgentPrompt(huntName: string, changes: Change[], vertical: string): string {
  const lines: string[] = [`Deal Hunter Watcher Alert — Hunt: "${huntName}"`, ''];

  for (const change of changes) {
    switch (change.type) {
      case 'auction_ending':
        lines.push(
          `AUCTION ENDING: "${change.title}" — ${change.details.hoursLeft}h remaining (${change.details.threshold}h threshold), ` +
            `current bid £${change.details.currentBid}, ${change.details.bidCount ?? 0} bids`,
        );
        lines.push(`  ${change.source ?? 'source'} ID: ${change.sourceId}`);
        break;
      case 'watch_condition_met':
        lines.push(
          `WATCH CONDITION MET: "${change.title}" — ${change.details.condition}, ` +
            `current £${change.details.currentPrice} (threshold: £${change.details.threshold})`,
        );
        lines.push(`  ${change.source ?? 'source'} ID: ${change.sourceId}`);
        break;
      default:
        lines.push(`${change.type}: "${change.title}" — ${change.source ?? 'source'} ID: ${change.sourceId}`);
    }
    lines.push('');
  }

  const evaluatorAgent = resolveEvaluatorAgent(vertical);
  lines.push(
    `Spawn the "${evaluatorAgent}" sub-agent (Task tool) to assess the item(s) above — pass it the hunt name and the source IDs listed, ` +
      'and instruct it to review context via get_hunt_summary, evaluate each item, record decisions with record_evaluation, ' +
      'and return a short verdict per item. Relay its verdicts to the user.',
  );
  lines.push(...DELEGATION_RULES);
  return lines.join('\n');
}

/** Urgent notifications: auction countdown thresholds, watch conditions met. */
export function sendUrgentNotification(huntId: number, huntName: string, changes: Change[], vertical: string): void {
  const taskId = `watcher-urgent-${Date.now()}-${randomUUID().slice(0, 8)}`;
  writeIpcTask(taskId, buildUrgentPrompt(huntName, changes, vertical));
  logger.info({ taskId, huntId, changeCount: changes.length }, 'Urgent notification sent via IPC');
}

/** Batched new offer notification — one per tick, lists all hunts with new offers. */
export function sendNewOffersNotification(
  huntSummaries: Array<{
    huntId: number;
    huntName: string;
    newCount: number;
    hasBaseline: boolean;
    vertical?: string;
    /**
     * Total queued (status='new') offers for this hunt, including backlog beyond
     * this batch. When greater than newCount, the announcement says "X of Y pending"
     * so the agent knows the rest arrives in later batches (and must not go looking).
     */
    pendingCount?: number;
    /** Optional: new listings to preview using the per-vertical formatter. */
    newListings?: FormattableListing[];
  }>,
): void {
  const taskId = `watcher-new-offers-${Date.now()}`;

  const lines = ['Deal Hunter — New offers found', ''];
  for (const h of huntSummaries) {
    const countLabel =
      h.pendingCount && h.pendingCount > h.newCount
        ? `${h.newCount} of ${h.pendingCount} pending new offers (rest follows in later batches — triage only these ${h.newCount})`
        : `${h.newCount} new offer${h.newCount > 1 ? 's' : ''}`;
    lines.push(`• Hunt "${h.huntName}" (ID ${h.huntId}): ${countLabel}`);

    // If a per-vertical formatter is configured and listings are available, render previews.
    if (h.newListings && h.newListings.length > 0) {
      const vertical = h.vertical ?? 'computers';
      let formatterName: string | undefined;
      try {
        const vConf = getVertical(vertical);
        formatterName = vConf.notification_formatter;
      } catch {
        // Vertical not found — skip formatter lookup
      }

      const formatter = formatterName ? getFormatter(formatterName) : undefined;
      if (formatter) {
        for (const listing of h.newListings) {
          try {
            lines.push(`  → ${formatter(listing)}`);
          } catch {
            // Formatter threw — fall back to generic line
            lines.push(`  → ${listing.title} £${listing.priceGbp ?? '?'} ${listing.url}`);
          }
        }
      }
    }
  }

  const unbaselined = huntSummaries.filter((h) => !h.hasBaseline);
  if (unbaselined.length > 0) {
    lines.push('');
    lines.push('⚠️ BASELINE MISSING — the following hunts have NO market segments:');
    for (const h of unbaselined) {
      lines.push(`  • Hunt "${h.huntName}" (ID ${h.huntId})`);
    }
    lines.push('The dashboard "vs Base" column is broken for these hunts and your evaluations are not grounded in real market data.');
    lines.push('Before evaluating offers, run /price-baselining for each hunt above to create market segments and record baseline prices.');
  }

  lines.push('');

  // Delegation instructions: one evaluator sub-agent per hunt. Evaluation never runs in the
  // orchestrator's own context (see DELEGATION_RULES).
  lines.push('Spawn each hunt\'s evaluator sub-agent with the Task tool (one Task per hunt, in parallel where possible):');
  for (const h of huntSummaries) {
    const agent = resolveEvaluatorAgent(h.vertical ?? 'computers');
    lines.push(`• Hunt ${h.huntId} "${h.huntName}" → agent "${agent}" — triage the ${h.newCount} offers announced above.`);
  }
  lines.push(
    'In each sub-agent prompt include: the hunt id, the offer count to triage, and these instructions — ' +
      'call get_hunt_summary for context, then list_offers (hunt_offer_status=new, oldest first, limit to the announced count), ' +
      'evaluate against the hunt criteria, record every decision with record_evaluation or batch_dismiss, ' +
      'and return a compact summary: alert/watch/dismiss counts plus a one-line reason per ALERT.',
  );
  lines.push(
    'When each sub-agent returns: relay ALERT items to the user (link + price + one-line reason), then call log_hunt_run.',
  );
  lines.push(...DELEGATION_RULES);

  writeIpcTask(taskId, lines.join('\n'));
  logger.info({ taskId, huntCount: huntSummaries.length }, 'New offers notification sent via IPC');
}

/** Price change notification for watched offers. */
export function sendPriceChangeNotification(huntId: number, huntName: string, changes: Change[], vertical: string): void {
  const taskId = `watcher-price-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const lines = [`Deal Hunter — Price change on watched offer — Hunt: "${huntName}"`, ''];
  for (const change of changes) {
    const direction = change.type === 'price_drop' ? 'PRICE DROP' : 'PRICE INCREASE';
    lines.push(
      `${direction}: "${change.title}" — was £${change.details.previousPrice}, now £${change.details.currentPrice}`,
    );
    lines.push(`  ${change.source ?? 'source'} ID: ${change.sourceId}`);
    lines.push('');
  }
  const evaluatorAgent = resolveEvaluatorAgent(vertical);
  lines.push(
    `Spawn the "${evaluatorAgent}" sub-agent (Task tool) to reassess the offer(s) above — pass it the hunt name and source IDs, ` +
      'and instruct it to review context via get_hunt_summary, reassess each price change against the hunt criteria, ' +
      'record decisions with record_evaluation, and return a short verdict per item. Relay its verdicts to the user.',
  );
  lines.push(...DELEGATION_RULES);

  writeIpcTask(taskId, lines.join('\n'));
  logger.info({ taskId, huntId, changeCount: changes.length }, 'Price change notification sent via IPC');
}
