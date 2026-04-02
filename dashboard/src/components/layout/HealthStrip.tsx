import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatRelativeTime, formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { SystemHealth } from '@shared/types';

const statusColors = {
  running: 'bg-success',
  slow: 'bg-warning',
  stale: 'bg-danger',
};

export default function HealthStrip() {
  const { data } = useQuery({
    queryKey: queryKeys.systemHealth,
    queryFn: () => apiGet<SystemHealth>('/system/health'),
    refetchInterval: 30_000,
  });

  if (!data) return null;

  const budgetPercent = (data.api.searches_today / data.api.budget) * 100;
  const budgetColor =
    budgetPercent > 95
      ? 'bg-danger'
      : budgetPercent > 80
        ? 'bg-warning'
        : 'bg-accent';

  return (
    <div className="flex items-center gap-6 mb-6 px-4 py-2.5 bg-surface border border-zinc-800 rounded-lg text-xs text-zinc-400">
      {/* Watcher */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'w-1.5 h-1.5 rounded-full',
            statusColors[data.watcher.status],
          )}
        />
        <span>
          Watcher:{' '}
          <span className="text-zinc-300 capitalize">
            {data.watcher.status}
          </span>
        </span>
        {data.watcher.last_search && (
          <span className="text-zinc-500">
            {formatRelativeTime(data.watcher.last_search)}
          </span>
        )}
      </div>

      {/* API Budget */}
      <div className="flex items-center gap-2">
        <span>API:</span>
        <div className="w-32 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', budgetColor)}
            style={{ width: `${Math.min(100, budgetPercent)}%` }}
          />
        </div>
        <span className="font-mono text-zinc-300">
          {formatCount(data.api.searches_today)} / {formatCount(data.api.budget)}
        </span>
      </div>

      {/* Last Agent Run */}
      <div className="flex items-center gap-2">
        <span>Agent:</span>
        <span className="font-mono text-zinc-300">
          {formatRelativeTime(data.agent.last_run)}
        </span>
      </div>
    </div>
  );
}
