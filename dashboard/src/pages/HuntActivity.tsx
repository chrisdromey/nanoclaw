import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import PageHeader from '@/components/layout/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import type { Hunt, HuntActivityData, HuntLogEntry } from '@shared/types';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

type Period = '7d' | '14d' | '30d' | '90d' | 'all';

const periods: { value: Period; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '14d', label: '14d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
];

const triggerVariant: Record<
  string,
  'info' | 'alert' | 'warning' | 'success' | 'stale'
> = {
  'new-offers': 'info',
  'daily-review': 'stale',
  'price-change': 'warning',
  'auction-countdown': 'alert',
  'watch-condition': 'success',
  user: 'stale',
};

function TriggerBadge({ trigger }: { trigger: string }) {
  const variant = triggerVariant[trigger] || 'stale';
  return <StatusBadge variant={variant}>{trigger}</StatusBadge>;
}

function CountPills({ entry }: { entry: HuntLogEntry }) {
  const pills: string[] = [];
  if (entry.offers_skipped > 0) pills.push(`${entry.offers_skipped} skipped`);
  if (entry.offers_alerted > 0)
    pills.push(`${entry.offers_alerted} alerted`);
  if (entry.offers_watched > 0)
    pills.push(`${entry.offers_watched} watched`);
  if (
    entry.offers_evaluated > 0 &&
    entry.offers_evaluated !==
      entry.offers_skipped + entry.offers_alerted + entry.offers_watched
  )
    pills.push(`${entry.offers_evaluated} evaluated`);
  if (pills.length === 0) return null;
  return (
    <div className="flex gap-2 mt-2 text-xs font-mono text-zinc-500">
      {pills.map((p, i) => (
        <span key={i}>{p}</span>
      ))}
    </div>
  );
}

export default function HuntActivity() {
  const { id } = useParams();
  const huntId = parseInt(id!);
  const [period, setPeriod] = useState<Period>('30d');

  const { data: hunt } = useQuery({
    queryKey: queryKeys.hunts.detail(huntId),
    queryFn: () => apiGet<Hunt>(`/hunts/${huntId}`),
  });

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.hunts.activity(huntId, period),
    queryFn: () =>
      apiGet<HuntActivityData>(
        `/hunts/${huntId}/activity?period=${period}`,
      ),
  });

  const huntName = hunt?.name || `Hunt ${huntId}`;

  return (
    <div>
      <PageHeader
        title="Activity"
        breadcrumbs={[
          { label: 'Hunts', to: '/hunts' },
          { label: huntName, to: `/hunts/${huntId}` },
          { label: 'Activity' },
        ]}
      />

      {/* Period selector */}
      <div className="flex gap-1 mb-6">
        {periods.map((p) => (
          <button
            key={p.value}
            onClick={() => setPeriod(p.value)}
            className={cn(
              'px-3 py-1.5 text-sm rounded-md transition-colors',
              period === p.value
                ? 'bg-accent-muted text-accent border border-accent/30'
                : 'text-zinc-400 hover:text-zinc-200 border border-zinc-700',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Daily activity chart */}
      {data?.daily_stats && data.daily_stats.length > 1 && (
        <div className="bg-surface border border-zinc-800 rounded-lg p-4 mb-6">
          <h3 className="text-xs text-zinc-500 font-medium mb-3">
            Daily Activity
          </h3>
          <ResponsiveContainer width="100%" height={80}>
            <BarChart data={data.daily_stats}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#27272A"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: '#71717A' }}
                tickFormatter={(d: string) => d.slice(5)}
                axisLine={false}
                tickLine={false}
              />
              <YAxis hide />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#3F3F46',
                  border: '1px solid #52525B',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
                labelStyle={{ color: '#A1A1AA' }}
                itemStyle={{ color: '#E4E4E7' }}
                labelFormatter={(d: string) => d}
              />
              <Bar
                dataKey="skipped"
                stackId="a"
                fill="#52525B"
                radius={[0, 0, 0, 0]}
                name="Skipped"
              />
              <Bar
                dataKey="alerted"
                stackId="a"
                fill="#22C55E"
                radius={[0, 0, 0, 0]}
                name="Alerted"
              />
              <Bar
                dataKey="evaluated"
                stackId="a"
                fill="#8B5CF6"
                radius={[2, 2, 0, 0]}
                name="Other"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Activity timeline */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="bg-surface border border-zinc-800 rounded-lg p-4 animate-pulse"
            >
              <div className="h-4 bg-zinc-800 rounded w-1/4 mb-3" />
              <div className="h-3 bg-zinc-800 rounded w-3/4 mb-2" />
              <div className="h-3 bg-zinc-800 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : data?.log_entries && data.log_entries.length > 0 ? (
        <div className="space-y-3">
          {data.log_entries.map((entry) => (
            <div
              key={entry.id}
              className="bg-surface border border-zinc-800 rounded-lg p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <TriggerBadge trigger={entry.trigger} />
                <span className="text-xs font-mono text-zinc-500">
                  {formatRelativeTime(entry.logged_at)}
                </span>
              </div>
              <p className="text-sm text-zinc-300 whitespace-pre-line">
                {entry.summary}
              </p>
              <CountPills entry={entry} />
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-zinc-500 text-sm">
          No activity recorded yet
        </div>
      )}
    </div>
  );
}
