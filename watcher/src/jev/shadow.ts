/**
 * Glue between the DB and the pure must-have module: resolves a hunt's must-haves, the offer's
 * target (make/model) and its KB cues, builds the request, asks Jev, and stores the verdicts.
 * Shadow mode: results are stored for the dashboard/evaluator to read; nothing is dismissed.
 */
import path from 'path';
import type Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';
import { parseAttributes, upsertOfferRequirementChecks, type Hunt, type Offer } from '../db.js';
import { logger } from '../logger.js';
import { askJev } from './client.js';
import { buildMustHaveRequest, loadKbText, mapMustHaveAnswers, type BuiltRequest, type FeatureCategory, type JevRequirementCheck } from './musthave.js';

const GROUP_DIR = path.dirname(DB_PATH);

interface Criteria {
  intent?: { must_have?: string[] };
  targets?: Record<string, { make?: string; model?: string }>;
}

function parseCriteria(hunt: Hunt): Criteria {
  try {
    return JSON.parse(hunt.criteria) as Criteria;
  } catch {
    return {};
  }
}

/** Target key whose make/model match the offer's attributes (case-insensitive), if any. */
export function findTargetKey(criteria: Criteria, attrs: Record<string, unknown>): string | null {
  const make = String(attrs.make ?? '').toLowerCase();
  const model = String(attrs.model ?? '').toLowerCase();
  if (!make || !model) return null;
  for (const [key, t] of Object.entries(criteria.targets ?? {})) {
    if (String(t.make ?? '').toLowerCase() === make && String(t.model ?? '').toLowerCase() === model) return key;
  }
  return null;
}

export interface PreparedMustHaveRequest {
  mustHaves: string[];
  built: BuiltRequest;
  targetKey: string | null;
}

/** Null when the hunt has no must-haves or the offer has no feature list (nothing to judge). */
export function prepareMustHaveRequest(db: Database.Database, hunt: Hunt, offer: Offer): PreparedMustHaveRequest | null {
  const criteria = parseCriteria(hunt);
  const mustHaves = criteria.intent?.must_have ?? [];
  const attrs = parseAttributes(offer.attributes);
  const features = Array.isArray(attrs.features) ? (attrs.features as FeatureCategory[]) : [];
  if (mustHaves.length === 0 || features.length === 0) return null;

  const targetKey = findTargetKey(criteria, attrs);
  let kbText: string | null = null;
  if (targetKey) {
    const kb = db
      .prepare('SELECT kb_path FROM knowledge_base WHERE hunt_id = ? AND target_key = ?')
      .get(hunt.id, targetKey) as { kb_path: string } | undefined;
    if (kb) kbText = loadKbText(path.join(GROUP_DIR, kb.kb_path));
  }

  const built = buildMustHaveRequest({
    mustHaves,
    features,
    subTitle: typeof attrs.subTitle === 'string' ? attrs.subTitle : null,
    year: typeof attrs.year === 'number' ? attrs.year : null,
    description: typeof attrs.description === 'string' ? attrs.description : null,
    kbText,
  });
  return { mustHaves, built, targetKey };
}

/** Ask Jev and return the mapped checks plus the answering model; null when disabled/failed. */
export async function runMustHaveChecks(
  prepared: PreparedMustHaveRequest,
  tag: string,
): Promise<{ checks: JevRequirementCheck[]; model: string } | null> {
  const res = await askJev(prepared.built.state, prepared.built.questions, tag);
  if (!res) return null;
  return { checks: mapMustHaveAnswers(prepared.built, prepared.mustHaves, res.answers), model: res.model };
}

/** Shadow-mode entry point used by the scheduler after detail enrichment. Never throws. */
export async function shadowMustHaveChecks(db: Database.Database, hunt: Hunt, offer: Offer): Promise<void> {
  try {
    const prepared = prepareMustHaveRequest(db, hunt, offer);
    if (!prepared) return;
    const result = await runMustHaveChecks(prepared, `musthave hunt=${hunt.id} offer=${offer.id}`);
    if (!result) return;
    upsertOfferRequirementChecks(db, offer.id, hunt.id, result.model, result.checks);
    logger.info(
      { huntId: hunt.id, offerId: offer.id, verdicts: result.checks.map((c) => `${c.verdict}@${c.confidence.toFixed(2)}`) },
      'Jev must-have checks stored (shadow)',
    );
  } catch (err) {
    logger.error({ huntId: hunt.id, offerId: offer.id, err }, 'Jev shadow must-have check failed');
  }
}
