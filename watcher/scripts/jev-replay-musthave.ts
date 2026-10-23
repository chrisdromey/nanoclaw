/**
 * Replay Jev must-have verification against the agent's recorded requirement_checks.
 *
 * For every offer on a hunt that has (a) a Sonnet evaluation with requirement_checks and
 * (b) a stored feature list, build the same request the watcher would send, ask Jev, and
 * compare verdicts. Prints a confusion matrix per requirement and overall, then lists the
 * costly disagreements (agent said contradicted, Jev said verified). Writes every row as JSONL.
 *
 *   npx tsx scripts/jev-replay-musthave.ts --hunt 11 [--limit 50] [--concurrency 6] [--out file.jsonl] [--store]
 *
 * Read-only against the DB unless --store is given, which also upserts the Jev verdicts into
 * offer_requirement_checks (the same rows the watcher writes in shadow mode) — a backfill.
 * Acceptance test for handoff #2; re-run when JEV_MODEL changes.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { DB_PATH, JEV_MODEL } from '../src/config.js';
import { upsertOfferRequirementChecks, type Hunt, type Offer } from '../src/db.js';
import { prepareMustHaveRequest, runMustHaveChecks } from '../src/jev/shadow.js';
import type { Verdict } from '../src/jev/musthave.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const huntId = Number(arg('hunt', '11'));
const limit = Number(arg('limit', '100000'));
const concurrency = Number(arg('concurrency', '6'));
const outPath = arg('out', `jev-replay-musthave-hunt${huntId}.jsonl`);
const store = process.argv.includes('--store');

interface AgentCheck { requirement: string; verdict: Verdict; evidence?: string; tier?: string }
interface Row { evaluation_id: number; offer: Offer; agent: AgentCheck[] }

const db = new Database(DB_PATH, { readonly: !store });
if (store) db.pragma('busy_timeout = 5000');
const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(huntId) as Hunt | undefined;
if (!hunt) throw new Error(`hunt ${huntId} not found`);

// Latest evaluation with checks per offer, offers that have a feature list only.
const rows = (db.prepare(`
  SELECT e.id AS evaluation_id, e.requirement_checks, o.*
  FROM evaluations e
  JOIN offers o ON o.id = e.offer_id
  WHERE e.hunt_id = ? AND e.requirement_checks IS NOT NULL AND o.attributes LIKE '%"features"%'
    AND e.id = (SELECT MAX(id) FROM evaluations e2 WHERE e2.offer_id = e.offer_id AND e2.hunt_id = e.hunt_id AND e2.requirement_checks IS NOT NULL)
  ORDER BY e.id DESC
  LIMIT ?
`).all(huntId, limit) as Array<Offer & { evaluation_id: number; requirement_checks: string }>)
  .map((r): Row => ({ evaluation_id: r.evaluation_id, offer: r, agent: JSON.parse(r.requirement_checks) as AgentCheck[] }));

console.log(`hunt ${huntId} "${hunt.name}": ${rows.length} offers with agent checks + features; model=${JEV_MODEL}`);

const VERDICTS: Verdict[] = ['verified', 'unverified', 'contradicted'];
type Matrix = Record<Verdict, Record<Verdict, number>>;
const newMatrix = (): Matrix =>
  Object.fromEntries(VERDICTS.map((a) => [a, Object.fromEntries(VERDICTS.map((j) => [j, 0]))])) as Matrix;
const overall = newMatrix();
const perReq = new Map<string, Matrix>();
const disagreements: Array<Record<string, unknown>> = [];
let calls = 0, failed = 0, skipped = 0, inputTokens = 0;
const out = fs.createWriteStream(outPath);

async function worker(queue: Row[]): Promise<void> {
  for (;;) {
    const row = queue.shift();
    if (!row) return;
    const prepared = prepareMustHaveRequest(db, hunt!, row.offer);
    if (!prepared) { skipped++; continue; }
    const result = await runMustHaveChecks(prepared, `replay offer=${row.offer.id}`);
    calls++;
    if (!result) { failed++; continue; }
    if (store) upsertOfferRequirementChecks(db, row.offer.id, huntId, result.model, result.checks);
    for (const jev of result.checks) {
      const agent = row.agent.find((a) => a.requirement === jev.requirement);
      if (!agent || !VERDICTS.includes(agent.verdict)) continue;
      overall[agent.verdict][jev.verdict]++;
      if (!perReq.has(jev.requirement)) perReq.set(jev.requirement, newMatrix());
      perReq.get(jev.requirement)![agent.verdict][jev.verdict]++;
      const record = {
        offer_id: row.offer.id, title: row.offer.title, target: prepared.targetKey, requirement: jev.requirement,
        agent_verdict: agent.verdict, agent_evidence: agent.evidence ?? null,
        jev_verdict: jev.verdict, jev_confidence: jev.confidence, jev_evidence: jev.evidence, jev_top: jev.probabilities.slice(0, 3),
      };
      out.write(JSON.stringify(record) + '\n');
      if (agent.verdict !== jev.verdict) disagreements.push(record);
    }
    if (calls % 25 === 0) console.log(`  ${calls} calls, ${failed} failed, ${skipped} skipped`);
  }
}

function printMatrix(title: string, m: Matrix): void {
  const total = VERDICTS.reduce((s, a) => s + VERDICTS.reduce((t, j) => t + m[a][j], 0), 0);
  const agree = VERDICTS.reduce((s, v) => s + m[v][v], 0);
  console.log(`\n${title}  (n=${total}, agreement=${total ? ((100 * agree) / total).toFixed(1) : '-'}%)`);
  console.log('agent \\ jev'.padEnd(16) + VERDICTS.map((v) => v.padStart(13)).join(''));
  for (const a of VERDICTS) console.log(a.padEnd(16) + VERDICTS.map((j) => String(m[a][j]).padStart(13)).join(''));
}

const queue = [...rows];
const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));
out.end();

printMatrix('OVERALL', overall);
for (const [req, m] of perReq) printMatrix(req, m);

const costly = disagreements.filter((d) => d.agent_verdict === 'contradicted' && d.jev_verdict === 'verified');
console.log(`\nAgent contradicted → Jev verified (must be ~0): ${costly.length}`);
for (const d of costly.slice(0, 40)) {
  console.log(`  offer ${d.offer_id} [${d.target}] ${d.requirement}: jev=${d.jev_evidence} (${(d.jev_confidence as number).toFixed(2)})\n     agent: ${String(d.agent_evidence).slice(0, 160)}`);
}
const missed = disagreements.filter((d) => d.agent_verdict === 'verified' && d.jev_verdict === 'contradicted');
console.log(`\nAgent verified → Jev contradicted: ${missed.length}`);
for (const d of missed.slice(0, 20)) {
  console.log(`  offer ${d.offer_id} [${d.target}] ${d.requirement}: agent: ${String(d.agent_evidence).slice(0, 160)}`);
}
console.log(`\n${calls} Jev calls (${failed} failed, ${skipped} skipped), ${((Date.now() - started) / 1000).toFixed(0)}s, model ${JEV_MODEL}; rows in ${outPath}`);
void inputTokens;
