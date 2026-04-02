import { cn } from '@/lib/utils';

interface MetricCardProps {
  label: string;
  value: string;
  trend?: {
    value: string;
    direction: 'up' | 'down' | 'neutral';
  };
  className?: string;
}

export default function MetricCard({
  label,
  value,
  trend,
  className,
}: MetricCardProps) {
  return (
    <div
      className={cn(
        'bg-surface border border-zinc-800 rounded-lg p-3',
        className,
      )}
    >
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-section-title font-mono text-zinc-50">
        {value}
      </div>
      {trend && (
        <div
          className={cn(
            'mt-1 text-xs font-mono',
            trend.direction === 'up' && 'text-success',
            trend.direction === 'down' && 'text-danger',
            trend.direction === 'neutral' && 'text-zinc-500',
          )}
        >
          {trend.direction === 'up' && '↑ '}
          {trend.direction === 'down' && '↓ '}
          {trend.direction === 'neutral' && '→ '}
          {trend.value}
        </div>
      )}
    </div>
  );
}
