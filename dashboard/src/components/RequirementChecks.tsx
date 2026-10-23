/**
 * Recorded requirement verdicts from an evaluation (evaluations.requirement_checks).
 * Vertical-agnostic: renders whatever the agent recorded, no fuzzy matching —
 * contrast with verticals/cars/MustHaveChips which heuristically matches
 * must-haves against listing features. Verdict styling mirrors those chips:
 * ✓ verified (success), ? unverified (muted), ✗ contradicted (danger).
 *
 * `compact` mode: one wrapping row of icon + requirement (tooltip carries the
 * evidence) — for dense evaluation lists.
 * `full` mode: stacked rows with the evidence as secondary text.
 *
 * `tier: 'nice'` entries render dimmed and after the must entries.
 */

import type { RequirementCheck } from '@shared/types';
import { cn } from '@/lib/utils';

interface RequirementChecksProps {
  checks: RequirementCheck[];
  mode: 'compact' | 'full';
}

const VERDICT_META: Record<
  RequirementCheck['verdict'],
  { icon: string; color: string; label: string }
> = {
  verified: { icon: '✓', color: 'text-success', label: 'verified' },
  unverified: { icon: '?', color: 'text-zinc-500', label: 'unverified' },
  contradicted: { icon: '✗', color: 'text-danger', label: 'contradicted' },
};

export default function RequirementChecks({ checks, mode }: RequirementChecksProps) {
  if (checks.length === 0) return null;

  // Must entries (or untiered — treated as must) first, nice-to-haves after.
  const ordered = [
    ...checks.filter((c) => c.tier !== 'nice'),
    ...checks.filter((c) => c.tier === 'nice'),
  ];

  if (mode === 'compact') {
    return (
      <div className="flex flex-wrap gap-x-2.5 gap-y-1">
        {ordered.map((check, i) => {
          const meta = VERDICT_META[check.verdict];
          return (
            <span
              key={`${check.requirement}-${i}`}
              className={cn(
                'inline-flex items-center gap-1 text-tiny',
                meta.color,
                check.tier === 'nice' && 'opacity-60',
              )}
              title={check.evidence ? `${meta.label}: ${check.evidence}` : meta.label}
            >
              <span aria-hidden>{meta.icon}</span>
              <span>{check.requirement}</span>
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {ordered.map((check, i) => {
        const meta = VERDICT_META[check.verdict];
        return (
          <div
            key={`${check.requirement}-${i}`}
            className={cn(
              'flex items-start gap-2 text-xs',
              check.tier === 'nice' && 'opacity-60',
            )}
          >
            <span className={cn('shrink-0', meta.color)} aria-hidden>{meta.icon}</span>
            <div className="min-w-0">
              <span className="text-zinc-300">{check.requirement}</span>{' '}
              <span className={meta.color}>{meta.label}</span>
              {check.tier === 'nice' && (
                <span className="text-zinc-500"> · nice-to-have</span>
              )}
              {check.evidence && (
                <div className="text-tiny text-zinc-500">{check.evidence}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
