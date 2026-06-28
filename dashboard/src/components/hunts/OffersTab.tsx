import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import {
  formatPrice,
  formatRelativeTime,
  formatPercent,
  priceChange,
  formatCountdown,
  getCountdownUrgency,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import StatusBadge from '@/components/shared/StatusBadge';
import PipelineBar from '@/components/shared/PipelineBar';
import type { Hunt, OfferWithPrices, Evaluation } from '@shared/types';
import { useBaseline } from '@/hooks/use-baseline';
import { assessmentColor, assessmentLabel } from '@/lib/segment-matcher';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

type PipelineTab = 'watching' | 'new' | 'evaluated' | 'dismissed';

interface OffersTabProps {
  huntId: number;
  hunt: Hunt & {
    new_count: number;
    evaluated_count: number;
    watching_count: number;
    dismissed_count: number;
  };
}

// --- Vertical-aware offers table ---

interface OffersTableProps {
  offers: OfferWithPrices[];
  activeTab: PipelineTab;
  hunt: OffersTabProps['hunt'];
  navigate: (path: string) => void;
  matchSegment: ReturnType<typeof useBaseline>['match'];
  assessOffer: ReturnType<typeof useBaseline>['assess'];
}

function OffersTable({ offers, activeTab, hunt, navigate, matchSegment, assessOffer }: OffersTableProps) {
  const isCars = hunt.vertical === 'cars';
  const isComputers = !hunt.vertical || hunt.vertical === 'computers';
  const showAuctionCol =
    (activeTab === 'watching' || activeTab === 'new') &&
    offers.some((o) => o.buying_format?.includes('AUCTION'));

  return (
    <div className="bg-surface border border-zinc-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
            <th className="text-left py-2.5 px-4 font-medium">Title</th>
            <th className="text-right py-2.5 px-3 font-medium">Price</th>
            <th className="text-center py-2.5 px-3 font-medium">vs Base</th>
            {activeTab === 'watching' && (
              <th className="text-right py-2.5 px-3 font-medium">Change</th>
            )}
            {isCars ? (
              <>
                <th className="text-left py-2.5 px-3 font-medium">Year</th>
                <th className="text-left py-2.5 px-3 font-medium">Mileage</th>
              </>
            ) : (
              isComputers && (
                <th className="text-left py-2.5 px-3 font-medium">Condition</th>
              )
            )}
            {!isCars && (
              <th className="text-left py-2.5 px-3 font-medium">Format</th>
            )}
            {showAuctionCol && (
              <th className="text-right py-2.5 px-3 font-medium">Ends</th>
            )}
            {(activeTab === 'evaluated' || activeTab === 'dismissed') && (
              <th className="text-left py-2.5 px-3 font-medium">Decision</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/50">
          {offers.map((offer) => {
            const change = priceChange(offer.current_price, offer.first_price);
            const urgency = getCountdownUrgency(offer.auction_end_time);
            const offerAssessment = assessOffer(offer.current_price, offer.title);
            const offerSeg = matchSegment(offer.title);
            const attrs = (offer.attributes as Record<string, unknown>) ?? {};
            return (
              <tr
                key={offer.id}
                onClick={() => navigate(`/offers/${offer.id}`)}
                className={cn(
                  'hover:bg-raised cursor-pointer transition-colors',
                  urgency === 'critical' && 'border-l-2 border-l-danger',
                  urgency === 'warning' && 'border-l-2 border-l-warning',
                )}
              >
                <td className="py-2.5 px-4 text-zinc-300 max-w-xs truncate">
                  {offer.title}
                </td>
                <td className="py-2.5 px-3 text-right font-mono text-zinc-50">
                  {formatPrice(offer.current_price)}
                </td>
                <td className="py-2.5 px-3 text-center text-xs">
                  {offerAssessment ? (
                    <span
                      className={assessmentColor(offerAssessment)}
                      title={offerSeg ? offerSeg.segment.name : undefined}
                    >
                      {assessmentLabel(offerAssessment)}
                    </span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                {activeTab === 'watching' && (
                  <td
                    className={cn(
                      'py-2.5 px-3 text-right font-mono text-xs',
                      change != null && change < 0 && 'text-success',
                      change != null && change > 0 && 'text-danger',
                      (change == null || change === 0) && 'text-zinc-500',
                    )}
                  >
                    {change != null ? formatPercent(change) : '—'}
                  </td>
                )}
                {isCars ? (
                  <>
                    <td className="py-2.5 px-3 text-zinc-400 text-xs font-mono">
                      {attrs.year != null ? String(attrs.year) : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-zinc-400 text-xs">
                      {attrs.mileage_text != null ? String(attrs.mileage_text) : '—'}
                    </td>
                  </>
                ) : (
                  isComputers && (
                    <td className="py-2.5 px-3 text-zinc-400 text-xs">
                      {offer.condition || '—'}
                    </td>
                  )
                )}
                {!isCars && (
                  <td className="py-2.5 px-3 text-zinc-400 text-xs">
                    {offer.buying_format?.includes('AUCTION')
                      ? 'Auc.'
                      : offer.buying_format?.includes('FIXED')
                        ? 'BIN'
                        : offer.buying_format || '—'}
                  </td>
                )}
                {showAuctionCol && (
                  <td
                    className={cn(
                      'py-2.5 px-3 text-right font-mono text-xs',
                      urgency === 'critical' && 'text-danger font-semibold',
                      urgency === 'warning' && 'text-warning',
                      urgency === 'normal' && 'text-zinc-400',
                    )}
                  >
                    {formatCountdown(offer.auction_end_time) || '—'}
                  </td>
                )}
                {(activeTab === 'evaluated' || activeTab === 'dismissed') && (
                  <td className="py-2.5 px-3">
                    <StatusBadge variant="dismissed">{activeTab}</StatusBadge>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function OffersTab({ huntId, hunt }: OffersTabProps) {
  const [activeTab, setActiveTab] = useState<PipelineTab>('watching');
  const [refreshingWatched, setRefreshingWatched] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: offers } = useQuery({
    queryKey: queryKeys.hunts.offers(huntId, activeTab),
    queryFn: () =>
      apiGet<OfferWithPrices[]>(`/hunts/${huntId}/offers?status=${activeTab}`),
  });

  const { data: evaluations } = useQuery({
    queryKey: queryKeys.hunts.evaluations(huntId),
    queryFn: () =>
      apiGet<(Evaluation & { offer_title: string })[]>(
        `/hunts/${huntId}/evaluations`,
      ),
  });

  const { match: matchSegment, assess: assessOffer } = useBaseline(huntId);

  const handleRefreshWatched = async () => {
    setRefreshingWatched(true);
    try {
      const result = await apiPost<{ checked: number; removed: number; active: number; errors: number }>(
        `/hunts/${huntId}/refresh-watching`,
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.offers(huntId, 'watching') });
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.detail(huntId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.watched });
      if (result.removed > 0) {
        toast.success(`Checked ${result.checked}: ${result.removed} ended, ${result.active} still live`);
      } else {
        toast.success(`All ${result.checked} offers still live`);
      }
    } catch {
      toast.error('Failed to refresh watched offers');
    } finally {
      setRefreshingWatched(false);
    }
  };

  const tabs: { value: PipelineTab; label: string; count: number }[] = [
    { value: 'new', label: 'New', count: hunt.new_count },
    { value: 'watching', label: 'Watching', count: hunt.watching_count },
    { value: 'evaluated', label: 'Evaluated', count: hunt.evaluated_count },
    { value: 'dismissed', label: 'Dismissed', count: hunt.dismissed_count },
  ];

  return (
    <div className="animate-feed-in space-y-6">
      {/* Pipeline bar */}
      <PipelineBar
        new_count={hunt.new_count}
        evaluated_count={hunt.evaluated_count}
        watching_count={hunt.watching_count}
        dismissed_count={hunt.dismissed_count}
      />

      {/* Offer sub-tabs */}
      <div className="border-b border-zinc-800">
        <div className="flex items-center gap-0">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={cn(
                'px-4 py-2.5 text-sm border-b-2 transition-colors',
                activeTab === tab.value
                  ? 'border-accent text-zinc-50'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300',
              )}
            >
              {tab.label}{' '}
              {tab.count > 0 && (
                <span className="font-mono text-xs">{tab.count}</span>
              )}
            </button>
          ))}
          {activeTab === 'watching' && hunt.watching_count > 0 && (
            <button
              onClick={handleRefreshWatched}
              disabled={refreshingWatched}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={refreshingWatched ? 'animate-spin' : ''} />
              {refreshingWatched ? 'Checking...' : 'Refresh status'}
            </button>
          )}
        </div>
      </div>

      {/* Offers table */}
      {offers && offers.length > 0 ? (
        <OffersTable
          offers={offers}
          activeTab={activeTab}
          hunt={hunt}
          navigate={navigate}
          matchSegment={matchSegment}
          assessOffer={assessOffer}
        />
      ) : offers ? (
        <div className="text-center py-8 text-zinc-500 text-sm">
          No {activeTab} offers
        </div>
      ) : (
        <div className="h-32 bg-surface border border-zinc-800 rounded-lg animate-pulse" />
      )}

      {/* Recent evaluations */}
      {evaluations && evaluations.length > 0 && (
        <div>
          <h3 className="text-heading text-zinc-300 mb-3">Recent Evaluations</h3>
          <div className="bg-surface border border-zinc-800 rounded-lg divide-y divide-zinc-800/50">
            {evaluations.slice(0, 10).map((ev) => (
              <div key={ev.id} className="px-4 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <StatusBadge variant={ev.decision as 'alert' | 'skip' | 'watch'}>
                    {ev.decision}
                  </StatusBadge>
                  <span className="text-sm text-zinc-300 truncate">{ev.offer_title}</span>
                  <span className="ml-auto text-xs font-mono text-zinc-500">
                    {formatRelativeTime(ev.evaluated_at)}
                  </span>
                </div>
                {ev.reasoning && (
                  <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{ev.reasoning}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
