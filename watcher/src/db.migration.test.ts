import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './db.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe('ensureSchema migrations', () => {
  it('adds requirement_checks to a pre-existing old-shape evaluations table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dh-migration-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'deal-hunter.db');

    // Old-shape evaluations table (pre-requirement_checks), as shipped before this migration.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id INTEGER NOT NULL,
        hunt_id INTEGER NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('alert', 'skip', 'watch')),
        reasoning TEXT,
        evaluated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    legacy.prepare(
      "INSERT INTO evaluations (offer_id, hunt_id, decision, reasoning) VALUES (1, 1, 'skip', 'legacy row')",
    ).run();
    legacy.close();

    const db = openDatabase(dbPath);
    cleanups.push(() => db.close());

    expect(columnNames(db, 'evaluations')).toContain('requirement_checks');
    // Legacy rows survive with NULL checks.
    const row = db.prepare('SELECT reasoning, requirement_checks FROM evaluations').get() as {
      reasoning: string;
      requirement_checks: string | null;
    };
    expect(row.reasoning).toBe('legacy row');
    expect(row.requirement_checks).toBeNull();
  });

  it('creates requirement_checks on a fresh database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dh-fresh-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = openDatabase(join(dir, 'deal-hunter.db'));
    cleanups.push(() => db.close());

    expect(columnNames(db, 'evaluations')).toContain('requirement_checks');
  });
});

describe('agent_runs table', () => {
  it('is created on a fresh database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dh-agent-runs-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = openDatabase(join(dir, 'deal-hunter.db'));
    cleanups.push(() => db.close());
    expect(columnNames(db, 'agent_runs')).toEqual(
      expect.arrayContaining(['prompt_head', 'models', 'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'cost_usd', 'duration_ms', 'num_turns']),
    );
  });
});
