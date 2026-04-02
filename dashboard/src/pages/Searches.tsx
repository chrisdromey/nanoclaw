import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import PageHeader from '@/components/layout/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import type {
  SearchQueryWithHunt,
  TermEffectiveness,
  Hunt,
} from '@shared/types';
import { AlertTriangle } from 'lucide-react';
import {
  AreaChart,
  Area,
  ResponsiveContainer,
} from 'recharts';

type Tab = 'history' | 'effectiveness';

function Sparkline({ data }: { data: number[] }) {
  const chartData = data.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width={80} height={24}>
      <AreaChart data={chartData}>
        <defs>
          <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#8B5CF6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="v"
          stroke="#8B5CF6"
          strokeWidth={1.5}
          fill="url(#sparkGrad)"
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export default function Searches() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') as Tab) || 'history';
  const huntFilter = searchParams.get('hunt_id') || '';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = 50;

  const setTab = (t: Tab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', t);
    next.delete('page');
    setSearchParams(next);
  };

  const setHuntFilter = (huntId: string) => {
    const next = new URLSearchParams(searchParams);
    if (huntId) next.set('hunt_id', huntId);
    else next.delete('hunt_id');
    next.delete('page');
    setSearchParams(next);
  };

  const setPage = (p: number) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(p));
    setSearchParams(next);
  };

  // Fetch hunts for filter dropdown
  const { data: hunts } = useQuery({
    queryKey: [...queryKeys.hunts.all, 'all'],
    queryFn: () => apiGet<Hunt[]>('/hunts?status=all'),
  });

  // Search history query
  const historyParams: Record<string, string> = { page: String(page) };
  if (huntFilter) historyParams.hunt_id = huntFilter;

  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: queryKeys.searches(historyParams),
    queryFn: () => {
      const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (huntFilter) qs.set('hunt_id', huntFilter);
      return apiGet<{ data: SearchQueryWithHunt[]; total: number }>(
        `/searches?${qs}`,
      );
    },
    enabled: tab === 'history',
  });

  // Effectiveness query
  const effectivenessParams: Record<string, string> = {};
  if (huntFilter) effectivenessParams.hunt_id = huntFilter;

  const { data: effectData, isLoading: effectLoading } = useQuery({
    queryKey: queryKeys.searchEffectiveness(effectivenessParams),
    queryFn: () => {
      const qs = huntFilter ? `?hunt_id=${huntFilter}` : '';
      return apiGet<{ data: TermEffectiveness[] }>(
        `/searches/effectiveness${qs}`,
      );
    },
    enabled: tab === 'effectiveness',
  });

  const totalPages = historyData ? Math.ceil(historyData.total / limit) : 0;
  const isLoading = tab === 'history' ? historyLoading : effectLoading;

  return (
    <div>
      <PageHeader title="Searches" />

      {/* Tabs + Filter */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1">
          {(['history', 'effectiveness'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'px-3 py-1.5 text-sm rounded-md transition-colors',
                tab === t
                  ? 'bg-accent-muted text-accent'
                  : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              {t === 'history' ? 'Search History' : 'Term Effectiveness'}
            </button>
          ))}
        </div>
        <select
          value={huntFilter}
          onChange={(e) => setHuntFilter(e.target.value)}
          className="bg-surface border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-300"
        >
          <option value="">All hunts</option>
          {hunts?.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </div>

      {isLoading && (
        <div className="h-64 bg-surface border border-zinc-800 rounded-lg animate-pulse" />
      )}

      {/* Search History Tab */}
      {tab === 'history' && historyData && historyData.data.length > 0 && (
        <>
          <div className="bg-surface border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
                  <th className="text-left py-2.5 px-4 font-medium">Terms</th>
                  <th className="text-left py-2.5 px-3 font-medium">Hunt</th>
                  <th className="text-right py-2.5 px-3 font-medium">Results</th>
                  <th className="text-right py-2.5 px-3 font-medium">New</th>
                  <th className="text-right py-2.5 px-3 font-medium">Relevant</th>
                  <th className="text-right py-2.5 px-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {historyData.data.map((sq) => (
                  <tr key={sq.id} className="hover:bg-raised transition-colors">
                    <td className="py-2.5 px-4 font-mono text-zinc-300 text-xs">
                      "{sq.terms}"
                    </td>
                    <td className="py-2.5 px-3 text-zinc-400 text-xs">
                      {sq.hunt_name}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-zinc-400 text-xs">
                      {sq.result_count}
                    </td>
                    <td
                      className={cn(
                        'py-2.5 px-3 text-right font-mono text-xs',
                        sq.new_offer_count > 0 ? 'text-success' : 'text-zinc-500',
                      )}
                    >
                      {sq.new_offer_count}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-zinc-400 text-xs">
                      {sq.relevant_count}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-zinc-500 text-xs">
                      {formatRelativeTime(sq.searched_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 text-sm text-zinc-400">
              <span>
                Showing {(page - 1) * limit + 1}–
                {Math.min(page * limit, historyData.total)} of{' '}
                {historyData.total}
              </span>
              <div className="flex gap-1">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                  className="px-3 py-1 rounded border border-zinc-700 disabled:opacity-30 hover:bg-raised"
                >
                  &larr;
                </button>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                  className="px-3 py-1 rounded border border-zinc-700 disabled:opacity-30 hover:bg-raised"
                >
                  &rarr;
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'history' && historyData && historyData.data.length === 0 && (
        <div className="text-center py-12 text-zinc-500 text-sm">
          No search history
        </div>
      )}

      {/* Effectiveness Tab */}
      {tab === 'effectiveness' && effectData && effectData.data.length > 0 && (
        <div className="bg-surface border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
                <th className="text-left py-2.5 px-4 font-medium">Terms</th>
                <th className="text-left py-2.5 px-3 font-medium">Hunt</th>
                <th className="text-right py-2.5 px-3 font-medium">Searches</th>
                <th className="text-right py-2.5 px-3 font-medium">Results</th>
                <th className="text-right py-2.5 px-3 font-medium">New Offers</th>
                <th className="text-right py-2.5 px-3 font-medium">Avg New</th>
                <th className="py-2.5 px-3 font-medium">Trend</th>
                <th className="text-center py-2.5 px-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {effectData.data.map((term) => (
                <tr
                  key={`${term.hunt_id}-${term.terms}`}
                  className="hover:bg-raised transition-colors"
                >
                  <td className="py-2.5 px-4 font-mono text-zinc-300 text-xs">
                    "{term.terms}"
                  </td>
                  <td className="py-2.5 px-3 text-zinc-400 text-xs">
                    {term.hunt_name}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-zinc-400 text-xs">
                    {term.total_searches}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-zinc-400 text-xs">
                    {term.total_results}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-zinc-300 text-xs">
                    {term.total_new_offers}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-zinc-400 text-xs">
                    {term.avg_new_per_search}
                  </td>
                  <td className="py-1 px-3">
                    {term.sparkline.length > 1 && (
                      <Sparkline data={term.sparkline} />
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-center">
                    {term.stale ? (
                      <span className="inline-flex items-center gap-1 text-warning text-tiny">
                        <AlertTriangle size={10} /> Stale
                      </span>
                    ) : (
                      <StatusBadge variant="active">Active</StatusBadge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'effectiveness' && effectData && effectData.data.length === 0 && (
        <div className="text-center py-12 text-zinc-500 text-sm">
          No search term data available
        </div>
      )}
    </div>
  );
}
