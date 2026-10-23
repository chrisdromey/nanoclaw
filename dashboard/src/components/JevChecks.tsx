/**
 * Jev (TypeSafe System One) must-have verdicts with the probability mass Jev put on each
 * candidate evidence line. One card per requirement: verdict pill + confidence, then thin
 * horizontal bars (widest = the line Jev chose). `none` is the "no line shows it" option.
 *
 * Text stays in ink tokens; only the marks carry colour. Status colours (success / warning /
 * danger) ship with an icon + label so identity is never colour alone.
 */

import { useEffect, useState } from 'react';
import type { JevCheck } from '@shared/types';
import { cn } from '@/lib/utils';

const VERDICT_META: Record<JevCheck['verdict'], { icon: string; text: string; bar: string; pill: string }> = {
  verified: { icon: '✓', text: 'text-success', bar: 'bg-success', pill: 'bg-success-muted text-success' },
  unverified: { icon: '?', text: 'text-warning', bar: 'bg-warning', pill: 'bg-warning-muted text-warning' },
  contradicted: { icon: '✗', text: 'text-danger', bar: 'bg-danger', pill: 'bg-danger-muted text-danger' },
};

const NONE_TEXT = 'Not in the equipment list';

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

export function barWidth(p: number): string {
  // Floor at 2% so a near-zero option still shows a sliver users can hover.
  return `${Math.max(2, Math.round(p * 1000) / 10)}%`;
}

export default function JevChecks({ checks }: { checks: JevCheck[] }) {
  // Bars grow from zero on mount — one state flip, CSS does the rest.
  const [grown, setGrown] = useState(false);
  useEffect(() => setGrown(true), []);
  if (checks.length === 0) return null;

  const hunts = [...new Set(checks.map((c) => c.hunt_id))];

  return (
    <div data-testid="jev-checks">
      <div className="flex items-baseline justify-between mb-2">
        <h4 className="text-sm text-zinc-400">
          Jev verdicts <span className="text-xs text-zinc-500">· System One, shadow mode</span>
        </h4>
        <span className="text-xs text-zinc-500">{checks[0].model}</span>
      </div>
      <div className="space-y-3">
        {checks.map((check, i) => {
          const meta = VERDICT_META[check.verdict];
          const chosen = check.verdict === 'contradicted' ? 'none' : check.evidence;
          return (
            <div key={`${check.hunt_id}-${check.requirement}`} className="bg-raised rounded-md p-3">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', meta.pill)}>
                  <span aria-hidden>{meta.icon}</span>
                  {check.verdict}
                </span>
                <span className="text-sm text-zinc-200 flex-1 min-w-0">{check.requirement}</span>
                <span className="text-xs tabular-nums text-zinc-400" title="Probability mass behind the verdict">
                  {pct(check.confidence)} sure
                </span>
                {hunts.length > 1 && check.hunt_name && (
                  <span className="text-xs text-zinc-500">{check.hunt_name}</span>
                )}
              </div>
              <ul className="space-y-1.5">
                {check.probabilities.map((row, j) => {
                  const isNone = row.label === 'none';
                  const isChosen = row.label === chosen || (isNone && chosen === 'none');
                  return (
                    <li key={j} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-center">
                      <span
                        className={cn('truncate text-xs', isChosen ? 'text-zinc-200' : 'text-zinc-500', isNone && 'italic')}
                        title={isNone ? NONE_TEXT : row.label}
                      >
                        {isNone ? NONE_TEXT : row.label}
                      </span>
                      <span className="text-xs tabular-nums text-zinc-400 w-10 text-right">{pct(row.p)}</span>
                      <div className="col-span-2 h-1.5 rounded-full bg-overlay overflow-hidden">
                        <div
                          data-testid={`jev-bar-${i}-${j}`}
                          className={cn('h-full rounded-full transition-[width] duration-700 ease-out', isChosen ? meta.bar : 'bg-zinc-500')}
                          style={{ width: grown ? barWidth(row.p) : '0%' }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {check.verdict === 'unverified' && check.evidence && !check.probabilities.some((r) => r.label === check.evidence) && (
                <p className="mt-2 text-xs text-zinc-500">{check.evidence}</p>
              )}
              <p className="mt-2 text-[11px] text-zinc-600">checked {check.checked_at.slice(0, 16).replace('T', ' ')}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
