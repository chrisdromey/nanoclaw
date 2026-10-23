/**
 * Jev must-have verification (handoff #2) — the "pre-parsed value extraction" pattern.
 *
 * Code lists every candidate evidence line from the listing (derivative string, categorised
 * feature list, description sentences that share a token with the requirement). Jev picks the
 * line that shows the requirement is fitted, or `none`. Code copies the chosen line verbatim as
 * evidence, so a `verified` verdict can never cite a feature the listing does not contain.
 *
 * Pure: no I/O except loadKbCues(). Thresholds are tuned by scripts/jev-replay-musthave.ts.
 */
import fs from 'fs';
import { choice, noul, type ChoiceResponse, type JsonValue, type NoulResponse, type Question, type ScoreResponse } from '@typesafe-ai/sdk';

export interface FeatureCategory {
  category: string;
  items: Array<{ name: string; type?: string | null }>;
}

export interface MustHaveInput {
  mustHaves: string[];
  features: FeatureCategory[];
  subTitle?: string | null;
  year?: number | null;
  description?: string | null;
  /** Full product-knowledge markdown for this make/model, if any; cues are extracted per requirement. */
  kbText?: string | null;
}

export type Verdict = 'verified' | 'unverified' | 'contradicted';

export interface JevRequirementCheck {
  requirement: string;
  verdict: Verdict;
  evidence: string | null;
  confidence: number;
  probabilities: Array<{ label: string; p: number }>;
}

export interface BuiltRequest {
  state: { [key: string]: JsonValue };
  questions: Record<string, Question>;
  candidates: Record<string, string[]>;
}

// Any non-`none` line is valid evidence, so the verdict hinges on P(none), not on which line won:
// verified when P(some line shows it) = 1 - P(none) is at least this; contradicted when P(none) is
// at least this AND the feature list looks populated. Two equally good lines splitting the mass
// (e.g. "Lane Keep Assist" and "Lane Follow Assist") must not turn a clear yes into unverified.
export const VERIFIED_MIN_CONFIDENCE = 0.8;
export const CONTRADICTED_MIN_CONFIDENCE = 0.8;
export const POPULATED_MIN_PROBABILITY = 0.7;
// When the (cited, provenance-gated) KB says the feature is standard on every version matching the
// listing, a missing equipment-list line is not a contradiction. Policy: such a check counts as
// verified with evidence prefixed "Standard-fit per knowledge base" — the same convention the Sonnet
// evaluator's accepted verdicts use. Set KB_STANDARD_COUNTS_AS_VERIFIED=false to keep it unverified.
export const KB_STANDARD_MIN_CONFIDENCE = 0.8;
export const KB_STANDARD_COUNTS_AS_VERIFIED = true;
const MAX_CUE_CHARS = 3000;
// choice questions accept ≤255 options; leave room for description lines and `none`.
const MAX_FEATURE_LINES = 200;
const MAX_DESCRIPTION_LINES = 8;

const STOPWORDS = new Set(['with', 'and', 'or', 'not', 'just', 'etc', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'via', 'plus', 'inc', 'incl', 'including']);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

const NONE_LABEL = 'No candidate line shows this car is fitted with the requirement';

/** Tokens including parenthetical content, plus upper-case acronyms (e.g. ACC) as their own set. */
function requirementTerms(requirement: string): { words: string[]; acronyms: string[] } {
  const words = requirement
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  const acronyms = (requirement.match(/\b[A-Z]{2,}\b/g) ?? []).map((a) => a.toLowerCase());
  return { words: [...new Set(words)], acronyms };
}

/**
 * Pull the parts of a product-knowledge file that talk about one requirement: every section whose
 * heading mentions it, plus any other line that mentions it twice over or by acronym. Vertical- and
 * layout-agnostic (KB files are free-form markdown written by the research agent).
 */
export function extractKbCues(kbText: string, requirement: string, maxChars = MAX_CUE_CHARS): string | null {
  const { words, acronyms } = requirementTerms(requirement);
  const hits = (line: string): number => {
    const t = new Set(tokens(line).concat(line.toLowerCase().match(/\b[a-z]{2,}\b/g) ?? []));
    return words.filter((w) => t.has(w)).length + (acronyms.some((a) => t.has(a)) ? 2 : 0);
  };
  const out: string[] = [];
  let inMatchingSection = false;
  let heading = '';
  let headingEmitted = false;
  for (const raw of kbText.split('\n')) {
    const line = raw.trimEnd();
    if (/^#{1,6}\s/.test(line)) {
      heading = line;
      inMatchingSection = hits(line) >= 1;
      headingEmitted = inMatchingSection;
      if (inMatchingSection) out.push(line);
      continue;
    }
    if (!line.trim()) continue;
    if (inMatchingSection || hits(line) >= 2) {
      // A stray matching line keeps its heading so "Adaptive Cruise Control" under "### Pilot
      // Pack" still says which pack it belongs to.
      if (!headingEmitted && heading) {
        out.push(heading);
        headingEmitted = true;
      }
      out.push(line);
    }
  }
  const text = out.join('\n').trim();
  return text ? text.slice(0, maxChars) : null;
}

export function buildMustHaveRequest(input: MustHaveInput): BuiltRequest {
  const featureLines = input.features
    .flatMap((cat) => cat.items.map((it) => `${cat.category} / ${it.name} (${it.type ?? 'Standard'})`))
    .slice(0, MAX_FEATURE_LINES);
  const sentences = (input.description ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  const questions: Record<string, Question> = {};
  const candidates: Record<string, string[]> = {};

  input.mustHaves.forEach((requirement, i) => {
    const qid = `mh${i}`;
    const cues = input.kbText ? extractKbCues(input.kbText, requirement) : null;
    // Description sentences are candidates when they mention the requirement itself or anything
    // the KB cues put in a heading (pack / trim names such as "Pilot Pack") — a dealer often names
    // the pack rather than the feature.
    const cueHeadingTokens = (cues ?? '')
      .split('\n')
      .filter((l) => /^#{1,6}\s/.test(l))
      .flatMap((l) => tokens(l))
      .filter((t) => t.length > 3 && !/^\d+$/.test(t));
    const reqTokens = [...new Set([...tokens(requirement), ...cueHeadingTokens])];
    const descLines = sentences
      .map((s) => ({ s, hits: reqTokens.filter((rt) => tokens(s).includes(rt)).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits) // most relevant first, so the cap never drops the best line
      .slice(0, MAX_DESCRIPTION_LINES)
      .map((x) => `Description: "${x.s.slice(0, 200)}"`);
    const lines = [...(input.subTitle ? [`Derivative: ${input.subTitle}`] : []), ...featureLines, ...descLines];
    candidates[qid] = lines;
    const criteria: Record<string, string> = Object.fromEntries(lines.map((l, j) => [`c${j}`, l]));
    criteria.none = NONE_LABEL;
    questions[qid] = choice(
      {
        requirement,
        question:
          'Which candidate line shows this car is fitted with the `requirement`? ' +
          'A line counts if it names this feature, the manufacturer\'s own name for the same feature ' +
          '(see `model_cues`), or a pack, trim or derivative that `model_cues` says includes it. ' +
          'A weaker or merely related feature does not count. Choose `none` if no line shows it.',
        ...(cues ? { model_cues: cues } : {}),
      },
      criteria,
    );
    if (cues) {
      // Explicit options and the year/derivative written into the question: Jev reads literally and
      // does not hop from state fields to "matches", so a noul phrased that way under-fires.
      const car = [input.year ?? '', input.subTitle ?? ''].join(' ').trim() || 'this car';
      questions[`${qid}_kb_fit`] = choice(
        {
          requirement,
          model_cues: cues,
          question: `According to \`model_cues\` only, how is the \`requirement\` fitted on a ${car}?`,
        },
        {
          standard_all_versions: 'The cues say it is standard equipment on every version of this model for that year, regardless of trim or pack',
          trim_or_pack_dependent: 'The cues say it is standard only on some trims, or comes with an optional pack or option',
          not_available: 'The cues say it is not available on this model or year',
          cues_do_not_say: 'The cues do not state how it is fitted for this model and year',
        },
      );
    }
  });

  questions.features_populated = noul(
    'Does `features` contain a meaningful equipment list for this car (more than a handful of generic items)?',
  );

  return {
    state: {
      listing: { derivative: input.subTitle ?? null, year: input.year ?? null },
      features: featureLines,
      feature_count: featureLines.length,
    },
    questions,
    candidates,
  };
}

export function mapMustHaveAnswers(
  built: BuiltRequest,
  mustHaves: string[],
  answers: { readonly [k: string]: ChoiceResponse | NoulResponse | ScoreResponse },
): JevRequirementCheck[] {
  const populated = (answers.features_populated as NoulResponse | undefined)?.noul ?? 0;
  return mustHaves.map((requirement, i) => {
    const qid = `mh${i}`;
    const a = answers[qid] as ChoiceResponse;
    const lines = built.candidates[qid];
    const label = (k: string): string => (k === 'none' ? 'none' : lines[Number(k.slice(1))]);
    const probabilities = Object.entries(a.probabilities)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([k, p]) => ({ label: label(k), p }));
    const pNone = a.probabilities.none ?? 0;
    const pShown = 1 - pNone;
    const topLine = probabilities.find((p) => p.label !== 'none')?.label ?? null;
    if (a.choice !== 'none' && pShown >= VERIFIED_MIN_CONFIDENCE) {
      return { requirement, verdict: 'verified', evidence: label(a.choice), confidence: pShown, probabilities };
    }
    const base = { requirement, confidence: a.choice === 'none' ? pNone : pShown, probabilities };
    // Listing evidence is weak from here on; the KB can still settle it (Tesla lists "Lane Departure
    // Warning" while the KB says Autosteer is standard on every UK Model 3).
    const kbFit = answers[`${qid}_kb_fit`] as ChoiceResponse | undefined;
    const kbStandard = kbFit?.probabilities.standard_all_versions ?? 0;
    if (kbStandard >= KB_STANDARD_MIN_CONFIDENCE) {
      const evidence = `Standard-fit per knowledge base on every version of this model/year (p=${kbStandard.toFixed(2)}); not itemised in the listing`;
      return KB_STANDARD_COUNTS_AS_VERIFIED
        ? { requirement, verdict: 'verified', evidence, confidence: kbStandard, probabilities }
        : { ...base, verdict: 'unverified', evidence };
    }
    if (a.choice === 'none' && pNone >= CONTRADICTED_MIN_CONFIDENCE && populated >= POPULATED_MIN_PROBABILITY) {
      return { ...base, verdict: 'contradicted', evidence: `Not in the listed equipment (${lines.length} lines checked)` };
    }
    return { ...base, verdict: 'unverified', evidence: a.choice === 'none' ? null : (topLine ?? label(a.choice)) };
  });
}

/** Read a product-knowledge markdown file; null when missing. */
export function loadKbText(kbAbsPath: string): string | null {
  try {
    return fs.readFileSync(kbAbsPath, 'utf-8');
  } catch {
    return null;
  }
}
