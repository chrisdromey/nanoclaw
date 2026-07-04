/**
 * Gate parity + hardening tests for the dashboard HTTP writers.
 *
 * The dashboard server is a SECOND writer to the same deal-hunter.db as the container MCP. An
 * adversarial review found its pause/resume/update endpoints bypassed the activation gate that the
 * MCP enforces, so a "Resume" could re-activate a malformed/unbaselined hunt the watcher would then
 * poll. These tests lock the dashboard endpoints to the MCP gate semantics, and exercise the two
 * gate-hardening fixes (fail-closed on missing vertical config; reject present-but-wrong-typed
 * required leaves) against the vendored gate copy the dashboard imports.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';

let db: Database.Database;

vi.mock('../../server/db.js', () => ({
  getDealDb: () => db,
}));

// The hunts routes import the sources layer at module load; the endpoints under test never call it.
vi.mock('../../server/sources/index.js', () => ({
  checkOfferStatusBySource: vi.fn(),
  pendingRefreshJobs: new Map(),
}));

import { huntRoutes } from '../../server/routes/hunts';
import {
  validateCriteriaForVertical,
  evaluateActivationGate,
  type HuntRow,
} from '../../server/deal-hunter-gate';

const CARS_CONFIG = {
  name: 'cars',
  criteria_schema: {
    shared: {
      postcode: 'string',
      max_price: 'integer?',
      max_mileage: 'integer?',
      fuel: 'string?',
      transmission: 'string?',
    },
    targets: {
      "<search term, e.g. 'Jaguar I-Pace'>": {
        make: 'string',
        model: 'string?',
        year_min: 'integer?',
        year_max: 'integer?',
      },
    },
    intent: { must_have: 'string[]?', purpose: 'string?' },
  },
};

const COMPUTERS_CONFIG = { name: 'computers', criteria_schema: {} };

const VALID_CARS_CRITERIA = JSON.stringify({
  shared: { postcode: 'M346EP' },
  targets: { 'Jaguar I-Pace': { make: 'Jaguar' } },
});

// search_terms whose `terms` match VALID_CARS_CRITERIA's single target key — so the new term/target
// parity check passes by default. Tests that exercise parity override this.
const MATCHING_SEARCH_TERMS = JSON.stringify([{ terms: 'Jaguar I-Pace' }]);

const TWO_TARGET_CRITERIA = JSON.stringify({
  shared: { postcode: 'M346EP' },
  targets: { 'Jaguar I-Pace': { make: 'Jaguar' }, 'Kia EV6': { make: 'Kia' } },
});

function seedDb() {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE hunts (
      id INTEGER PRIMARY KEY,
      name TEXT,
      status TEXT,
      criteria TEXT,
      search_terms TEXT,
      cadence_minutes INTEGER,
      monitoring INTEGER,
      category_ids TEXT,
      vertical TEXT,
      sources TEXT,
      created_at TEXT,
      closed_at TEXT,
      close_reason TEXT,
      poll_interval_minutes INTEGER
    );
    CREATE TABLE market_segments (
      id INTEGER PRIMARY KEY,
      hunt_id INTEGER
    );
    CREATE TABLE verticals (
      name TEXT PRIMARY KEY,
      config_json TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO verticals (name, config_json) VALUES (?, ?)').run('cars', JSON.stringify(CARS_CONFIG));
  db.prepare('INSERT INTO verticals (name, config_json) VALUES (?, ?)').run('computers', JSON.stringify(COMPUTERS_CONFIG));
}

function insertHunt(
  over: Partial<{
    id: number;
    status: string;
    monitoring: number;
    criteria: string;
    vertical: string;
    search_terms: string;
  }>,
) {
  const row = {
    id: 1,
    status: 'active',
    monitoring: 1,
    criteria: VALID_CARS_CRITERIA,
    vertical: 'cars',
    search_terms: MATCHING_SEARCH_TERMS,
    ...over,
  };
  db.prepare(
    `INSERT INTO hunts (id, name, status, criteria, search_terms, cadence_minutes, monitoring, vertical, sources, created_at)
     VALUES (?, ?, ?, ?, ?, 60, ?, ?, '["autotrader"]', '2026-06-28T00:00:00')`,
  ).run(row.id, `hunt-${row.id}`, row.status, row.criteria, row.search_terms, row.monitoring, row.vertical);
  return row.id;
}

function addSegment(huntId: number) {
  db.prepare('INSERT INTO market_segments (hunt_id) VALUES (?)').run(huntId);
}

function getHunt(id: number) {
  return db.prepare('SELECT status, monitoring FROM hunts WHERE id = ?').get(id) as {
    status: string;
    monitoring: number;
  };
}

beforeEach(seedDb);

describe('POST /hunts/:id/pause', () => {
  it('clears monitoring as well as status (matches MCP pause)', async () => {
    const id = insertHunt({ status: 'active', monitoring: 1 });
    const res = await huntRoutes.request(`/hunts/${id}/pause`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(getHunt(id)).toEqual({ status: 'paused', monitoring: 0 });
  });
});

describe('POST /hunts/:id/resume', () => {
  it('runs the gate and refuses (400) a hunt with 0 market segments — stays paused, not monitored', async () => {
    const id = insertHunt({ status: 'paused', monitoring: 0 }); // valid criteria, but no segments
    const res = await huntRoutes.request(`/hunts/${id}/resume`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; missing: string[] };
    expect(body.missing.some((m) => m.includes('market segment'))).toBe(true);
    // Critically, it must NOT have activated.
    expect(getHunt(id)).toEqual({ status: 'paused', monitoring: 0 });
  });

  it('refuses (400) a hunt whose criteria are invalid for its vertical', async () => {
    const id = insertHunt({ status: 'paused', monitoring: 0, criteria: JSON.stringify({ shared: {}, targets: {} }) });
    addSegment(id); // segment present, so the only failure is criteria
    const res = await huntRoutes.request(`/hunts/${id}/resume`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { missing: string[] };
    expect(body.missing.some((m) => m.includes('shared.postcode is required'))).toBe(true);
    expect(getHunt(id)).toEqual({ status: 'paused', monitoring: 0 });
  });

  it('activates (status=active, monitoring=1) only when the gate passes', async () => {
    const id = insertHunt({ status: 'paused', monitoring: 0 });
    addSegment(id);
    const res = await huntRoutes.request(`/hunts/${id}/resume`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(getHunt(id)).toEqual({ status: 'active', monitoring: 1 });
  });

  it('404s an unknown hunt and 400s a non-paused hunt', async () => {
    const id = insertHunt({ status: 'active', monitoring: 1 });
    addSegment(id);
    expect((await huntRoutes.request('/hunts/999/resume', { method: 'POST' })).status).toBe(404);
    expect((await huntRoutes.request(`/hunts/${id}/resume`, { method: 'POST' })).status).toBe(400);
  });
});

describe('PUT /hunts/:id monitoring writes', () => {
  it('rejects a direct attempt to enable monitoring (matches MCP update)', async () => {
    const id = insertHunt({ status: 'paused', monitoring: 0 });
    const res = await huntRoutes.request(`/hunts/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monitoring: true }),
    });
    expect(res.status).toBe(400);
    expect(getHunt(id)).toEqual({ status: 'paused', monitoring: 0 });
  });

  it('honours monitoring:false (stop monitoring), not stricter than MCP', async () => {
    const id = insertHunt({ status: 'active', monitoring: 1 });
    const res = await huntRoutes.request(`/hunts/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monitoring: false }),
    });
    expect(res.status).toBe(200);
    expect(getHunt(id).monitoring).toBe(0);
  });
});

describe('gate hardening — fail closed on missing/unparseable vertical config', () => {
  it('fails closed when the vertical has no row in the verticals table', () => {
    const errors = validateCriteriaForVertical(db, 'motorbikes', { anything: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('vertical config unavailable');
  });

  it('fails closed when config_json is not valid JSON', () => {
    db.prepare('INSERT INTO verticals (name, config_json) VALUES (?, ?)').run('broken', '{not json');
    const errors = validateCriteriaForVertical(db, 'broken', {});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('vertical config unavailable');
  });

  it('still passes computers (legitimately empty schema)', () => {
    expect(validateCriteriaForVertical(db, 'computers', {})).toEqual([]);
  });

  it('evaluateActivationGate fails closed for an unknown vertical', () => {
    const hunt: HuntRow = { id: 1, criteria: '{}', vertical: 'motorbikes', status: 'paused' };
    addSegment(1);
    const gate = evaluateActivationGate(db, hunt);
    expect(gate.ok).toBe(false);
    expect(gate.errors.some((e) => e.includes('vertical config unavailable'))).toBe(true);
  });
});

describe('gate hardening — reject present-but-wrong-typed required leaves', () => {
  it('rejects a numeric postcode where the schema names a string', () => {
    const errors = validateCriteriaForVertical(db, 'cars', {
      shared: { postcode: 12345 },
      targets: { 'Jaguar I-Pace': { make: 'Jaguar' } },
    });
    expect(errors).toContain('shared.postcode must be a string');
  });

  it('rejects a numeric make inside a target', () => {
    const errors = validateCriteriaForVertical(db, 'cars', {
      shared: { postcode: 'M346EP' },
      targets: { 'Jaguar I-Pace': { make: 99 } },
    });
    expect(errors.some((e) => e.includes('must be a string'))).toBe(true);
  });

  it('accepts correctly-typed valid criteria', () => {
    expect(
      validateCriteriaForVertical(db, 'cars', {
        shared: { postcode: 'M346EP' },
        targets: { 'Jaguar I-Pace': { make: 'Jaguar' } },
      }),
    ).toEqual([]);
  });
});

describe('gate hardening — search_terms must match the criteria targets (wildcard-map parity)', () => {
  it('(a) rejects resume when a target has no matching search_term', async () => {
    // targets {Jaguar I-Pace, Kia EV6} but search_terms only [Jaguar I-Pace] → Kia EV6 is orphaned.
    const id = insertHunt({
      status: 'paused',
      monitoring: 0,
      criteria: TWO_TARGET_CRITERIA,
      search_terms: JSON.stringify([{ terms: 'Jaguar I-Pace' }]),
    });
    addSegment(id);
    const res = await huntRoutes.request(`/hunts/${id}/resume`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { missing: string[] };
    expect(body.missing.some((m) => m.includes('Kia EV6') && m.includes('no matching search_term'))).toBe(true);
    expect(getHunt(id)).toEqual({ status: 'paused', monitoring: 0 });
  });

  it('(b) rejects resume when a search_term has no matching target', async () => {
    // targets {Jaguar I-Pace, Kia EV6}; search_terms [Jaguar I-Pace, Kia Niro] → Kia Niro is orphaned.
    const id = insertHunt({
      status: 'paused',
      monitoring: 0,
      criteria: TWO_TARGET_CRITERIA,
      search_terms: JSON.stringify([{ terms: 'Jaguar I-Pace' }, { terms: 'Kia Niro' }]),
    });
    addSegment(id);
    const res = await huntRoutes.request(`/hunts/${id}/resume`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { missing: string[] };
    expect(
      body.missing.some((m) => m.includes('Kia Niro') && m.includes('no matching criteria.targets')),
    ).toBe(true);
    expect(getHunt(id)).toEqual({ status: 'paused', monitoring: 0 });
  });

  it('(c) activates when search_terms keys exactly equal the targets keys', async () => {
    const id = insertHunt({
      status: 'paused',
      monitoring: 0,
      criteria: TWO_TARGET_CRITERIA,
      search_terms: JSON.stringify([{ terms: 'Jaguar I-Pace' }, { terms: 'Kia EV6' }]),
    });
    addSegment(id);
    const res = await huntRoutes.request(`/hunts/${id}/resume`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(getHunt(id)).toEqual({ status: 'active', monitoring: 1 });
  });

  it('(d) computers (no wildcard map in schema) is unaffected and still activates', async () => {
    const id = insertHunt({
      status: 'paused',
      monitoring: 0,
      vertical: 'computers',
      criteria: '{}',
      // Mismatched/arbitrary terms must NOT matter — computers declares no <...> map.
      search_terms: JSON.stringify(['anything', 'goes']),
    });
    addSegment(id);
    const res = await huntRoutes.request(`/hunts/${id}/resume`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(getHunt(id)).toEqual({ status: 'active', monitoring: 1 });
  });

  it('(e) flags invalid-JSON search_terms when a populated wildcard map exists', () => {
    const errors = evaluateActivationGate(db, {
      id: 99,
      criteria: TWO_TARGET_CRITERIA,
      vertical: 'cars',
      status: 'paused',
      search_terms: '{not json',
    }).errors;
    expect(errors.some((e) => e.includes('search_terms is not a valid JSON array'))).toBe(true);
  });
});

describe('provenance gate (gate_version >= 2) — B/C/D', () => {
  let pdb: Database.Database;

  const FEATURE_LED_CRITERIA = JSON.stringify({
    shared: { postcode: 'M346EP' },
    targets: { 'Polestar 2': { make: 'Polestar' } },
    intent: { must_have: ['Adaptive cruise control (ACC)'] },
  });
  const NON_FEATURE_LED_CRITERIA = JSON.stringify({
    shared: { postcode: 'M346EP' },
    targets: { 'Polestar 2': { make: 'Polestar' } },
  });
  const SEARCH_TERMS = JSON.stringify([{ terms: 'Polestar 2' }]);

  function seedProvenance() {
    pdb = new Database(':memory:');
    pdb.exec(`
      CREATE TABLE hunts (
        id INTEGER PRIMARY KEY, name TEXT, status TEXT, criteria TEXT, search_terms TEXT,
        cadence_minutes INTEGER, monitoring INTEGER, category_ids TEXT, vertical TEXT, sources TEXT,
        created_at TEXT, closed_at TEXT, close_reason TEXT, poll_interval_minutes INTEGER, gate_version INTEGER
      );
      CREATE TABLE market_segments (id INTEGER PRIMARY KEY, hunt_id INTEGER, name TEXT, tags TEXT);
      CREATE TABLE baseline_prices (
        id INTEGER PRIMARY KEY, segment_id INTEGER, hunt_id INTEGER, source_type TEXT, title TEXT,
        price REAL, total_landed_gbp REAL, source_url TEXT, source_item_id TEXT, tags TEXT
      );
      CREATE TABLE knowledge_base (
        id INTEGER PRIMARY KEY, hunt_id INTEGER, vertical TEXT, target_key TEXT, kb_path TEXT,
        citation_count INTEGER, must_have_citations TEXT
      );
      CREATE TABLE claim_verifications (
        id INTEGER PRIMARY KEY, hunt_id INTEGER, target_key TEXT, feature TEXT, verdict TEXT,
        evidence_url TEXT, notes TEXT
      );
      CREATE TABLE verticals (name TEXT PRIMARY KEY, config_json TEXT NOT NULL);
    `);
    pdb.prepare('INSERT INTO verticals (name, config_json) VALUES (?, ?)').run('cars', JSON.stringify(CARS_CONFIG));
    pdb.prepare('INSERT INTO verticals (name, config_json) VALUES (?, ?)').run('computers', JSON.stringify(COMPUTERS_CONFIG));
  }

  function insertV2Hunt(over: Partial<{ criteria: string; gate_version: number | null }> = {}) {
    const o = { criteria: FEATURE_LED_CRITERIA, gate_version: 2 as number | null, ...over };
    pdb.prepare(
      `INSERT INTO hunts (id, name, status, criteria, search_terms, cadence_minutes, monitoring, vertical, sources, created_at, gate_version)
       VALUES (1, 'h', 'draft', ?, ?, 60, 0, 'cars', '["autotrader"]', '2026-06-28', ?)`,
    ).run(o.criteria, SEARCH_TERMS, o.gate_version);
  }
  function addSeg(name: string, tags: string[] = ['polestar 2']) {
    return pdb.prepare('INSERT INTO market_segments (hunt_id, name, tags) VALUES (1, ?, ?)').run(name, JSON.stringify(tags))
      .lastInsertRowid as number;
  }
  function addComp(segId: number, price: number, idx: number, tag = 'lr') {
    pdb.prepare(
      `INSERT INTO baseline_prices (segment_id, hunt_id, source_type, title, price, total_landed_gbp, source_url, source_item_id, tags)
       VALUES (?, 1, 'active', 't', ?, ?, ?, ?, ?)`,
    ).run(segId, price, price, `https://at/${idx}`, `id${idx}`, JSON.stringify([tag]));
  }
  function addKb(target = 'Polestar 2', citations: Record<string, number> = { 'Adaptive cruise control (ACC)': 2 }) {
    pdb.prepare(
      `INSERT INTO knowledge_base (hunt_id, vertical, target_key, kb_path, citation_count, must_have_citations) VALUES (1, 'cars', ?, 'kb.md', 2, ?)`,
    ).run(target, JSON.stringify(citations));
  }
  function addVerdict(verdict: string, feature = 'Adaptive cruise control (ACC)', target = 'Polestar 2') {
    pdb.prepare(
      `INSERT INTO claim_verifications (hunt_id, target_key, feature, verdict) VALUES (1, ?, ?, ?)`,
    ).run(target, feature, verdict);
  }
  const hunt = () => pdb.prepare('SELECT id, criteria, vertical, status, search_terms FROM hunts WHERE id = 1').get() as HuntRow;
  const gate = () => evaluateActivationGate(pdb, hunt());

  beforeEach(seedProvenance);

  it('grandfathers a legacy hunt (gate_version NULL) past B/C/D with just a segment', () => {
    insertV2Hunt({ gate_version: null });
    addSeg('Polestar 2 LR'); // no comps, no KB, no verification
    expect(gate().ok).toBe(true);
  });

  it('blocks a v2 feature-led hunt on B + C + D when nothing is recorded', () => {
    insertV2Hunt();
    addSeg('Polestar 2 LR');
    const errs = gate().errors;
    expect(errs.some((e) => e.includes('sourced+tagged comp'))).toBe(true); // B
    expect(errs.some((e) => e.includes('no spec knowledge base'))).toBe(true); // C
    expect(errs.some((e) => e.includes('is unverified'))).toBe(true); // D
  });

  it('passes a v2 feature-led hunt once comps + KB + verification exist', () => {
    insertV2Hunt();
    const seg = addSeg('Polestar 2 LR');
    addComp(seg, 24000, 1); addComp(seg, 25000, 2); addComp(seg, 26000, 3);
    addKb();
    addVerdict('verified');
    expect(gate()).toEqual({ ok: true, errors: [] });
  });

  it('KB-anchor: a segment whose TAGS carry the target key passes even when its name does not', () => {
    insertV2Hunt();
    // Name has no trace of "Polestar 2" — but the exact target key is in the tags.
    const seg = addSeg('Long Range Single Motor (2022-23)', ['polestar 2', 'long range', '78kWh']);
    addComp(seg, 24000, 1); addComp(seg, 25000, 2); addComp(seg, 26000, 3);
    addKb();
    addVerdict('verified');
    expect(gate()).toEqual({ ok: true, errors: [] });
  });

  it('KB-anchor: tag matching is exact per-element, not substring-of-concatenation', () => {
    insertV2Hunt();
    // No single tag equals "Polestar 2" (and the name does not contain it) → not anchored.
    const seg = addSeg('Long Range Single Motor (2022-23)', ['polestar', '2', 'long range']);
    addComp(seg, 24000, 1); addComp(seg, 25000, 2); addComp(seg, 26000, 3);
    addKb();
    addVerdict('verified');
    expect(gate().errors.some((e) => e.includes('does not map to any researched target'))).toBe(true);
  });

  it('KB-anchor: a segment with neither an anchoring name nor an anchoring tag fails', () => {
    insertV2Hunt();
    const seg = addSeg('Long Range Single Motor (2022-23)', ['long range', '78kWh']);
    addComp(seg, 24000, 1); addComp(seg, 25000, 2); addComp(seg, 26000, 3);
    addKb();
    addVerdict('verified');
    expect(
      gate().errors.some((e) => e.includes('does not map to any researched target') && e.includes('Long Range Single Motor')),
    ).toBe(true);
  });

  it('KB-anchor: invalid tags JSON is treated as no tags — an anchored NAME still passes', () => {
    insertV2Hunt();
    const seg = pdb
      .prepare("INSERT INTO market_segments (hunt_id, name, tags) VALUES (1, 'Polestar 2 LR', '{not json')")
      .run().lastInsertRowid as number;
    addComp(seg, 24000, 1); addComp(seg, 25000, 2); addComp(seg, 26000, 3);
    addKb();
    addVerdict('verified');
    expect(gate()).toEqual({ ok: true, errors: [] });
  });

  it('B: blocks a segment with fewer than 3 sourced+tagged comps', () => {
    insertV2Hunt();
    const seg = addSeg('Polestar 2 LR');
    addComp(seg, 24000, 1); addComp(seg, 25000, 2); // only 2
    addKb(); addVerdict('verified');
    expect(gate().errors.some((e) => e.includes('sourced+tagged comp'))).toBe(true);
  });

  it('B: does not count comps lacking source refs or tags', () => {
    insertV2Hunt();
    const seg = addSeg('Polestar 2 LR');
    // 3 comps but all missing source_item_id
    pdb.prepare(`INSERT INTO baseline_prices (segment_id, hunt_id, source_type, title, price, source_url, tags) VALUES (?,1,'active','t',1,'u','["lr"]'),(?,1,'active','t',2,'u','["lr"]'),(?,1,'active','t',3,'u','["lr"]')`).run(seg, seg, seg);
    addKb(); addVerdict('verified');
    expect(gate().errors.some((e) => e.includes('sourced+tagged comp'))).toBe(true);
  });

  it('B-bucketing: blocks a too-wide within-segment spread (mixed trims)', () => {
    insertV2Hunt();
    const seg = addSeg('Polestar 2 LR');
    addComp(seg, 20000, 1); addComp(seg, 25000, 2); addComp(seg, 70000, 3); // 3.5x
    addKb(); addVerdict('verified');
    expect(gate().errors.some((e) => e.includes('price spread'))).toBe(true);
  });

  it('C: blocks when a must-have lacks a cited source in the KB', () => {
    insertV2Hunt();
    const seg = addSeg('Polestar 2 LR');
    addComp(seg, 24000, 1); addComp(seg, 25000, 2); addComp(seg, 26000, 3);
    addKb('Polestar 2', {}); // KB exists but cites nothing for the must-have
    addVerdict('verified');
    expect(gate().errors.some((e) => e.includes('no cited source for must-have'))).toBe(true);
  });

  it('D: a contradicted verdict blocks; a waived (verified) verdict passes', () => {
    insertV2Hunt();
    const seg = addSeg('Polestar 2 LR');
    addComp(seg, 24000, 1); addComp(seg, 25000, 2); addComp(seg, 26000, 3);
    addKb();
    addVerdict('contradicted');
    expect(gate().errors.some((e) => e.includes('is contradicted'))).toBe(true);
    pdb.prepare("UPDATE claim_verifications SET verdict='verified', notes='USER-WAIVED: x' WHERE hunt_id=1").run();
    expect(gate().ok).toBe(true);
  });

  it('non-feature-led v2 hunt skips C/D but still requires sourced comps (B)', () => {
    insertV2Hunt({ criteria: NON_FEATURE_LED_CRITERIA });
    const seg = addSeg('Polestar 2 LR');
    // no KB, no verification — must NOT be required
    let errs = gate().errors;
    expect(errs.some((e) => e.includes('knowledge base'))).toBe(false);
    expect(errs.some((e) => e.includes('unverified'))).toBe(false);
    expect(errs.some((e) => e.includes('sourced+tagged comp'))).toBe(true); // B still applies
    addComp(seg, 24000, 1); addComp(seg, 25000, 2); addComp(seg, 26000, 3);
    expect(gate().ok).toBe(true);
  });
});

describe('drift guard — vendored gate copy is byte-identical to the canonical', () => {
  it('dashboard/server/deal-hunter-gate.ts === container/agent-runner/src/deal-hunter-gate.ts', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const vendored = path.join(here, '..', '..', 'server', 'deal-hunter-gate.ts');
    const canonical = path.join(
      here,
      '..',
      '..',
      '..',
      'container',
      'agent-runner',
      'src',
      'deal-hunter-gate.ts',
    );
    expect(readFileSync(vendored, 'utf8')).toBe(readFileSync(canonical, 'utf8'));
  });
});
