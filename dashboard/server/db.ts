import Database from 'better-sqlite3';
import { DEAL_HUNTER_DB, NANOCLAW_DB } from './config.js';

let dealDb: Database.Database | null = null;
let nanoclawDb: Database.Database | null = null;

export function getDealDb(): Database.Database {
  if (!dealDb) {
    dealDb = new Database(DEAL_HUNTER_DB);
    dealDb.pragma('journal_mode = WAL');
    dealDb.pragma('foreign_keys = ON');
    dealDb.pragma('busy_timeout = 5000');
  }
  return dealDb;
}

export function getNanoclawDb(): Database.Database {
  if (!nanoclawDb) {
    nanoclawDb = new Database(NANOCLAW_DB, { readonly: true });
    nanoclawDb.pragma('busy_timeout = 5000');
  }
  return nanoclawDb;
}

export function closeAll(): void {
  if (dealDb) {
    dealDb.close();
    dealDb = null;
  }
  if (nanoclawDb) {
    nanoclawDb.close();
    nanoclawDb = null;
  }
}
