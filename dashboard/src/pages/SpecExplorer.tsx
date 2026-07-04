import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatPrice, formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { parseCarAttributes, parseFeatures } from '@/lib/attributes';
import {
  matchMustHaveToFeatures,
  matchMustHaveToVerification,
} from '@/lib/must-have-matcher';
import { fitLinearTrend, residual } from '@/lib/regression';
import {
  matchToSegment,
  assessPrice,
  assessmentColor,
  assessmentLabel,
} from '@/lib/segment-matcher';
import StatusBadge, { type BadgeVariant } from '@/components/shared/StatusBadge';
import MarkdownView from '@/components/shared/MarkdownView';
import MustHaveChips from '@/components/verticals/cars/MustHaveChips';
import type {
  CarAttributes,
  HuntBaselineData,
  HuntTargetsData,
  SegmentWithStats,
  TargetInfo,
  TargetVerification,
} from '@shared/types';
import { ExternalLink } from 'lucide-react';

interface KbDocument {
  target_key: string;
  kb_path: string;
  built_at: string;
  markdown: string;
}

const VERDICT_VARIANTS: Record<string, BadgeVariant> = {
  verified: 'success',
  unverified: 'warning',
  contradicted: 'error',
};

function VerdictBadge({ verdict }: { verdict: string }) {
  const variant = VERDICT_VARIANTS[verdict.toLowerCase()];
  if (!variant) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-tiny font-medium bg-zinc-800 text-zinc-500">
        {verdict}
      </span>
    );
  }
  return <StatusBadge variant={variant}>{verdict}</StatusBadge>;
}

/** "45k mi" / "820 mi" style mileage. */
function formatMileage(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k mi` : `${n} mi`;
}

/** Signed residual: "−£1,400" (under trend) / "+£620" (over trend). */
function formatResidual(r: number): string {
  const abs = Math.abs(Math.round(r)).toLocaleString('en-GB');
  return r <= 0 ? `−£${abs}` : `+£${abs}`;
}

/** Case-insensitive "one contains the other" for make/model matching. */
function ciMatches(a: string | undefined, b: unknown): boolean {
  if (!a || typeof b !== 'string' || b.trim() === '') return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al.includes(bl) || bl.includes(al);
}

/** Hunt target keys present in a segment's tags (case-insensitive element match). */
function targetKeysInTags(
  segment: SegmentWithStats,
  targets: TargetInfo[],
): string[] {
  let tags: unknown;
  try {
    tags = JSON.parse(segment.tags);
  } catch {
    return [];
  }
  if (!Array.isArray(tags)) return [];
  const lower = tags
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.toLowerCase());
  return targets
    .filter((t) => lower.includes(t.target_key.toLowerCase()))
    .map((t) => t.target_key);
}

/** Most-specific (longest) string wins — "Kia EV6 GT" beats "Kia EV6". */
function longestFirst(values: string[]): string {
  return [...values].sort((a, b) => b.length - a.length)[0];
}

/**
 * Assign a baseline offer to exactly ONE hunt target, so overlapping model
 * names ("EV6" vs "EV6 GT") don't cross-contaminate inventory, trend fits, or
 * option-pack warnings. Rules: exact model equality (case-insensitive) wins;
 * a unique contains-match counts; multiple contains-matches go to the target
 * with the LONGEST criteria model string (most specific). Fallback: the
 * matched segment's tags — again most-specific when a segment carries
 * multiple target keys.
 */
function resolveTargetKeyForOffer(
  attrs: CarAttributes,
  title: string,
  targets: TargetInfo[],
  segments: SegmentWithStats[],
): string | null {
  const candidates = targets.filter((t) => {
    const c = t.criteria;
    return !!c && ciMatches(attrs.make, c.make) && ciMatches(attrs.model, c.model);
  });

  const model = attrs.model?.trim().toLowerCase();
  if (model) {
    const exact = candidates.find((t) => {
      const cm = t.criteria?.model;
      return typeof cm === 'string' && cm.trim().toLowerCase() === model;
    });
    if (exact) return exact.target_key;
  }
  if (candidates.length === 1) return candidates[0].target_key;
  if (candidates.length > 1) {
    const byModelLength = [...candidates].sort(
      (a, b) =>
        String(b.criteria?.model ?? '').length -
        String(a.criteria?.model ?? '').length,
    );
    return byModelLength[0].target_key;
  }

  // Fallback: match the title against segments that carry a target key in
  // their tags; most-specific key wins when a segment names several.
  const keyedSegments = segments
    .map((seg) => ({ seg, keys: targetKeysInTags(seg, targets) }))
    .filter((entry) => entry.keys.length > 0);
  const m = matchToSegment(title, keyedSegments.map((entry) => entry.seg));
  if (!m) return null;
  const keys = keyedSegments.find((entry) => entry.seg === m.segment)?.keys ?? [];
  return keys.length > 0 ? longestFirst(keys) : null;
}

/** Render a criteria record as "make: Kia · model: EV6 · year_min: 2021". */
function criteriaSummary(criteria: Record<string, unknown> | null): string {
  if (!criteria) return '';
  return Object.entries(criteria)
    .filter(
      ([, v]) =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    )
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' · ');
}

export default function SpecExplorer() {
  const { id, targetKey } = useParams();
  const huntId = parseInt(id!);
  // react-router already decodes the param
  const key = targetKey ?? '';

  const { data: targetsData, isLoading: targetsLoading } = useQuery({
    queryKey: queryKeys.hunts.targets(huntId),
    queryFn: () => apiGet<HuntTargetsData>(`/hunts/${huntId}/targets`),
  });

  const target = targetsData?.targets.find((t) => t.target_key === key) ?? null;

  const { data: kbDoc, isLoading: kbLoading } = useQuery({
    queryKey: queryKeys.hunts.targetKb(huntId, key),
    queryFn: () =>
      apiGet<KbDocument>(
        `/hunts/${huntId}/targets/${encodeURIComponent(key)}/kb`,
      ),
    enabled: !!target?.kb,
  });

  const { data: baseline } = useQuery({
    queryKey: queryKeys.hunts.baseline(huntId),
    queryFn: () => apiGet<HuntBaselineData>(`/hunts/${huntId}/baseline`),
    staleTime: 60_000,
    enabled: !!target,
  });

  if (targetsLoading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-64 bg-zinc-800 rounded" />
        <div className="h-32 bg-surface border border-zinc-800 rounded-lg" />
        <div className="h-64 bg-surface border border-zinc-800 rounded-lg" />
      </div>
    );
  }

  if (!target) {
    return (
      <div className="py-12 text-center">
        <p className="text-zinc-400 mb-3">
          No target &ldquo;{key}&rdquo; found on this hunt.
        </p>
        <Link
          to={`/hunts/${huntId}`}
          className="text-accent hover:underline text-sm"
        >
          &larr; Back to hunt
        </Link>
      </div>
    );
  }

  const mustHaves = targetsData?.must_have ?? [];

  // --- Must-have ↔ verification matching (fuzzy) ---
  const verificationRows = mustHaves.map((mh) => ({
    mustHave: mh,
    verification: matchMustHaveToVerification(mh, target.verifications),
    citations: target.kb?.must_have_citations?.[mh],
  }));
  const matchedVerifications = new Set<TargetVerification>(
    verificationRows
      .map((r) => r.verification)
      .filter((v): v is TargetVerification => v != null),
  );
  const otherVerifications = target.verifications.filter(
    (v) => !matchedVerifications.has(v),
  );

  // --- This target's live offers ---
  // Each offer is assigned to exactly one target (most-specific wins) so a
  // "Kia EV6 GT" listing never appears on the plain "Kia EV6" page.
  const allSegments = baseline?.segments ?? [];
  const allTargets = targetsData?.targets ?? [];
  const criteria = target.criteria;

  const targetOffers = (baseline?.active_offer_prices ?? [])
    .map((offer) => ({
      offer,
      attrs: parseCarAttributes(offer.attributes),
      features: parseFeatures(offer.attributes),
    }))
    .filter(
      ({ offer, attrs }) =>
        resolveTargetKeyForOffer(attrs, offer.title, allTargets, allSegments) ===
        key,
    );

  // --- Option-pack warnings ---
  const optionPackWarnings = mustHaves
    .map((mh) => ({
      mustHave: mh,
      optionalCount: targetOffers.filter(
        ({ features }) =>
          matchMustHaveToFeatures(mh, features).status === 'optional',
      ).length,
    }))
    .filter((w) => w.optionalCount > 0);

  // --- Trend fit + inventory rows ---
  const fit = fitLinearTrend(
    targetOffers
      .filter(
        ({ offer, attrs }) =>
          attrs.mileage_num != null && offer.current_price != null,
      )
      .map(({ offer, attrs }) => ({
        x: attrs.mileage_num!,
        y: offer.current_price!,
      })),
  );

  const inventoryRows = targetOffers
    .map((entry) => {
      const { offer, attrs } = entry;
      const res =
        fit && attrs.mileage_num != null && offer.current_price != null
          ? residual(offer.current_price, attrs.mileage_num, fit)
          : null;
      const segMatch = matchToSegment(offer.title, allSegments);
      const assessment = assessPrice(
        offer.current_price,
        segMatch?.segment ?? null,
      );
      return { ...entry, res, assessment };
    })
    .sort((a, b) => {
      if (a.res == null && b.res == null) return 0;
      if (a.res == null) return 1;
      if (b.res == null) return -1;
      return a.res - b.res;
    });

  return (
    <div>
      {/* --- Header --- */}
      <nav className="flex items-center gap-1.5 text-sm text-zinc-500 mb-2">
        <Link to="/hunts" className="hover:text-zinc-300 transition-colors">
          Hunts
        </Link>
        <span className="text-zinc-600">&gt;</span>
        <Link
          to={`/hunts/${huntId}`}
          className="hover:text-zinc-300 transition-colors"
        >
          Hunt #{huntId}
        </Link>
        <span className="text-zinc-600">&gt;</span>
        <span className="text-zinc-400">{target.target_key}</span>
      </nav>

      <h1 className="text-page-title text-zinc-50 mb-1">{target.target_key}</h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-tiny text-zinc-500 mb-6">
        {criteria && criteriaSummary(criteria) && (
          <span>{criteriaSummary(criteria)}</span>
        )}
        {target.kb && (
          <>
            <span>KB built {formatRelativeTime(target.kb.built_at)}</span>
            <span>
              {target.kb.citation_count} cited source
              {target.kb.citation_count !== 1 ? 's' : ''}
            </span>
          </>
        )}
      </div>

      {/* --- Must-have verification --- */}
      <div className="bg-surface border border-zinc-800 rounded-lg p-4 mb-6">
        <h3 className="text-heading text-zinc-300 mb-3">
          Must-have verification
        </h3>
        {mustHaves.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No must-haves defined on this hunt.
          </p>
        ) : (
          <div className="space-y-2">
            {verificationRows.map(({ mustHave, verification, citations }) => (
              <div key={mustHave} className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-zinc-300">{mustHave}</span>
                {verification ? (
                  <>
                    <span title={verification.notes ?? undefined}>
                      <VerdictBadge verdict={verification.verdict} />
                    </span>
                    {verification.evidence_url && (
                      <a
                        href={verification.evidence_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline inline-flex items-center gap-1 text-tiny"
                      >
                        <ExternalLink size={11} /> evidence
                      </a>
                    )}
                    {citations != null && (
                      <span className="text-tiny text-zinc-500">
                        {citations} citation{citations !== 1 ? 's' : ''}
                      </span>
                    )}
                    {verification.notes && (
                      <span className="w-full text-tiny text-zinc-500 pl-0">
                        {verification.notes}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-md text-tiny font-medium bg-zinc-800 text-zinc-500">
                    no verification recorded
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {otherVerifications.length > 0 && (
          <div className="mt-4 pt-3 border-t border-zinc-800">
            <p className="text-tiny text-zinc-500 mb-2">Other verifications</p>
            <div className="space-y-1.5">
              {otherVerifications.map((v) => (
                <div
                  key={`${v.feature}-${v.checked_at}`}
                  className="flex flex-wrap items-center gap-2 text-zinc-500"
                >
                  <span className="text-sm">{v.feature}</span>
                  <span title={v.notes ?? undefined}>
                    <VerdictBadge verdict={v.verdict} />
                  </span>
                  {v.evidence_url && (
                    <a
                      href={v.evidence_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-1 text-tiny"
                    >
                      <ExternalLink size={11} /> evidence
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* --- Option-pack warnings --- */}
      {optionPackWarnings.length > 0 && (
        <div className="space-y-2 mb-6">
          {optionPackWarnings.map(({ mustHave, optionalCount }) => (
            <div
              key={mustHave}
              className="border-l-2 border-warning bg-warning/5 px-4 py-3 text-sm text-zinc-300"
            >
              &#9888; {mustHave}: optional pack on {optionalCount} of{' '}
              {targetOffers.length} current listings &mdash; verify per car
            </div>
          ))}
        </div>
      )}

      {/* --- Live inventory --- */}
      <div className="bg-surface border border-zinc-800 rounded-lg p-4 mb-6">
        <h3 className="text-heading text-zinc-300 mb-3">Live inventory</h3>
        {inventoryRows.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No current listings matched to this target.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-zinc-500">
                  <th className="font-medium px-2 py-1.5">Listing</th>
                  <th className="font-medium px-2 py-1.5">Price</th>
                  <th className="font-medium px-2 py-1.5">Mileage</th>
                  <th className="font-medium px-2 py-1.5">Year</th>
                  <th className="font-medium px-2 py-1.5">vs trend</th>
                  <th className="font-medium px-2 py-1.5">Band</th>
                  <th className="font-medium px-2 py-1.5">Must-haves</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {inventoryRows.map(
                  ({ offer, attrs, features, res, assessment }) => (
                    <tr key={offer.offer_id}>
                      <td className="px-2 py-1.5 max-w-64">
                        <Link
                          to={`/offers/${offer.offer_id}`}
                          className="text-accent hover:underline block truncate"
                          title={offer.title}
                        >
                          {offer.title}
                        </Link>
                      </td>
                      <td className="px-2 py-1.5 font-mono text-zinc-300 whitespace-nowrap">
                        {formatPrice(offer.current_price)}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-zinc-400 whitespace-nowrap">
                        {attrs.mileage_num != null
                          ? formatMileage(attrs.mileage_num)
                          : '—'}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-zinc-400">
                        {attrs.year ?? '—'}
                      </td>
                      <td
                        className={cn(
                          'px-2 py-1.5 font-mono whitespace-nowrap',
                          res == null
                            ? 'text-zinc-500'
                            : res <= 0
                              ? 'text-success'
                              : 'text-danger',
                        )}
                      >
                        {res != null ? formatResidual(res) : '—'}
                      </td>
                      <td
                        className={cn('px-2 py-1.5', assessmentColor(assessment))}
                      >
                        {assessmentLabel(assessment) || '—'}
                      </td>
                      <td className="px-2 py-1.5">
                        <MustHaveChips
                          mustHaves={mustHaves}
                          features={features}
                          mode="compact"
                        />
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* --- KB document --- */}
      <div className="bg-surface border border-zinc-800 rounded-lg p-4">
        <h3 className="text-heading text-zinc-300 mb-3">Knowledge base</h3>
        {!target.kb ? (
          <p className="text-sm text-zinc-500">
            No knowledge base built for this target yet.
          </p>
        ) : kbLoading ? (
          <div className="animate-pulse space-y-2">
            <div className="h-4 w-3/4 bg-zinc-800 rounded" />
            <div className="h-4 w-full bg-zinc-800 rounded" />
            <div className="h-4 w-5/6 bg-zinc-800 rounded" />
            <div className="h-32 w-full bg-zinc-800 rounded" />
          </div>
        ) : kbDoc ? (
          <MarkdownView markdown={kbDoc.markdown} />
        ) : (
          <p className="text-sm text-zinc-500">Failed to load knowledge base.</p>
        )}
      </div>
    </div>
  );
}
