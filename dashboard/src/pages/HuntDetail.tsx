import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import StatusBadge from '@/components/shared/StatusBadge';
import TargetsStrip from '@/components/verticals/cars/TargetsStrip';
import { getVerticalUI } from '@/lib/verticals/registry';
import HuntTabBar, { type HuntTab } from '@/components/hunts/HuntTabBar';
import MarketTab from '@/components/hunts/MarketTab';
import OffersTab from '@/components/hunts/OffersTab';
import ActivityTab from '@/components/hunts/ActivityTab';
import SettingsTab from '@/components/hunts/SettingsTab';
import type { Hunt, HuntTargetsData } from '@shared/types';
import { Pause, Play, X } from 'lucide-react';
import { toast } from 'sonner';

type HuntWithCounts = Hunt & {
  new_count: number;
  evaluated_count: number;
  watching_count: number;
  dismissed_count: number;
};

const PIPELINE_DOTS: Array<{
  key: keyof Pick<HuntWithCounts, 'new_count' | 'watching_count' | 'evaluated_count' | 'dismissed_count'>;
  label: string;
  color: string;
}> = [
  { key: 'new_count', label: 'new', color: 'bg-info' },
  { key: 'watching_count', label: 'watching', color: 'bg-success' },
  { key: 'evaluated_count', label: 'eval', color: 'bg-accent' },
  { key: 'dismissed_count', label: 'skip', color: 'bg-zinc-600' },
];

export default function HuntDetail() {
  const { id } = useParams();
  const huntId = parseInt(id!);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') || 'market') as HuntTab;
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Scroll detection for sticky header border
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const { data: hunt } = useQuery({
    queryKey: queryKeys.hunts.detail(huntId),
    queryFn: () => apiGet<HuntWithCounts>(`/hunts/${huntId}`),
  });

  // Hunt-scoped targets (Spec Explorer strip) — only for verticals that support it.
  const supportsSpecExplorer = hunt
    ? getVerticalUI(hunt.vertical).supportsSpecExplorer
    : false;
  const { data: targetsData } = useQuery({
    queryKey: queryKeys.hunts.targets(huntId),
    queryFn: () => apiGet<HuntTargetsData>(`/hunts/${huntId}/targets`),
    enabled: supportsSpecExplorer,
  });

  const handleTabChange = (newTab: HuntTab) => {
    setSearchParams({ tab: newTab }, { replace: true });
  };

  const handlePauseResume = async () => {
    if (!hunt) return;
    const action = hunt.status === 'active' ? 'pause' : 'resume';
    try {
      await apiPost(`/hunts/${huntId}/${action}`);
      toast.success(`Hunt ${action === 'pause' ? 'paused' : 'resumed'}`);
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.detail(huntId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.all() });
    } catch {
      toast.error(`Failed to ${action} hunt`);
    }
  };

  const handleClose = async (reason?: string) => {
    try {
      await apiPost(`/hunts/${huntId}/close`, { reason });
      toast.success('Hunt closed');
      setShowCloseDialog(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.detail(huntId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.all() });
    } catch {
      toast.error('Failed to close hunt');
    }
  };

  const budget = (() => {
    if (!hunt) return null;
    try {
      const c = JSON.parse(hunt.criteria || '{}');
      return c.budget || c.budget_target || c.max_price || null;
    } catch { return null; }
  })();

  const totalOffers = hunt
    ? hunt.new_count + hunt.watching_count + hunt.evaluated_count + hunt.dismissed_count
    : 0;

  if (!hunt) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-48 bg-zinc-800 rounded" />
        <div className="h-32 bg-surface border border-zinc-800 rounded-lg" />
      </div>
    );
  }

  return (
    <div>
      {/* Scroll sentinel — when this goes off-screen, we know we've scrolled */}
      <div ref={sentinelRef} className="h-0" />

      {/* Breadcrumbs (scroll away) */}
      <nav className="flex items-center gap-1.5 text-sm text-zinc-500 mb-2">
        <Link to="/hunts" className="hover:text-zinc-300 transition-colors">Hunts</Link>
        <span className="text-zinc-600">&gt;</span>
        <span className="text-zinc-400">{hunt.name}</span>
      </nav>

      {/* Sticky header */}
      <div
        className={cn(
          'sticky top-0 z-30 -mx-6 px-6 2xl:-mx-8 2xl:px-8 pt-2 pb-0 transition-colors duration-150',
          'bg-[#09090B]/95 backdrop-blur-sm',
          scrolled && 'border-b border-zinc-800',
        )}
      >
        {/* Row 1: Name + Status + Actions */}
        <div className="flex items-center justify-between gap-4 mb-2">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-page-title text-zinc-50 truncate">{hunt.name}</h1>
            <StatusBadge variant={hunt.status as 'active' | 'paused' | 'closed'}>
              {hunt.status}
            </StatusBadge>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {hunt.status !== 'closed' && (
              <>
                <button
                  onClick={handlePauseResume}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md transition-colors"
                >
                  {hunt.status === 'active' ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Resume</>}
                </button>
                <button
                  onClick={() => setShowCloseDialog(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-danger hover:bg-danger-muted border border-zinc-700 rounded-md transition-colors"
                >
                  <X size={14} /> Close
                </button>
              </>
            )}
          </div>
        </div>

        {/* Row 2: Compact pipeline counts + monitoring */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-4">
            {PIPELINE_DOTS.map(({ key, label, color }) => (
              <span key={key} className="flex items-center gap-1.5 text-xs">
                <span className={cn('w-1.5 h-1.5 rounded-full', color)} />
                <span className="font-mono text-zinc-300">{hunt[key]}</span>
                <span className="text-zinc-500">{label}</span>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span className="flex items-center gap-1.5">
              <span className={cn('w-1.5 h-1.5 rounded-full', hunt.monitoring ? 'bg-success' : 'bg-zinc-600')} />
              {hunt.monitoring ? 'Monitoring' : 'Paused'}
            </span>
            <span className="hidden sm:block">
              Created {formatRelativeTime(hunt.created_at)}
            </span>
          </div>
        </div>

        {/* Row 3: Tab bar */}
        <div className="border-b border-zinc-800">
          <HuntTabBar
            active={tab}
            onChange={handleTabChange}
            offerCount={totalOffers}
          />
        </div>
      </div>

      {/* Targets strip — slim, non-sticky row between the header block and tab content */}
      {targetsData && targetsData.targets.length > 0 && (
        <div className="mt-3">
          <TargetsStrip huntId={huntId} targets={targetsData.targets} />
        </div>
      )}

      {/* Tab content */}
      <div className="mt-6">
        {tab === 'market' && <MarketTab huntId={huntId} budget={budget} vertical={hunt.vertical} />}
        {tab === 'offers' && <OffersTab huntId={huntId} hunt={hunt} />}
        {tab === 'activity' && <ActivityTab huntId={huntId} />}
        {tab === 'settings' && <SettingsTab huntId={huntId} hunt={hunt} />}
      </div>

      {/* Close dialog */}
      {showCloseDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowCloseDialog(false)} />
          <div className="relative bg-surface border border-zinc-700 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-zinc-50 mb-2">Close hunt: {hunt.name}?</h3>
            <p className="text-sm text-zinc-400 mb-4">
              This will dismiss all offers and stop monitoring. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCloseDialog(false)}
                className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={() => handleClose()}
                className="px-3 py-1.5 text-sm text-white bg-danger hover:bg-red-600 rounded-md"
              >
                Close Hunt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
