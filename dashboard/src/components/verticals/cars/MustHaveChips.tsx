/**
 * Must-have status chips for a cars listing: matches each hunt must-have
 * against the listing's normalised features (fuzzy, via lib/must-have-matcher)
 * and renders ✓ standard / ⚠ optional / ? not listed.
 *
 * `compact` mode: one wrapping row of icon + shortened label (tooltip carries
 * the detail) — for scatter tooltips and dense strips.
 * `full` mode: stacked rows with explicit status text and the matched feature.
 */

import type { NormalisedFeatureCategory } from '@shared/types';
import {
  matchMustHaveToFeatures,
  normalizeFeatureText,
  type MustHaveFeatureMatch,
} from '@/lib/must-have-matcher';
import { cn } from '@/lib/utils';

interface MustHaveChipsProps {
  mustHaves: string[];
  features: NormalisedFeatureCategory[];
  mode: 'compact' | 'full';
}

const STATUS_META: Record<
  MustHaveFeatureMatch['status'],
  { icon: string; color: string; label: string }
> = {
  standard: { icon: '✓', color: 'text-success', label: 'standard' },
  optional: { icon: '⚠', color: 'text-warning', label: 'optional pack — verify with dealer' },
  not_listed: { icon: '?', color: 'text-zinc-500', label: 'not listed' },
};

/** First 3 significant (non-stopword, non-parenthetical) words of a must-have. */
function shortLabel(mustHave: string): string {
  const words = normalizeFeatureText(mustHave).slice(0, 3);
  return words.length > 0 ? words.join(' ') : mustHave;
}

function fullDetail(mustHave: string, match: MustHaveFeatureMatch): string {
  const meta = STATUS_META[match.status];
  if (!match.matchedFeature) return `${mustHave} — ${meta.label}`;
  const category = match.category ? ` (${match.category})` : '';
  return `${mustHave} — ${meta.label}: ${match.matchedFeature}${category}`;
}

export default function MustHaveChips({ mustHaves, features, mode }: MustHaveChipsProps) {
  if (mustHaves.length === 0) return null;

  const rows = mustHaves.map((mustHave) => ({
    mustHave,
    match: matchMustHaveToFeatures(mustHave, features),
  }));

  if (mode === 'compact') {
    return (
      <div className="flex flex-wrap gap-x-2.5 gap-y-1">
        {rows.map(({ mustHave, match }) => {
          const meta = STATUS_META[match.status];
          return (
            <span
              key={mustHave}
              className={cn('inline-flex items-center gap-1 text-tiny', meta.color)}
              title={fullDetail(mustHave, match)}
            >
              <span aria-hidden>{meta.icon}</span>
              <span>{shortLabel(mustHave)}</span>
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {rows.map(({ mustHave, match }) => {
        const meta = STATUS_META[match.status];
        return (
          <div key={mustHave} className="flex items-start gap-2 text-xs">
            <span className={cn('shrink-0', meta.color)} aria-hidden>{meta.icon}</span>
            <div className="min-w-0">
              <span className="text-zinc-300">{mustHave}</span>{' '}
              <span className={meta.color}>{meta.label}</span>
              {match.matchedFeature && (
                <div className="text-tiny text-zinc-500">
                  {match.matchedFeature}
                  {match.category ? ` · ${match.category}` : ''}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
