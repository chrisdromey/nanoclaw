import Database from 'better-sqlite3';
import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  SCHEDULER_POLL_INTERVAL,
  SESSION_TTL_MS,
  STALE_TASK_GRACE_MS,
  TIMEZONE,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  isSessionExpired,
  logTaskRun,
  type SessionEntry,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

/**
 * Skip a task whose scheduled time was missed by more than the grace window
 * (typically because the host was powered off). Recording it via
 * updateTaskAfterRun marks `once` tasks completed (computeNextRun → null) and
 * rolls `cron`/`interval` tasks forward to their next future occurrence, so a
 * long downtime never replays a flood of obsolete runs on restart.
 */
function skipStaleTask(task: ScheduledTask, overdueMs: number): void {
  const overdueHours = (overdueMs / 3_600_000).toFixed(1);
  const nextRun = computeNextRun(task);
  updateTaskAfterRun(
    task.id,
    nextRun,
    `Skipped: ${overdueHours}h overdue (missed during downtime)`,
  );
  logger.warn(
    {
      taskId: task.id,
      scheduleType: task.schedule_type,
      overdueHours,
      nextRun,
    },
    'Skipping stale task missed during downtime',
  );
}

/**
 * Deal Hunter pause gate.
 *
 * Scheduled tasks have no hunt_id column — hunt linkage lives only in the prompt text
 * (agent-created daily-review tasks embed "Hunt DB ID: N" / "hunt_id=N"). Pausing a hunt
 * does NOT pause its cron tasks, so without this gate a paused hunt keeps burning agent
 * runs on daily reviews. The gate reads the group's deal-hunter.db READ-ONLY just before
 * dispatch:
 *
 * - Per-hunt task (prompt names hunt id(s)): skip unless at least one named hunt is
 *   status='active' AND monitoring=1.
 * - Generic deal-hunter task (id/prompt mentions deal-hunter, no hunt id): skip when the
 *   group has zero active monitored hunts.
 * - Anything else (non-deal-hunter tasks, missing DB, query error): fail OPEN — never
 *   block unrelated groups or tasks on this gate.
 *
 * Returns a human-readable skip reason, or null to run the task.
 */
export function shouldSkipDealHunterTask(task: ScheduledTask): string | null {
  // Only gate RECURRING tasks. A skipped 'once' task is marked completed (next_run → null)
  // and permanently destroyed — that would silently swallow user reminders that merely
  // mention deal-hunter terms (e.g. "remind me to resume the Deal Hunter hunts"), and the
  // watcher's own 'once' alert tasks are only created for hunts that were active moments
  // earlier anyway.
  if (task.schedule_type === 'once') return null;

  const huntIds = new Set<number>();
  for (const re of [/Hunt DB ID:\s*(\d+)/gi, /hunt_id=(\d+)/gi]) {
    for (const m of task.prompt.matchAll(re)) huntIds.add(parseInt(m[1], 10));
  }
  const isGenericDealHunter =
    huntIds.size === 0 && /deal[- ]hunter/i.test(`${task.id} ${task.prompt}`);
  if (huntIds.size === 0 && !isGenericDealHunter) return null;

  let db: InstanceType<typeof Database> | undefined;
  try {
    const dbPath = path.join(
      resolveGroupFolderPath(task.group_folder),
      'deal-hunter.db',
    );
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    if (huntIds.size > 0) {
      const stmt = db.prepare(
        'SELECT status, monitoring FROM hunts WHERE id = ?',
      );
      const states: string[] = [];
      for (const id of huntIds) {
        const hunt = stmt.get(id) as
          | { status: string; monitoring: number }
          | undefined;
        if (hunt && hunt.status === 'active' && hunt.monitoring === 1)
          return null;
        states.push(`hunt ${id}: ${hunt ? hunt.status : 'not found'}`);
      }
      return `no referenced hunt is active+monitored (${states.join(', ')})`;
    }

    const active = db
      .prepare(
        "SELECT COUNT(*) as count FROM hunts WHERE status = 'active' AND monitoring = 1",
      )
      .get() as { count: number };
    if (active.count === 0) return 'no active monitored hunts';
    return null;
  } catch (err) {
    // Fail open: a missing/unreadable deal-hunter.db must never block a task. Logged at
    // warn (not debug) — if the DB is persistently unreadable (e.g. WAL recovery needed
    // by a readonly connection), the gate is silently inert and paused hunts burn runs.
    logger.warn(
      { taskId: task.id, err },
      'Deal-hunter pause gate could not read hunt state; running task (gate inert)',
    );
    return null;
  } finally {
    db?.close();
  }
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, SessionEntry>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session (if not expired)
  const sessions = deps.getSessions();
  let sessionId: string | undefined;
  if (task.context_mode === 'group') {
    const entry = sessions[task.group_folder];
    if (entry && !isSessionExpired(entry.last_used, SESSION_TTL_MS)) {
      sessionId = entry.session_id;
    }
  }

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Skip tasks missed during downtime instead of replaying them.
        const overdueMs = currentTask.next_run
          ? Date.now() - new Date(currentTask.next_run).getTime()
          : 0;
        if (overdueMs > STALE_TASK_GRACE_MS) {
          skipStaleTask(currentTask, overdueMs);
          continue;
        }

        // Deal Hunter pause gate: paused/closed hunts must not burn agent runs.
        const gateReason = shouldSkipDealHunterTask(currentTask);
        if (gateReason) {
          updateTaskAfterRun(
            currentTask.id,
            computeNextRun(currentTask),
            `Skipped: ${gateReason}`,
          );
          logger.info(
            { taskId: currentTask.id, reason: gateReason },
            'Skipping deal-hunter task (hunt paused/inactive)',
          );
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
