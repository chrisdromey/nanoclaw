/**
 * Tests for the hunt-targets endpoints (server/routes/targets.ts):
 *
 *   GET /hunts/:id/targets            — criteria targets ∪ KB rows, with KB
 *                                       coverage + claim verifications
 *   GET /hunts/:id/targets/:key/kb    — serves the KB markdown; kb_path comes
 *                                       ONLY from the DB row and must resolve
 *                                       inside GROUP_DIR (traversal guard)
 *
 * Pattern: in-memory better-sqlite3 behind a mocked getDealDb(), plus a mocked
 * server/config.js pointing GROUP_DIR at a scratch dir so the kb endpoint's
 * file serving (including the 400-on-traversal path) is exercised for real.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

let db: Database.Database;

vi.mock('../../server/db.js', () => ({
  getDealDb: () => db,
}));

// GROUP_DIR is nested two levels below the temp base so a '../../…' kb_path
// resolves to a real, readable location that is still OUTSIDE the group dir —
// proving the guard (not a missing file) is what rejects it.
vi.mock('../../server/config.js', async () => {
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  const nodeOs = await import('node:os');
  const base = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'targets-kb-test-'));
  const groupDir = nodePath.join(base, 'outer', 'group');
  nodeFs.mkdirSync(groupDir, { recursive: true });
  return { GROUP_DIR: groupDir };
});

import { targetsRoutes } from '../../server/routes/targets';
import { GROUP_DIR } from '../../server/config';
import type { HuntTargetsData } from '../../shared/types';

const TEMP_BASE = path.resolve(GROUP_DIR, '..', '..');

const CARS_CRITERIA = JSON.stringify({
  shared: { postcode: 'M346EP', max_price: 22000, fuel: 'Electric' },
  targets: {
    'Kia EV6': { make: 'Kia', model: 'EV6', year_min: 2021 },
    'Polestar 2': { make: 'Polestar', model: '2', year_min: 2020 },
  },
  intent: {
    must_have: ['Adaptive Cruise Control (ACC)', 'Heat pump'],
    purpose: 'family EV',
  },
});

const COMPUTERS_CRITERIA = JSON.stringify({
  gpu: 'RTX 3090',
  max_price: 900,
});

const KB_MARKDOWN = '# Kia EV6\n\nHeat pump: standard on GT-Line [1].\n';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE hunts (
      id INTEGER PRIMARY KEY,
      name TEXT,
      vertical TEXT,
      criteria TEXT
    );
    CREATE TABLE knowledge_base (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hunt_id INTEGER NOT NULL,
      vertical TEXT NOT NULL,
      target_key TEXT NOT NULL,
      kb_path TEXT NOT NULL,
      citation_count INTEGER NOT NULL DEFAULT 0,
      must_have_citations TEXT NOT NULL DEFAULT '{}',
      built_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hunt_id, target_key)
    );
    CREATE TABLE claim_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hunt_id INTEGER NOT NULL,
      target_key TEXT NOT NULL,
      feature TEXT NOT NULL,
      verdict TEXT NOT NULL,
      evidence_url TEXT,
      notes TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hunt_id, target_key, feature)
    );
  `);

  db.prepare('INSERT INTO hunts (id, name, vertical, criteria) VALUES (?, ?, ?, ?)')
    .run(1, 'family-ev', 'cars', CARS_CRITERIA);
  db.prepare('INSERT INTO hunts (id, name, vertical, criteria) VALUES (?, ?, ?, ?)')
    .run(2, 'workstation', 'computers', COMPUTERS_CRITERIA);
  db.prepare('INSERT INTO hunts (id, name, vertical, criteria) VALUES (?, ?, ?, ?)')
    .run(3, 'broken', 'cars', 'not json {');

  // KB row for Kia EV6 (Polestar 2 deliberately has none → kb: null).
  db.prepare(
    `INSERT INTO knowledge_base (hunt_id, vertical, target_key, kb_path, citation_count, must_have_citations, built_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    1, 'cars', 'Kia EV6', 'references/product-knowledge/cars/kia-ev6.md',
    6, JSON.stringify({ 'Adaptive Cruise Control (ACC)': 3, 'Heat pump': 3 }),
    '2026-07-04 12:34:00',
  );

  const insertVerification = db.prepare(
    `INSERT INTO claim_verifications (hunt_id, target_key, feature, verdict, evidence_url, notes, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertVerification.run(1, 'Kia EV6', 'Adaptive Cruise Control (ACC)', 'verified', null, 'Standard across trims', '2026-07-04 13:00:00');
  insertVerification.run(1, 'Kia EV6', 'Heat pump', 'verified', 'https://example.com/ev6-spec', null, '2026-07-04 13:01:00');

  // KB fixture file inside the mocked GROUP_DIR.
  const kbFile = path.join(GROUP_DIR, 'references/product-knowledge/cars/kia-ev6.md');
  fs.mkdirSync(path.dirname(kbFile), { recursive: true });
  fs.writeFileSync(kbFile, KB_MARKDOWN, 'utf-8');
});

afterAll(() => {
  fs.rmSync(TEMP_BASE, { recursive: true, force: true });
});

describe('GET /hunts/:id/targets', () => {
  it('returns the full shape for a cars hunt', async () => {
    const res = await targetsRoutes.request('/hunts/1/targets');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HuntTargetsData;

    expect(body.hunt_id).toBe(1);
    expect(body.vertical).toBe('cars');
    expect(body.must_have).toEqual(['Adaptive Cruise Control (ACC)', 'Heat pump']);
    expect(body.targets.map((t) => t.target_key)).toEqual(['Kia EV6', 'Polestar 2']);

    const ev6 = body.targets[0];
    expect(ev6.criteria).toEqual({ make: 'Kia', model: 'EV6', year_min: 2021 });
    expect(ev6.kb).toEqual({
      kb_path: 'references/product-knowledge/cars/kia-ev6.md',
      citation_count: 6,
      must_have_citations: { 'Adaptive Cruise Control (ACC)': 3, 'Heat pump': 3 },
      built_at: '2026-07-04 12:34:00',
    });
    expect(ev6.verifications).toEqual([
      {
        feature: 'Adaptive Cruise Control (ACC)',
        verdict: 'verified',
        evidence_url: null,
        notes: 'Standard across trims',
        checked_at: '2026-07-04 13:00:00',
      },
      {
        feature: 'Heat pump',
        verdict: 'verified',
        evidence_url: 'https://example.com/ev6-spec',
        notes: null,
        checked_at: '2026-07-04 13:01:00',
      },
    ]);

    const polestar = body.targets[1];
    expect(polestar.criteria).toEqual({ make: 'Polestar', model: '2', year_min: 2020 });
    expect(polestar.kb).toBeNull();
    expect(polestar.verifications).toEqual([]);
  });

  it('a computers hunt (no criteria.targets) returns targets: [] without error', async () => {
    const res = await targetsRoutes.request('/hunts/2/targets');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HuntTargetsData;
    expect(body.vertical).toBe('computers');
    expect(body.must_have).toEqual([]);
    expect(body.targets).toEqual([]);
  });

  it('404s for a missing hunt', async () => {
    const res = await targetsRoutes.request('/hunts/999/targets');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('a KB-only target (no criteria entry) appears after criteria targets with criteria: null', async () => {
    db.prepare(
      `INSERT INTO knowledge_base (hunt_id, vertical, target_key, kb_path, citation_count, must_have_citations, built_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, 'cars', 'Tesla Model 3', 'references/product-knowledge/cars/tesla-model-3.md', 12, '{}', '2026-07-04 12:35:21');

    const res = await targetsRoutes.request('/hunts/1/targets');
    const body = (await res.json()) as HuntTargetsData;
    expect(body.targets.map((t) => t.target_key)).toEqual(['Kia EV6', 'Polestar 2', 'Tesla Model 3']);
    const extra = body.targets[2];
    expect(extra.criteria).toBeNull();
    expect(extra.kb?.kb_path).toBe('references/product-knowledge/cars/tesla-model-3.md');
  });

  it('malformed criteria JSON degrades to empty must_have and no criteria targets, not a 500', async () => {
    const res = await targetsRoutes.request('/hunts/3/targets');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HuntTargetsData;
    expect(body.must_have).toEqual([]);
    expect(body.targets).toEqual([]);
  });

  it('malformed must_have_citations JSON on a KB row falls back to {}', async () => {
    db.prepare('UPDATE knowledge_base SET must_have_citations = ? WHERE hunt_id = 1 AND target_key = ?')
      .run('nope{', 'Kia EV6');
    const res = await targetsRoutes.request('/hunts/1/targets');
    const body = (await res.json()) as HuntTargetsData;
    expect(body.targets[0].kb?.must_have_citations).toEqual({});
  });
});

describe('GET /hunts/:id/targets/:targetKey/kb', () => {
  it('200: returns the KB markdown for a URL-encoded target key with a space', async () => {
    const res = await targetsRoutes.request('/hunts/1/targets/Kia%20EV6/kb');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      target_key: string;
      kb_path: string;
      built_at: string;
      markdown: string;
    };
    expect(body.target_key).toBe('Kia EV6');
    expect(body.kb_path).toBe('references/product-knowledge/cars/kia-ev6.md');
    expect(body.built_at).toBe('2026-07-04 12:34:00');
    expect(body.markdown).toBe(KB_MARKDOWN);
  });

  it('404: no KB row for the target', async () => {
    const res = await targetsRoutes.request('/hunts/1/targets/Polestar%202/kb');
    expect(res.status).toBe(404);
  });

  it('404: KB row exists but the file is missing', async () => {
    db.prepare('UPDATE knowledge_base SET kb_path = ? WHERE hunt_id = 1 AND target_key = ?')
      .run('references/product-knowledge/cars/gone.md', 'Kia EV6');
    const res = await targetsRoutes.request('/hunts/1/targets/Kia%20EV6/kb');
    expect(res.status).toBe(404);
  });

  it('400: a kb_path that escapes GROUP_DIR is rejected even though the file exists', async () => {
    // The secrets file lives OUTSIDE the mocked GROUP_DIR (at the temp base,
    // two levels up) and IS readable — only the traversal guard stops it.
    const secretsFile = path.join(TEMP_BASE, 'secrets.md');
    fs.writeFileSync(secretsFile, 'TOP SECRET', 'utf-8');
    expect(path.resolve(GROUP_DIR, '../../secrets.md')).toBe(secretsFile);

    db.prepare('UPDATE knowledge_base SET kb_path = ? WHERE hunt_id = 1 AND target_key = ?')
      .run('../../secrets.md', 'Kia EV6');
    const res = await targetsRoutes.request('/hunts/1/targets/Kia%20EV6/kb');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; markdown?: string };
    expect(body.error).toBe('invalid path');
    expect(body.markdown).toBeUndefined();
  });
});
