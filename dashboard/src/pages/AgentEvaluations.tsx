import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import PageHeader from '@/components/layout/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import type { EvaluationWithDetails, DecisionTrendDay } from '@shared/types';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

const decisionColors: Record<string, string> = {
  alert: '#EF4444',
  watch: '#22C55E',
  skip: '#52525B',
};

export default function AgentEvaluations() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const limit = 50;

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.evaluations({ page: String(page) }),
    queryFn: () =>
      apiGet<{
        data: EvaluationWithDetails[];
        total: number;
        distribution: Record<string, number>;
        trend: DecisionTrendDay[];
      }>(`/evaluations?page=${page}&limit=${limit}`),
  });

  const totalPages = data ? Math.ceil(data.total / limit) : 0;

  const donutData = data?.distribution
    ? Object.entries(data.distribution).map(([name, value]) => ({
        name,
        value,
      }))
    : [];

  const totalEvals = donutData.reduce((s, d) => s + d.value, 0);

  // Transform trend for stacked area
  const trendData = (() => {
    if (!data?.trend.length) return [];
    const byDay = new Map<string, Record<string, number>>();
    for (const t of data.trend) {
      if (!byDay.has(t.day)) byDay.set(t.day, { alert: 0, watch: 0, skip: 0 });
      byDay.get(t.day)![t.decision] = t.count;
    }
    return Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, counts]) => ({
        date: new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
        }),
        ...counts,
      }));
  })();

  return (
    <div>
      <PageHeader title="Evaluations" />

      {isLoading && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="h-48 bg-surface border border-zinc-800 rounded-lg animate-pulse" />
            <div className="h-48 bg-surface border border-zinc-800 rounded-lg animate-pulse" />
          </div>
        </div>
      )}

      {data && (
        <div className="space-y-6">
          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Donut */}
            {donutData.length > 0 && (
              <div className="bg-surface border border-zinc-800 rounded-lg p-4">
                <h3 className="text-heading text-zinc-300 mb-3">
                  Decision Distribution
                </h3>
                <div className="flex items-center gap-4">
                  <div className="relative w-40 h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={donutData}
                          innerRadius="60%"
                          outerRadius="80%"
                          dataKey="value"
                          stroke="none"
                        >
                          {donutData.map((entry) => (
                            <Cell
                              key={entry.name}
                              fill={decisionColors[entry.name] || '#52525B'}
                            />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-lg font-mono font-semibold text-zinc-50">
                        {totalEvals}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {donutData.map((d) => (
                      <div
                        key={d.name}
                        className="flex items-center gap-2 text-sm"
                      >
                        <div
                          className="w-2.5 h-2.5 rounded-sm"
                          style={{
                            backgroundColor:
                              decisionColors[d.name] || '#52525B',
                          }}
                        />
                        <span className="text-zinc-400 capitalize">
                          {d.name}
                        </span>
                        <span className="font-mono text-zinc-300">
                          {d.value}
                        </span>
                        <span className="text-zinc-600 text-xs">
                          ({((d.value / totalEvals) * 100).toFixed(0)}%)
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Trend */}
            {trendData.length > 0 && (
              <div className="bg-surface border border-zinc-800 rounded-lg p-4">
                <h3 className="text-heading text-zinc-300 mb-3">
                  Decision Trend
                </h3>
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={trendData}>
                    <CartesianGrid
                      horizontal
                      vertical={false}
                      stroke="#27272A"
                      strokeDasharray="3 3"
                    />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: '#71717A' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#71717A' }}
                      axisLine={false}
                      tickLine={false}
                      width={30}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#3F3F46',
                        border: '1px solid #52525B',
                        borderRadius: '6px',
                        fontSize: '12px',
                      }}
                      labelStyle={{ color: '#A1A1AA' }}
                    />
                    <Area
                      type="monotone"
                      dataKey="skip"
                      stackId="1"
                      fill="#52525B"
                      stroke="#52525B"
                      fillOpacity={0.6}
                    />
                    <Area
                      type="monotone"
                      dataKey="watch"
                      stackId="1"
                      fill="#22C55E"
                      stroke="#22C55E"
                      fillOpacity={0.6}
                    />
                    <Area
                      type="monotone"
                      dataKey="alert"
                      stackId="1"
                      fill="#EF4444"
                      stroke="#EF4444"
                      fillOpacity={0.6}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Table */}
          {data.data.length > 0 && (
            <div className="bg-surface border border-zinc-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
                    <th className="text-left py-2.5 px-4 font-medium">Offer</th>
                    <th className="text-left py-2.5 px-3 font-medium">Hunt</th>
                    <th className="text-center py-2.5 px-3 font-medium">
                      Decision
                    </th>
                    <th className="text-left py-2.5 px-3 font-medium">
                      Reasoning
                    </th>
                    <th className="text-right py-2.5 px-3 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {data.data.map((ev) => (
                    <>
                      <tr
                        key={ev.id}
                        onClick={() =>
                          setExpandedId(expandedId === ev.id ? null : ev.id)
                        }
                        className="hover:bg-raised cursor-pointer transition-colors"
                      >
                        <td
                          className="py-2.5 px-4 text-zinc-300 max-w-[200px] truncate"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/offers/${ev.offer_id}`);
                          }}
                        >
                          <span className="hover:text-accent">
                            {ev.offer_title}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-zinc-400 text-xs">
                          {ev.hunt_name}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <StatusBadge
                            variant={
                              ev.decision as 'alert' | 'skip' | 'watch'
                            }
                          >
                            {ev.decision}
                          </StatusBadge>
                        </td>
                        <td className="py-2.5 px-3 text-zinc-500 text-xs max-w-[300px] truncate">
                          {ev.reasoning || '—'}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-zinc-500 text-xs">
                          {formatRelativeTime(ev.evaluated_at)}
                        </td>
                      </tr>
                      {expandedId === ev.id && ev.reasoning && (
                        <tr key={`${ev.id}-expanded`}>
                          <td
                            colSpan={5}
                            className="px-4 py-3 bg-raised text-xs text-zinc-400"
                          >
                            {ev.reasoning}
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-zinc-400">
              <span>
                Showing {(page - 1) * limit + 1}–
                {Math.min(page * limit, data.total)} of {data.total}
              </span>
              <div className="flex gap-1">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                  className="px-3 py-1 rounded border border-zinc-700 disabled:opacity-30 hover:bg-raised"
                >
                  ←
                </button>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                  className="px-3 py-1 rounded border border-zinc-700 disabled:opacity-30 hover:bg-raised"
                >
                  →
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
