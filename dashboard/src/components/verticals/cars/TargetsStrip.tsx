/**
 * Horizontal strip of model/target chips for a hunt, each linking to that
 * target's Spec Explorer page. A status dot summarises KB + verification
 * provenance per target; citation count shown when a KB exists.
 *
 * Props are fixed ({huntId, targets: TargetInfo[]}) — WP3 (HuntDetail /
 * Spec Explorer) imports this component too.
 */

import { Link } from 'react-router-dom';
import type { TargetInfo } from '@shared/types';
import { cn } from '@/lib/utils';

interface TargetsStripProps {
  huntId: number;
  targets: TargetInfo[];
}

function statusDot(target: TargetInfo): { cls: string; title: string } {
  if (!target.kb) {
    return { cls: 'bg-zinc-600', title: 'No spec knowledge base yet' };
  }
  if (target.verifications.some((v) => v.verdict === 'contradicted')) {
    return { cls: 'bg-danger', title: 'Some claims contradicted — check spec sheet' };
  }
  if (
    target.verifications.length > 0 &&
    target.verifications.every((v) => v.verdict === 'verified')
  ) {
    return { cls: 'bg-success', title: 'All claims independently verified' };
  }
  return { cls: 'bg-warning', title: 'Verification incomplete' };
}

export default function TargetsStrip({ huntId, targets }: TargetsStripProps) {
  if (targets.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-tiny text-zinc-500">Models:</span>
      {targets.map((target) => {
        const dot = statusDot(target);
        return (
          <Link
            key={target.target_key}
            to={`/hunts/${huntId}/models/${encodeURIComponent(target.target_key)}`}
            className="inline-flex items-center gap-1.5 bg-zinc-800 hover:bg-raised rounded px-2 py-1 text-xs text-zinc-300 transition-colors"
          >
            <span
              className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot.cls)}
              title={dot.title}
            />
            {target.target_key}
            {target.kb != null && target.kb.citation_count > 0 && (
              <span className="text-tiny text-zinc-500">
                · {target.kb.citation_count} cites
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
