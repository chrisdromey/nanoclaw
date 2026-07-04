/**
 * Hunt readiness flags for the dashboard list/overview.
 *
 * These mirror (a display-only subset of) the activation gate's provenance checks so a hunt that is
 * stuck in `draft` shows *why* — not just "needs baselining" but, for a v2 feature-led hunt, whether
 * it still needs a spec knowledge base (C) or must-have verification (D). The authoritative blocker
 * is always the gate (deal-hunter-gate.ts); these are hints computed from cheap counts.
 *
 * Kept out of the vendored gate file on purpose: it's a UI affordance, not part of the gate contract,
 * and it simplifies target enumeration to `criteria.targets` keys (the only feature-led shape today).
 */

export interface ReadinessCounts {
  segment_count: number;
  kb_count: number;
  verified_count: number;
}

export interface ReadinessFlags {
  needs_baselining: boolean;
  needs_kb: boolean;
  needs_verification: boolean;
}

function parseMustHaves(criteria: Record<string, unknown>): string[] {
  const intent = criteria.intent;
  if (!intent || typeof intent !== 'object') return [];
  const mh = (intent as Record<string, unknown>).must_have;
  if (!Array.isArray(mh)) return [];
  return mh.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
}

function targetCount(criteria: Record<string, unknown>, featureLed: boolean): number {
  const t = criteria.targets;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const n = Object.keys(t as Record<string, unknown>).length;
    if (n > 0) return n;
  }
  return featureLed ? 1 : 0; // matches the gate's synthetic single-target fallback
}

export function computeReadiness(
  hunt: { status: string; criteria: string; gate_version?: number | null },
  counts: ReadinessCounts,
): ReadinessFlags {
  const open = hunt.status !== 'closed';
  const v2 = (hunt.gate_version ?? 1) >= 2;
  let criteria: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(hunt.criteria || '{}');
    if (parsed && typeof parsed === 'object') criteria = parsed as Record<string, unknown>;
  } catch {
    /* leave criteria empty */
  }
  const mustHaves = parseMustHaves(criteria);
  const featureLed = mustHaves.length > 0;
  const targets = targetCount(criteria, featureLed);

  return {
    needs_baselining: open && counts.segment_count === 0,
    needs_kb: open && v2 && featureLed && counts.kb_count < targets,
    needs_verification:
      open && v2 && featureLed && counts.verified_count < targets * mustHaves.length,
  };
}
