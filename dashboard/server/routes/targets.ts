import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { getDealDb } from '../db.js';
import { GROUP_DIR } from '../config.js';
import { parseJsonField } from '../parse.js';
import type {
  HuntTargetsData,
  TargetInfo,
  TargetVerification,
} from '../../shared/types.js';

export const targetsRoutes = new Hono();

interface KbRow {
  target_key: string;
  kb_path: string;
  citation_count: number;
  must_have_citations: string | null;
  built_at: string;
}

interface VerificationRow extends TargetVerification {
  target_key: string;
}

// Hunt targets: union of criteria.targets keys and knowledge_base rows, each
// with its criteria object, KB coverage metadata, and claim verifications.
// Vertical-agnostic: a hunt without criteria.targets (e.g. computers) returns
// targets: [] rather than an error.
targetsRoutes.get('/hunts/:id/targets', (c) => {
  const db = getDealDb();
  const huntId = parseInt(c.req.param('id'));

  const hunt = db
    .prepare('SELECT id, vertical, criteria FROM hunts WHERE id = ?')
    .get(huntId) as
    | { id: number; vertical: string; criteria: string | null }
    | undefined;
  if (!hunt) return c.json({ error: 'Hunt not found' }, 404);

  // Defensive parsing throughout: malformed criteria JSON (or unexpected
  // shapes) degrades to empty must_have / targets, never a 500.
  const criteria = parseJsonField<Record<string, unknown>>(hunt.criteria, {});
  const intent =
    criteria.intent && typeof criteria.intent === 'object'
      ? (criteria.intent as Record<string, unknown>)
      : {};
  const mustHave = Array.isArray(intent.must_have)
    ? intent.must_have.filter((f): f is string => typeof f === 'string')
    : [];

  const criteriaTargets =
    criteria.targets &&
    typeof criteria.targets === 'object' &&
    !Array.isArray(criteria.targets)
      ? (criteria.targets as Record<string, unknown>)
      : {};

  const kbRows = db
    .prepare(
      `SELECT target_key, kb_path, citation_count, must_have_citations, built_at
      FROM knowledge_base WHERE hunt_id = ? ORDER BY id ASC`,
    )
    .all(huntId) as KbRow[];
  const kbByTarget = new Map(kbRows.map((r) => [r.target_key, r]));

  const verifications = db
    .prepare(
      `SELECT target_key, feature, verdict, evidence_url, notes, checked_at
      FROM claim_verifications WHERE hunt_id = ? ORDER BY id ASC`,
    )
    .all(huntId) as VerificationRow[];

  // Stable order: criteria key order first, then KB-only extras in row order.
  const orderedKeys = Object.keys(criteriaTargets);
  for (const row of kbRows) {
    if (!orderedKeys.includes(row.target_key)) orderedKeys.push(row.target_key);
  }

  const targets: TargetInfo[] = orderedKeys.map((targetKey) => {
    const kb = kbByTarget.get(targetKey);
    const targetCriteria = criteriaTargets[targetKey];
    return {
      target_key: targetKey,
      criteria:
        targetCriteria && typeof targetCriteria === 'object'
          ? (targetCriteria as Record<string, unknown>)
          : null,
      kb: kb
        ? {
            kb_path: kb.kb_path,
            citation_count: kb.citation_count,
            must_have_citations: parseJsonField(kb.must_have_citations, {}),
            built_at: kb.built_at,
          }
        : null,
      verifications: verifications
        .filter((v) => v.target_key === targetKey)
        .map(({ feature, verdict, evidence_url, notes, checked_at }) => ({
          feature,
          verdict,
          evidence_url,
          notes,
          checked_at,
        })),
    };
  });

  const payload: HuntTargetsData = {
    hunt_id: hunt.id,
    vertical: hunt.vertical,
    must_have: mustHave,
    targets,
  };
  return c.json(payload);
});

// Serve a target's knowledge-base markdown. kb_path comes ONLY from the DB
// row, never the request; it resolves against GROUP_DIR and anything that
// escapes it is rejected (deliberately stricter than the agent-log serving).
targetsRoutes.get('/hunts/:id/targets/:targetKey/kb', (c) => {
  const db = getDealDb();
  const huntId = parseInt(c.req.param('id'));
  const targetKey = c.req.param('targetKey');

  const row = db
    .prepare(
      'SELECT target_key, kb_path, built_at FROM knowledge_base WHERE hunt_id = ? AND target_key = ?',
    )
    .get(huntId, targetKey) as
    | { target_key: string; kb_path: string; built_at: string }
    | undefined;
  if (!row) return c.json({ error: 'Knowledge base not found' }, 404);

  const resolved = path.resolve(GROUP_DIR, row.kb_path);
  if (!resolved.startsWith(GROUP_DIR + path.sep)) {
    return c.json({ error: 'invalid path' }, 400);
  }
  if (!fs.existsSync(resolved)) {
    return c.json({ error: 'Knowledge base file not found' }, 404);
  }
  // path.resolve is lexical only — re-check after resolving symlinks so a link
  // planted inside the group dir cannot serve a file outside it
  if (!fs.realpathSync(resolved).startsWith(GROUP_DIR + path.sep)) {
    return c.json({ error: 'invalid path' }, 400);
  }

  const markdown = fs.readFileSync(resolved, 'utf-8');
  return c.json({
    target_key: row.target_key,
    kb_path: row.kb_path,
    built_at: row.built_at,
    markdown,
  });
});
