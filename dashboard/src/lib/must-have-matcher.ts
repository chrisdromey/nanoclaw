/**
 * Fuzzy matcher between hunt must-have strings and listing feature /
 * verification strings. Pure — no I/O, no React.
 *
 * Why fuzzy: must_have strings ("Adaptive cruise control (ACC)") never exactly
 * match feature-list items ("Adaptive Cruise Control with Stop & Go") or
 * claim_verifications.feature rows ("Lane Keep Assist or Lane Centering").
 *
 * Pipeline: normalize (lowercase, strip parentheticals, strip punctuation,
 * tokenize, drop stopwords) → split must-haves into "or"/" / " alternatives →
 * score each (alternative, candidate) pair by alternative-in-candidate
 * token-boundary containment, falling back to the exclusion-aware alias table.
 */

import type { NormalisedFeatureCategory, TargetVerification } from '@shared/types';

const STOPWORDS = new Set([
  'with', 'and', 'or', 'not', 'just', 'etc',
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at',
  'via', 'plus', 'inc', 'incl', 'including',
]);

/**
 * Normalize free text into match tokens: lowercase, parenthetical content
 * removed, punctuation stripped, stopwords dropped.
 */
export function normalizeFeatureText(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

export interface FeatureAliasGroup {
  /** Canonical name for the group (docs/debugging only). */
  canonical: string;
  /** Phrases (normalized on use) that all denote this feature. */
  aliases: string[];
  /**
   * Phrases that must NOT count as this feature. They are removed from the
   * candidate text before alias matching, so "Lane Departure Warning" alone
   * never matches the lane-keep group, but "LDW + Lane Keep Assist" still does.
   */
  excludes?: string[];
}

/**
 * Extensible alias table. Push new groups to extend; keep aliases specific
 * enough that token-boundary containment cannot false-positive.
 */
export const FEATURE_ALIASES: FeatureAliasGroup[] = [
  {
    canonical: 'adaptive cruise control',
    aliases: [
      'acc',
      'adaptive cruise',
      'adaptive cruise control',
      'smart cruise control',
      'intelligent cruise control',
    ],
  },
  {
    canonical: 'lane keep',
    aliases: [
      'lane keep',
      'lane keeping',
      'lane centering',
      'lane centring',
      'lane assist',
      'lane keep assist',
      'lane keeping assist',
      'lane following assist',
    ],
    excludes: ['lane departure warning', 'lane departure alert', 'lane departure'],
  },
  { canonical: 'isofix', aliases: ['isofix', 'iso fix'] },
  { canonical: 'apple carplay', aliases: ['carplay', 'apple carplay'] },
  { canonical: 'android auto', aliases: ['android auto'] },
  { canonical: 'heat pump', aliases: ['heat pump'] },
  {
    canonical: 'sat nav',
    aliases: ['sat nav', 'satnav', 'navigation', 'satellite navigation', 'navigation system'],
  },
  {
    canonical: 'parking sensors',
    aliases: ['parking sensors', 'parking sensor', 'front rear parking sensors', 'rear parking sensors'],
  },
  {
    canonical: 'reversing camera',
    aliases: [
      'reversing camera',
      'reverse camera',
      'rear camera',
      'rear view camera',
      'rearview camera',
      'backup camera',
    ],
  },
];

/** True when `needle` appears as a contiguous token run inside `hay`. */
function containsPhrase(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || hay.length < needle.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Remove every contiguous occurrence of `phrase` from `tokens`. */
function removePhrase(tokens: string[], phrase: string[]): string[] {
  if (phrase.length === 0 || tokens.length < phrase.length) return tokens;
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let match = i + phrase.length <= tokens.length;
    if (match) {
      for (let j = 0; j < phrase.length; j++) {
        if (tokens[i + j] !== phrase[j]) {
          match = false;
          break;
        }
      }
    }
    if (match) {
      i += phrase.length;
    } else {
      out.push(tokens[i]);
      i++;
    }
  }
  return out;
}

/**
 * Score one must-have alternative against one candidate string's tokens.
 * 0 = no match. 1 = exact. Containment scores by token-length ratio;
 * alias-table matches score 0.8.
 */
function scoreMatch(alt: string[], candRaw: string[]): number {
  if (alt.length === 0 || candRaw.length === 0) return 0;

  // Direct: alternative contained in candidate at token boundaries (equality
  // included). Deliberately one-directional — reverse containment (candidate
  // inside the alternative) would let a weaker feature like plain "Cruise
  // Control" satisfy the "Adaptive cruise control" must-have. Abbreviations
  // ("ACC") are the alias table's job.
  if (containsPhrase(candRaw, alt)) {
    const ratio = Math.min(alt.length, candRaw.length) / Math.max(alt.length, candRaw.length);
    return ratio === 1 ? 1 : 0.6 + 0.4 * ratio;
  }

  // Alias table (exclusion-aware).
  for (const group of FEATURE_ALIASES) {
    const aliasTokens = group.aliases
      .map(normalizeFeatureText)
      .filter((a) => a.length > 0);
    const altInGroup = aliasTokens.some((a) => containsPhrase(alt, a));
    if (!altInGroup) continue;

    let cand = candRaw;
    const excludes = (group.excludes ?? [])
      .map(normalizeFeatureText)
      .filter((e) => e.length > 0)
      .sort((a, b) => b.length - a.length); // longest first, no partial leftovers
    for (const ex of excludes) cand = removePhrase(cand, ex);
    if (cand.length === 0) continue;

    if (aliasTokens.some((a) => containsPhrase(cand, a))) return 0.8;
  }

  return 0;
}

/** True when the alternative contains any alias phrase from the table. */
function altHitsAliasTable(alt: string[]): boolean {
  for (const group of FEATURE_ALIASES) {
    for (const alias of group.aliases) {
      const aliasTokens = normalizeFeatureText(alias);
      if (aliasTokens.length > 0 && containsPhrase(alt, aliasTokens)) return true;
    }
  }
  return false;
}

/**
 * Split a must-have string into normalized alternatives.
 * "Lane keep / lane centering (not just lane departure warning)" →
 * [["lane","keep"], ["lane","centering"]]. Parentheticals stripped first so
 * qualifier text never leaks into an alternative.
 *
 * Slashes only split when surrounded by whitespace: "Front/rear parking
 * sensors" is compound wording, not alternatives, and fragmenting it would
 * produce a junk ["front"] alternative that false-positives against e.g.
 * "Front Fog Lights". As a safety net, when a split did occur, single-token
 * fragments are discarded unless the alias table knows them (e.g. "isofix").
 */
export function splitMustHaveAlternatives(mustHave: string): string[][] {
  const alternatives = mustHave
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+\/\s+|\s+or\s+/i)
    .map(normalizeFeatureText)
    .filter((tokens) => tokens.length > 0);
  if (alternatives.length <= 1) return alternatives;
  return alternatives.filter((alt) => alt.length > 1 || altHitsAliasTable(alt));
}

export interface MustHaveFeatureMatch {
  status: 'standard' | 'optional' | 'not_listed';
  matchedFeature?: string;
  category?: string;
}

/**
 * Match one must-have against a listing's normalised features.
 * Standard beats Optional when both match (an Optional-only match means
 * "verify with dealer"). Items with unknown/null type count as standard —
 * they are listed as present.
 */
export function matchMustHaveToFeatures(
  mustHave: string,
  features: NormalisedFeatureCategory[],
): MustHaveFeatureMatch {
  const alts = splitMustHaveAlternatives(mustHave);
  if (alts.length === 0) return { status: 'not_listed' };

  let best: { score: number; standard: boolean; name: string; category: string } | null = null;

  for (const cat of features) {
    for (const item of cat.items) {
      const candTokens = normalizeFeatureText(item.name);
      let score = 0;
      for (const alt of alts) score = Math.max(score, scoreMatch(alt, candTokens));
      if (score <= 0) continue;

      const standard = item.type?.toLowerCase() !== 'optional';
      const better =
        !best ||
        (standard && !best.standard) ||
        (standard === best.standard && score > best.score);
      if (better) best = { score, standard, name: item.name, category: cat.category };
    }
  }

  if (!best) return { status: 'not_listed' };
  return {
    status: best.standard ? 'standard' : 'optional',
    matchedFeature: best.name,
    category: best.category,
  };
}

/**
 * Match one must-have against claim-verification rows using the same scorer.
 * Returns the best-scoring verification, or null when nothing matches.
 */
export function matchMustHaveToVerification(
  mustHave: string,
  verifications: TargetVerification[],
): TargetVerification | null {
  const alts = splitMustHaveAlternatives(mustHave);
  if (alts.length === 0) return null;

  let best: { score: number; verification: TargetVerification } | null = null;
  for (const verification of verifications) {
    const candTokens = normalizeFeatureText(verification.feature);
    let score = 0;
    for (const alt of alts) score = Math.max(score, scoreMatch(alt, candTokens));
    if (score > 0 && (!best || score > best.score)) best = { score, verification };
  }
  return best?.verification ?? null;
}
