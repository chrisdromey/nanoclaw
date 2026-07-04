import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPS_DIR } from './config.js';
import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  shouldSkipDealHunterTask,
  startSchedulerLoop,
} from './task-scheduler.js';
import type { ScheduledTask } from './types.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('skips once-tasks missed during downtime instead of replaying them', async () => {
    createTask({
      id: 'stale-once',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'stale notification',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      // Due ~2 months ago — well past the 1h grace window
      next_run: new Date(Date.now() - 60 * 24 * 3_600_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn();

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    // Never enqueued for execution...
    expect(enqueueTask).not.toHaveBeenCalled();
    // ...and marked completed so it won't fire again
    expect(getTaskById('stale-once')?.status).toBe('completed');
  });

  it('rolls stale cron tasks forward without running a catch-up', async () => {
    createTask({
      id: 'stale-cron',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'daily review',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60 * 24 * 3_600_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn();

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('stale-cron');
    // Not run as a catch-up, still active, rolled forward to the future
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(task?.status).toBe('active');
    expect(new Date(task!.next_run!).getTime()).toBeGreaterThan(Date.now());
  });

  it('still runs tasks that are only briefly overdue (within grace)', async () => {
    createTask({
      id: 'fresh-once',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'recent task',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn();

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).toHaveBeenCalledTimes(1);
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

describe('shouldSkipDealHunterTask (hunt pause gate)', () => {
  const GROUP = 'test-dh-gate';
  const groupDir = path.join(GROUPS_DIR, GROUP);
  const dbPath = path.join(groupDir, 'deal-hunter.db');

  function seedHuntDb(
    hunts: Array<{ id: number; status: string; monitoring: number }>,
  ): void {
    fs.mkdirSync(groupDir, { recursive: true });
    const db = new Database(dbPath);
    db.exec(
      'CREATE TABLE hunts (id INTEGER PRIMARY KEY, name TEXT, status TEXT, monitoring INTEGER)',
    );
    const insert = db.prepare(
      "INSERT INTO hunts (id, name, status, monitoring) VALUES (?, 'h', ?, ?)",
    );
    for (const h of hunts) insert.run(h.id, h.status, h.monitoring);
    db.close();
  }

  function makeTask(prompt: string, id = 'task-dh'): ScheduledTask {
    return {
      id,
      group_folder: GROUP,
      chat_jid: 'test@g.us',
      prompt,
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    };
  }

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('skips a per-hunt task when the referenced hunt is paused', () => {
    seedHuntDb([{ id: 1, status: 'paused', monitoring: 0 }]);
    const reason = shouldSkipDealHunterTask(
      makeTask(
        'Daily review. Hunt DB ID: 1 (name: proxmox-node-mini-pc). Check hunt_id=1.',
      ),
    );
    expect(reason).toMatch(/hunt 1: paused/);
  });

  it('runs a per-hunt task when the referenced hunt is active and monitored', () => {
    seedHuntDb([{ id: 1, status: 'active', monitoring: 1 }]);
    const reason = shouldSkipDealHunterTask(
      makeTask('Daily review. Hunt DB ID: 1.'),
    );
    expect(reason).toBeNull();
  });

  it('runs when ANY referenced hunt is active (multi-hunt prompt)', () => {
    seedHuntDb([
      { id: 1, status: 'paused', monitoring: 0 },
      { id: 2, status: 'active', monitoring: 1 },
    ]);
    const reason = shouldSkipDealHunterTask(
      makeTask('Review Hunt DB ID: 1 and Hunt DB ID: 2.'),
    );
    expect(reason).toBeNull();
  });

  it('skips a generic deal-hunter task when zero hunts are active', () => {
    seedHuntDb([
      { id: 1, status: 'paused', monitoring: 0 },
      { id: 2, status: 'closed', monitoring: 0 },
    ]);
    const reason = shouldSkipDealHunterTask(
      makeTask(
        'Daily review — assess the bigger picture across all active hunts.',
        'deal-hunter-daily-review',
      ),
    );
    expect(reason).toBe('no active monitored hunts');
  });

  it('runs a generic deal-hunter task when a hunt is active', () => {
    seedHuntDb([{ id: 1, status: 'active', monitoring: 1 }]);
    const reason = shouldSkipDealHunterTask(
      makeTask(
        'Daily review across all active hunts.',
        'deal-hunter-daily-review',
      ),
    );
    expect(reason).toBeNull();
  });

  it('fails open when deal-hunter.db is missing', () => {
    fs.mkdirSync(groupDir, { recursive: true }); // group exists, no DB
    const reason = shouldSkipDealHunterTask(makeTask('Hunt DB ID: 1'));
    expect(reason).toBeNull();
  });

  it('ignores tasks with no deal-hunter markers', () => {
    // No DB, no group dir — must not even attempt the gate
    const reason = shouldSkipDealHunterTask(
      makeTask('Send the weekly newsletter summary.', 'newsletter-task'),
    );
    expect(reason).toBeNull();
  });
});
