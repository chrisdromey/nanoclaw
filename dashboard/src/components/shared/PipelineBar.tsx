import { cn } from '@/lib/utils';

interface PipelineBarProps {
  new_count: number;
  evaluated_count: number;
  watching_count: number;
  dismissed_count: number;
  showLabels?: boolean;
  className?: string;
}

const segments = [
  { key: 'new_count', color: 'bg-info', label: 'New', textColor: 'text-info' },
  {
    key: 'evaluated_count',
    color: 'bg-accent',
    label: 'Eval',
    textColor: 'text-accent',
  },
  {
    key: 'watching_count',
    color: 'bg-success',
    label: 'Watch',
    textColor: 'text-success',
  },
  {
    key: 'dismissed_count',
    color: 'bg-zinc-600',
    label: 'Skip',
    textColor: 'text-zinc-500',
  },
] as const;

export default function PipelineBar({
  new_count,
  evaluated_count,
  watching_count,
  dismissed_count,
  showLabels = true,
  className,
}: PipelineBarProps) {
  const counts = { new_count, evaluated_count, watching_count, dismissed_count };
  const total = new_count + evaluated_count + watching_count + dismissed_count;

  if (total === 0) {
    return (
      <div className={cn('space-y-1', className)}>
        <div className="h-1.5 rounded-full bg-zinc-800" />
        {showLabels && (
          <div className="text-tiny text-zinc-600">No offers</div>
        )}
      </div>
    );
  }

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex h-1.5 rounded-full overflow-hidden gap-px">
        {segments.map((seg) => {
          const count = counts[seg.key];
          if (count === 0) return null;
          return (
            <div
              key={seg.key}
              className={cn('rounded-full', seg.color)}
              style={{
                flexGrow: count,
                minWidth: count > 0 ? '4px' : '0',
              }}
            />
          );
        })}
      </div>
      {showLabels && (
        <div className="flex gap-3">
          {segments.map((seg) => {
            const count = counts[seg.key];
            if (count === 0) return null;
            return (
              <span
                key={seg.key}
                className={cn('text-tiny font-mono', seg.textColor)}
              >
                {count} {seg.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
