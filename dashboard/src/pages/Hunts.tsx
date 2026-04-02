import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatPrice, formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import PageHeader from '@/components/layout/PageHeader';
import PipelineBar from '@/components/shared/PipelineBar';
import StatusBadge from '@/components/shared/StatusBadge';
import type { HuntSummary } from '@shared/types';
import { Search, Pause, Play } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

type FilterStatus = 'active' | 'paused' | 'closed' | 'all';

const filterTabs: { value: FilterStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

export default function Hunts() {
  const [filter, setFilter] = useState<FilterStatus>('active');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: hunts, isLoading } = useQuery({
    queryKey: [...queryKeys.hunts.all, filter],
    queryFn: () =>
      apiGet<HuntSummary[]>(
        `/hunts${filter !== 'active' ? `?status=${filter}` : ''}`,
      ),
  });

  const handlePauseResume = async (
    e: React.MouseEvent,
    hunt: HuntSummary,
  ) => {
    e.stopPropagation();
    const action = hunt.status === 'active' ? 'pause' : 'resume';
    try {
      await apiPost(`/hunts/${hunt.id}/${action}`);
      toast.success(`Hunt ${action === 'pause' ? 'paused' : 'resumed'}`);
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.all });
    } catch (err) {
      toast.error(`Failed to ${action} hunt`);
    }
  };

  return (
    <div>
      <PageHeader title="Hunts" />

      {/* Filter tabs */}
      <div className="flex gap-1 mb-6 bg-surface border border-zinc-800 rounded-lg p-1 w-fit">
        {filterTabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm transition-colors',
              filter === tab.value
                ? 'bg-accent text-white'
                : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-48 bg-surface border border-zinc-800 rounded-lg animate-pulse"
            />
          ))}
        </div>
      )}

      {hunts && hunts.length === 0 && (
        <div className="text-center py-12 text-zinc-500">
          <p className="text-sm">No hunts found</p>
          <p className="text-xs mt-1">
            Create hunts by chatting with your agent on Telegram
          </p>
        </div>
      )}

      {hunts && hunts.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {hunts.map((hunt) => (
            <div
              key={hunt.id}
              onClick={() => navigate(`/hunts/${hunt.id}`)}
              className="bg-surface border border-zinc-800 rounded-lg p-4 cursor-pointer hover:bg-raised transition-colors duration-150"
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-3">
                <span className="text-heading text-zinc-50 truncate">
                  {hunt.name}
                </span>
                <StatusBadge
                  variant={hunt.status as 'active' | 'paused' | 'closed'}
                >
                  {hunt.status}
                </StatusBadge>
              </div>

              <div className="text-xs text-zinc-500 mb-3">
                Created {formatRelativeTime(hunt.created_at)}
              </div>

              {/* Pipeline */}
              <PipelineBar
                new_count={hunt.new_count}
                evaluated_count={hunt.evaluated_count}
                watching_count={hunt.watching_count}
                dismissed_count={hunt.dismissed_count}
                className="mb-3"
              />

              {/* Price range */}
              {hunt.min_price != null && hunt.max_price != null && (
                <div className="text-sm mb-2">
                  <span className="font-mono text-zinc-50">
                    {formatPrice(hunt.min_price)} –{' '}
                    {formatPrice(hunt.max_price)}
                  </span>
                </div>
              )}

              {/* Last search */}
              <div className="text-xs text-zinc-500 flex items-center gap-1.5 mb-3">
                <Search size={12} />
                {hunt.status === 'paused' ? (
                  <span>Paused</span>
                ) : hunt.last_searched ? (
                  <span>
                    {formatRelativeTime(hunt.last_searched)} ·{' '}
                    {hunt.last_result_count} results
                  </span>
                ) : (
                  <span>No searches yet</span>
                )}
              </div>

              {/* Monitoring + Actions */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <div
                    className={cn(
                      'w-1.5 h-1.5 rounded-full',
                      hunt.monitoring ? 'bg-success' : 'bg-zinc-600',
                    )}
                  />
                  {hunt.monitoring ? 'Monitoring' : 'Not monitoring'}
                </div>

                {hunt.status !== 'closed' && (
                  <button
                    onClick={(e) => handlePauseResume(e, hunt)}
                    className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    {hunt.status === 'active' ? (
                      <>
                        <Pause size={12} /> Pause
                      </>
                    ) : (
                      <>
                        <Play size={12} /> Resume
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
