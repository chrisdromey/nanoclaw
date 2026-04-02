/**
 * Deal Hunter Watcher Service
 *
 * Standalone background service that polls eBay for new listings
 * and monitors watched offers. Writes observations to the shared
 * deal-hunter SQLite DB. Notifies the agent via IPC for urgent changes.
 */

import { logger } from './logger.js';
import { DB_PATH, SCHEDULER_TICK_MS } from './config.js';
import { openDatabase } from './db.js';
import { initState, tick } from './scheduler.js';

async function main(): Promise<void> {
  logger.info({ dbPath: DB_PATH }, 'Deal Hunter Watcher starting');

  const db = openDatabase(DB_PATH);

  const state = initState(db);

  let running = true;

  const shutdown = () => {
    logger.info('Shutting down');
    running = false;
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const runLoop = async () => {
    if (!running) return;
    try {
      await tick(state, db);
    } catch (err) {
      logger.error({ err }, 'Unhandled error in scheduler tick');
    }
    if (running) setTimeout(runLoop, SCHEDULER_TICK_MS);
  };

  // Start immediately
  runLoop();
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start watcher');
  process.exit(1);
});
