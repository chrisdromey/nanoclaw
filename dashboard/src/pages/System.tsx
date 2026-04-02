import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatRelativeTime, formatDuration, formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';
import PageHeader from '@/components/layout/PageHeader';
import MetricCard from '@/components/shared/MetricCard';
import StatusBadge from '@/components/shared/StatusBadge';
import type { SystemHealth, SearchScheduleItem } from '@shared/types';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';

interface ExtendedHealth extends SystemHealth {
  search_schedule: SearchScheduleItem[];
  daily_usage: Array<{ day: string; search_count: number }>;
  recent_errors: Array<Record<string, unknown>>;
}

export default function System() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.systemHealth,
    queryFn: () => apiGet<ExtendedHealth>('/system/health'),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div>
        <PageHeader title="System" />
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-24 bg-surface border border-zinc-800 rounded-lg animate-pulse"
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const budgetPercent = (data.api.searches_today / data.api.budget) * 100;
  const budgetColor =
    budgetPercent > 95
      ? 'bg-danger'
      : budgetPercent > 80
        ? 'bg-warning'
        : 'bg-accent';

  const dailyChartData = data.daily_usage.map((d) => ({
    date: new Date(d.day + 'T00:00:00Z').toLocaleDateString('en-GB', {
      weekday: 'short',
    }),
    count: d.search_count,
  }));

  return (
    <div>
      <PageHeader title="System" />

      <div className="space-y-6">
        {/* Status cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Watcher */}
          <div className="bg-surface border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500 mb-2">Watcher Status</div>
            <div className="flex items-center gap-2 mb-1">
              <div
                className={cn(
                  'w-2 h-2 rounded-full',
                  data.watcher.status === 'running' && 'bg-success',
                  data.watcher.status === 'slow' && 'bg-warning',
                  data.watcher.status === 'stale' && 'bg-danger',
                )}
              />
              <span className="text-section-title text-zinc-50 capitalize">
                {data.watcher.status}
              </span>
            </div>
            <div className="text-xs text-zinc-500">
              Last: {formatRelativeTime(data.watcher.last_search)}
            </div>
          </div>

          {/* API Budget */}
          <div className="bg-surface border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500 mb-2">API Budget</div>
            <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
              <div
                className={cn('h-full rounded-full transition-all', budgetColor)}
                style={{ width: `${Math.min(100, budgetPercent)}%` }}
              />
            </div>
            <div className="text-section-title font-mono text-zinc-50">
              {formatCount(data.api.searches_today)} /{' '}
              {formatCount(data.api.budget)}
            </div>
            <div className="text-xs text-zinc-500">
              {budgetPercent.toFixed(0)}% used
            </div>
          </div>

          {/* Last Agent */}
          <div className="bg-surface border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500 mb-2">Last Agent Run</div>
            <div className="text-section-title text-zinc-50">
              {formatRelativeTime(data.agent.last_run)}
            </div>
            {data.agent.last_duration_ms != null && (
              <div className="text-xs text-zinc-500">
                Duration:{' '}
                <span className="font-mono text-zinc-400">
                  {formatDuration(data.agent.last_duration_ms)}
                </span>
              </div>
            )}
            {data.agent.last_status && (
              <StatusBadge
                variant={
                  data.agent.last_status === 'success' ? 'success' : 'error'
                }
                className="mt-1"
              >
                {data.agent.last_status}
              </StatusBadge>
            )}
          </div>
        </div>

        {/* Search schedule */}
        {data.search_schedule.length > 0 && (
          <div className="bg-surface border border-zinc-800 rounded-lg p-4">
            <h3 className="text-heading text-zinc-300 mb-3">
              Search Schedule
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-xs border-b border-zinc-800">
                  <th className="text-left py-2 px-3 font-medium">Hunt</th>
                  <th className="text-right py-2 px-3 font-medium">Cadence</th>
                  <th className="text-right py-2 px-3 font-medium">
                    Last Search
                  </th>
                  <th className="text-right py-2 px-3 font-medium">
                    Next Expected
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {data.search_schedule.map((s) => {
                  const nextExpected = s.last_search
                    ? new Date(
                        new Date(s.last_search + 'Z').getTime() +
                          s.cadence_minutes * 60_000,
                      )
                    : null;
                  const isOverdue =
                    nextExpected && nextExpected.getTime() < Date.now();

                  return (
                    <tr key={s.hunt_id}>
                      <td className="py-2 px-3 text-zinc-300">
                        {s.hunt_name}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-zinc-400 text-xs">
                        {s.cadence_minutes}m
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-zinc-500 text-xs">
                        {formatRelativeTime(s.last_search)}
                      </td>
                      <td
                        className={cn(
                          'py-2 px-3 text-right font-mono text-xs',
                          isOverdue ? 'text-danger' : 'text-success',
                        )}
                      >
                        {nextExpected
                          ? isOverdue
                            ? 'Overdue'
                            : `in ${Math.round((nextExpected.getTime() - Date.now()) / 60_000)}m ✓`
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* API usage chart */}
        {dailyChartData.length > 0 && (
          <div className="bg-surface border border-zinc-800 rounded-lg p-4">
            <h3 className="text-heading text-zinc-300 mb-3">
              API Usage (Last 7 Days)
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={dailyChartData}>
                <CartesianGrid
                  horizontal
                  vertical={false}
                  stroke="#27272A"
                  strokeDasharray="3 3"
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: '#71717A' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#71717A' }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#3F3F46',
                    border: '1px solid #52525B',
                    borderRadius: '6px',
                    fontSize: '12px',
                  }}
                  formatter={(value: number) => [value, 'Searches']}
                  labelStyle={{ color: '#A1A1AA' }}
                />
                <ReferenceLine
                  y={data.api.budget}
                  stroke="#EF4444"
                  strokeDasharray="8 4"
                  label={{
                    value: 'Budget',
                    position: 'right',
                    fill: '#EF4444',
                    fontSize: 11,
                  }}
                />
                <Bar
                  dataKey="count"
                  fill="#8B5CF6"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Recent errors */}
        <div className="bg-surface border border-zinc-800 rounded-lg p-4">
          <h3 className="text-heading text-zinc-300 mb-3">Recent Errors</h3>
          {data.recent_errors.length === 0 ? (
            <div className="text-sm text-zinc-500 flex items-center gap-2">
              <span className="text-success">✓</span> No recent errors — all
              clear
            </div>
          ) : (
            <div className="space-y-2">
              {data.recent_errors.map((err, i) => (
                <div
                  key={i}
                  className="text-xs text-zinc-400 flex gap-2"
                >
                  <span className="font-mono text-zinc-500 shrink-0">
                    {formatRelativeTime(err.run_at as string)}
                  </span>
                  <span className="text-danger truncate">
                    {(err.error as string) || 'Unknown error'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
