import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useRef } from 'react';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatPrice, formatRelativeTime, formatPercent, priceChange } from '@/lib/format';
import { cn } from '@/lib/utils';
import PageHeader from '@/components/layout/PageHeader';
import HealthStrip from '@/components/layout/HealthStrip';
import MetricCard from '@/components/shared/MetricCard';
import PipelineBar from '@/components/shared/PipelineBar';
import StatusBadge from '@/components/shared/StatusBadge';
import type { OverviewData, HuntSummary, ActivityItem } from '@shared/types';
import { AlertTriangle, Search, Bot, Bell, CheckCircle, Target } from 'lucide-react';
import { useBaseline } from '@/hooks/use-baseline';

export default function Overview() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.overview,
    queryFn: () => apiGet<OverviewData>('/dashboard/overview'),
    refetchInterval: 30_000,
  });

  // Track latest activity timestamp for feed-in animation
  const prevMaxTimestamp = useRef<string | null>(null);
  const newItemTimestamps = useRef(new Set<string>());

  if (data?.recent_activity.length) {
    const currentMax = data.recent_activity[0]?.timestamp;
    if (prevMaxTimestamp.current && currentMax > prevMaxTimestamp.current) {
      // New items appeared — mark them for animation
      newItemTimestamps.current = new Set(
        data.recent_activity
          .filter((a) => a.timestamp > prevMaxTimestamp.current!)
          .map((a) => a.timestamp),
      );
      // Clear animation markers after the animation duration
      setTimeout(() => {
        newItemTimestamps.current = new Set();
      }, 400);
    }
    prevMaxTimestamp.current = currentMax;
  }

  return (
    <div>
      <PageHeader title="Overview" />
      <HealthStrip />

      {isLoading && (
        <div className="space-y-6">
          {/* Skeleton */}
          <div className="grid grid-cols-2 gap-4">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-28 bg-surface border border-zinc-800 rounded-lg animate-pulse"
              />
            ))}
          </div>
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-20 bg-surface border border-zinc-800 rounded-lg animate-pulse"
              />
            ))}
          </div>
        </div>
      )}

      {data && (
        <div className="space-y-6">
          {/* Attention + Quick Stats */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <AttentionCard attention={data.attention} />
            <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-4">
              <MetricCard
                label="Active Offers"
                value={String(data.quick_stats.active_offers)}
              />
              <MetricCard
                label="Watching"
                value={String(data.quick_stats.watching_count)}
              />
              <MetricCard
                label="Searches Today"
                value={String(data.quick_stats.searches_today)}
              />
              <MetricCard
                label="Evaluations Today"
                value={String(data.quick_stats.evaluations_today)}
              />
            </div>
          </div>

          {/* Hunt Cards */}
          {data.hunts.length > 0 && (
            <div>
              <h2 className="text-heading text-zinc-300 mb-3">Active Hunts</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {data.hunts.map((hunt) => (
                  <HuntCard key={hunt.id} hunt={hunt} />
                ))}
              </div>
            </div>
          )}

          {/* Recent Activity */}
          {data.recent_activity.length > 0 && (
            <div>
              <h2 className="text-heading text-zinc-300 mb-3">
                Recent Activity
              </h2>
              <div className="bg-surface border border-zinc-800 rounded-lg divide-y divide-zinc-800">
                {data.recent_activity.map((item, i) => (
                  <ActivityRow
                    key={`${item.timestamp}-${i}`}
                    item={item}
                    isNew={newItemTimestamps.current.has(item.timestamp)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AttentionCard({
  attention,
}: {
  attention: OverviewData['attention'];
}) {
  const hasItems =
    attention.auctions_ending_soon > 0 ||
    attention.price_drops > 0 ||
    attention.unevaluated > 0;

  return (
    <div className="bg-surface border border-zinc-800 rounded-lg p-4">
      <h3 className="text-heading text-zinc-300 mb-3">Attention Needed</h3>
      {!hasItems ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <CheckCircle size={14} className="text-success" />
          All clear
        </div>
      ) : (
        <div className="space-y-2">
          {attention.auctions_ending_soon > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangle size={14} className="text-warning" />
              <span className="text-zinc-300">
                {attention.auctions_ending_soon} auction
                {attention.auctions_ending_soon > 1 ? 's' : ''} ending &lt; 24h
              </span>
            </div>
          )}
          {attention.price_drops > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-success">↓</span>
              <span className="text-zinc-300">
                {attention.price_drops} price drop
                {attention.price_drops > 1 ? 's' : ''}
              </span>
            </div>
          )}
          {attention.unevaluated > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-info font-bold text-xs">●</span>
              <span className="text-zinc-300">
                {attention.unevaluated} unevaluated offer
                {attention.unevaluated > 1 ? 's' : ''}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HuntCard({ hunt }: { hunt: HuntSummary }) {
  const navigate = useNavigate();
  const { hasSegments, isStale, segments } = useBaseline(hunt.id);

  return (
    <div
      onClick={() => navigate(`/hunts/${hunt.id}`)}
      className="bg-surface border border-zinc-800 rounded-lg p-4 cursor-pointer hover:bg-raised transition-colors duration-150"
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <span className="text-heading text-zinc-50 truncate">{hunt.name}</span>
        <div className="flex items-center gap-1.5">
          {hasSegments && (
            <span
              className={cn(
                'flex items-center gap-0.5 text-tiny px-1.5 py-0.5 rounded',
                isStale
                  ? 'bg-warning/10 text-warning'
                  : 'bg-success/10 text-success',
              )}
              title={isStale ? 'Baseline data is stale (>14d)' : `${segments.length} segment${segments.length !== 1 ? 's' : ''} baselined`}
            >
              <Target size={10} />
              {segments.length}
            </span>
          )}
          <StatusBadge variant={hunt.status as 'active' | 'paused' | 'closed'}>
            {hunt.status}
          </StatusBadge>
        </div>
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
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="font-mono text-zinc-50">
            {formatPrice(hunt.min_price)} – {formatPrice(hunt.max_price)}
          </span>
        </div>
      )}

      {/* Last search */}
      <div className="text-xs text-zinc-500 flex items-center gap-1.5">
        <Search size={12} />
        {hunt.last_searched ? (
          <span>
            {formatRelativeTime(hunt.last_searched)} ·{' '}
            {hunt.last_result_count} results
          </span>
        ) : (
          <span>No searches yet</span>
        )}
      </div>
    </div>
  );
}

function ActivityRow({ item, isNew }: { item: ActivityItem; isNew?: boolean }) {
  const iconMap = {
    search: <Search size={14} className="text-info" />,
    evaluation: <Bot size={14} className="text-accent" />,
    alert: <Bell size={14} className="text-warning" />,
    price_change: <span className="text-success text-sm">↓</span>,
  };

  return (
    <div className={cn('flex items-center gap-3 px-4 py-2.5', isNew && 'animate-feed-in')}>
      <div className="w-5 flex justify-center">
        {iconMap[item.type] || <span>·</span>}
      </div>
      <span className="text-sm text-zinc-300 flex-1 truncate">
        {item.description}
      </span>
      {item.hunt_name && (
        <span className="text-xs text-zinc-600 hidden sm:block">
          {item.hunt_name}
        </span>
      )}
      <span className="text-xs font-mono text-zinc-500 shrink-0">
        {formatRelativeTime(item.timestamp)}
      </span>
    </div>
  );
}
