/**
 * Agent notifier — writes IPC task files to trigger agent invocations.
 *
 * Three notification types:
 * - Urgent: auction countdown, watch condition met (sendUrgentNotification)
 * - New offers: batched per tick across hunts (sendNewOffersNotification)
 * - Price changes: watched offer price moved (sendPriceChangeNotification)
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { IPC_DIR, CHAT_JID } from './config.js';
import { logger } from './logger.js';
import type { Change } from './change-detector.js';

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

function buildUrgentPrompt(huntName: string, changes: Change[]): string {
  const lines: string[] = [`Deal Hunter Watcher Alert — Hunt: "${huntName}"`, ''];

  for (const change of changes) {
    switch (change.type) {
      case 'auction_ending':
        lines.push(
          `AUCTION ENDING: "${change.title}" — ${change.details.hoursLeft}h remaining (${change.details.threshold}h threshold), ` +
            `current bid £${change.details.currentBid}, ${change.details.bidCount ?? 0} bids`,
        );
        lines.push(`  eBay ID: ${change.sourceId}`);
        break;
      case 'watch_condition_met':
        lines.push(
          `WATCH CONDITION MET: "${change.title}" — ${change.details.condition}, ` +
            `current £${change.details.currentPrice} (threshold: £${change.details.threshold})`,
        );
        lines.push(`  eBay ID: ${change.sourceId}`);
        break;
      default:
        lines.push(`${change.type}: "${change.title}" — eBay ID: ${change.sourceId}`);
    }
    lines.push('');
  }

  lines.push('Use get_hunt_summary to review full context, then evaluate using the listing-evaluation skill.');
  return lines.join('\n');
}

/** Urgent notifications: auction countdown thresholds, watch conditions met. */
export function sendUrgentNotification(huntId: number, huntName: string, changes: Change[]): void {
  const taskId = `watcher-urgent-${Date.now()}-${randomUUID().slice(0, 8)}`;
  writeIpcTask(taskId, buildUrgentPrompt(huntName, changes));
  logger.info({ taskId, huntId, changeCount: changes.length }, 'Urgent notification sent via IPC');
}

/** Batched new offer notification — one per tick, lists all hunts with new offers. */
export function sendNewOffersNotification(
  huntSummaries: Array<{ huntId: number; huntName: string; newCount: number }>,
): void {
  const taskId = `watcher-new-offers-${Date.now()}`;

  const lines = ['Deal Hunter — New offers found', ''];
  for (const h of huntSummaries) {
    lines.push(`• Hunt "${h.huntName}" (ID ${h.huntId}): ${h.newCount} new offer${h.newCount > 1 ? 's' : ''}`);
  }
  lines.push('');
  lines.push('Call get_hunt_summary for each hunt to review and evaluate new offers using the listing-evaluation skill.');

  writeIpcTask(taskId, lines.join('\n'));
  logger.info({ taskId, huntCount: huntSummaries.length }, 'New offers notification sent via IPC');
}

/** Price change notification for watched offers. */
export function sendPriceChangeNotification(huntId: number, huntName: string, changes: Change[]): void {
  const taskId = `watcher-price-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const lines = [`Deal Hunter — Price change on watched offer — Hunt: "${huntName}"`, ''];
  for (const change of changes) {
    const direction = change.type === 'price_drop' ? 'PRICE DROP' : 'PRICE INCREASE';
    lines.push(
      `${direction}: "${change.title}" — was £${change.details.previousPrice}, now £${change.details.currentPrice}`,
    );
    lines.push(`  eBay ID: ${change.sourceId}`);
    lines.push('');
  }
  lines.push('Use get_hunt_summary to review context, then reassess using the listing-evaluation skill.');

  writeIpcTask(taskId, lines.join('\n'));
  logger.info({ taskId, huntId, changeCount: changes.length }, 'Price change notification sent via IPC');
}
