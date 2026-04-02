import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from '@/lib/api';
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
import PageHeader from '@/components/layout/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import PipelineBar from '@/components/shared/PipelineBar';
import type {
  Hunt,
  OfferWithPrices,
  SearchQuery,
  Evaluation,
} from '@shared/types';
import { Pause, Play, X, Pencil, Save, Plus, Trash2, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { useBaseline } from '@/hooks/use-baseline';
import { assessmentColor, assessmentLabel } from '@/lib/segment-matcher';

type PipelineTab = 'watching' | 'new' | 'evaluated' | 'dismissed';

export default function HuntDetail() {
  const { id } = useParams();
  const huntId = parseInt(id!);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<PipelineTab>('watching');
  const [editing, setEditing] = useState(false);
  const [editTerms, setEditTerms] = useState<string[]>([]);
  const [newTerm, setNewTerm] = useState('');
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [editingCadence, setEditingCadence] = useState(false);
  const [editCadence, setEditCadence] = useState(0);
  const [editingCategories, setEditingCategories] = useState(false);
  const [editCategories, setEditCategories] = useState('');

  const { data: hunt } = useQuery({
    queryKey: queryKeys.hunts.detail(huntId),
    queryFn: () =>
      apiGet<
        Hunt & {
          new_count: number;
          evaluated_count: number;
          watching_count: number;
          dismissed_count: number;
        }
      >(`/hunts/${huntId}`),
  });

  const { data: offers } = useQuery({
    queryKey: queryKeys.hunts.offers(huntId, activeTab),
    queryFn: () =>
      apiGet<OfferWithPrices[]>(`/hunts/${huntId}/offers?status=${activeTab}`),
  });

  const { data: searches } = useQuery({
    queryKey: queryKeys.hunts.searches(huntId),
    queryFn: () => apiGet<SearchQuery[]>(`/hunts/${huntId}/searches`),
  });

  const { data: evaluations } = useQuery({
    queryKey: queryKeys.hunts.evaluations(huntId),
    queryFn: () =>
      apiGet<(Evaluation & { offer_title: string })[]>(
        `/hunts/${huntId}/evaluations`,
      ),
  });

  const { match: matchSegment, assess: assessOffer } = useBaseline(huntId);

  if (!hunt) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-48 bg-zinc-800 rounded" />
        <div className="h-32 bg-surface border border-zinc-800 rounded-lg" />
      </div>
    );
  }

  const criteria = (() => {
    try {
      return JSON.parse(hunt.criteria);
    } catch {
      return {};
    }
  })();

  const searchTerms: string[] = (() => {
    try {
      return JSON.parse(hunt.search_terms);
    } catch {
      return [];
    }
  })();

  const startEdit = () => {
    setEditTerms([...searchTerms]);
    setNewTerm('');
    setEditing(true);
  };

  const saveTerms = async () => {
    try {
      await apiPut(`/hunts/${huntId}`, { search_terms: editTerms });
      toast.success('Search terms updated');
      setEditing(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.hunts.detail(huntId),
      });
    } catch {
      toast.error('Failed to update search terms');
    }
  };

  const addTerm = () => {
    const trimmed = newTerm.trim();
    if (trimmed && !editTerms.includes(trimmed)) {
      setEditTerms([...editTerms, trimmed]);
      setNewTerm('');
    }
  };

  const handlePauseResume = async () => {
    const action = hunt.status === 'active' ? 'pause' : 'resume';
    try {
      await apiPost(`/hunts/${huntId}/${action}`);
      toast.success(`Hunt ${action === 'pause' ? 'paused' : 'resumed'}`);
      queryClient.invalidateQueries({
        queryKey: queryKeys.hunts.detail(huntId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.all });
    } catch {
      toast.error(`Failed to ${action} hunt`);
    }
  };

  const handleClose = async (reason?: string) => {
    try {
      await apiPost(`/hunts/${huntId}/close`, { reason });
      toast.success('Hunt closed');
      setShowCloseDialog(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.hunts.detail(huntId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.all });
    } catch {
      toast.error('Failed to close hunt');
    }
  };

  const saveCadence = async (value: number) => {
    try {
      await apiPut(`/hunts/${huntId}`, { cadence_minutes: value });
      toast.success(`Cadence updated to ${value}min`);
      setEditingCadence(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.detail(huntId) });
    } catch {
      toast.error('Failed to update cadence');
    }
  };

  const saveCategories = async () => {
    try {
      await apiPut(`/hunts/${huntId}`, { category_ids: editCategories || null });
      toast.success('Categories updated');
      setEditingCategories(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.detail(huntId) });
    } catch {
      toast.error('Failed to update categories');
    }
  };

  const toggleMonitoring = async () => {
    try {
      await apiPut(`/hunts/${huntId}`, { monitoring: hunt.monitoring ? 0 : 1 });
      toast.success(hunt.monitoring ? 'Monitoring disabled' : 'Monitoring enabled');
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.detail(huntId) });
    } catch {
      toast.error('Failed to update monitoring');
    }
  };

  const tabs: { value: PipelineTab; label: string; count: number }[] = [
    { value: 'new', label: 'New', count: hunt.new_count },
    { value: 'watching', label: 'Watching', count: hunt.watching_count },
    {
      value: 'evaluated',
      label: 'Evaluated',
      count: hunt.evaluated_count,
    },
    {
      value: 'dismissed',
      label: 'Dismissed',
      count: hunt.dismissed_count,
    },
  ];

  return (
    <div>
      <PageHeader
        title={hunt.name}
        breadcrumbs={[
          { label: 'Hunts', to: '/hunts' },
          { label: hunt.name },
        ]}
        actions={
          <div className="flex items-center gap-2">
            {hunt.status !== 'closed' && (
              <>
                <button
                  onClick={handlePauseResume}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md transition-colors"
                >
                  {hunt.status === 'active' ? (
                    <>
                      <Pause size={14} /> Pause
                    </>
                  ) : (
                    <>
                      <Play size={14} /> Resume
                    </>
                  )}
                </button>
                <button
                  onClick={() => setShowCloseDialog(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-danger hover:bg-danger-muted border border-zinc-700 rounded-md transition-colors"
                >
                  <X size={14} /> Close
                </button>
              </>
            )}
            <Link
              to={`/hunts/${huntId}/prices`}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-accent hover:bg-accent-muted border border-zinc-700 rounded-md transition-colors"
            >
              <TrendingUp size={14} /> Prices
            </Link>
          </div>
        }
      />

      {/* Status line */}
      <div className="flex flex-wrap items-center gap-3 mb-6 text-sm text-zinc-400">
        <StatusBadge variant={hunt.status as 'active' | 'paused' | 'closed'}>
          {hunt.status}
        </StatusBadge>
        <span>Created {formatRelativeTime(hunt.created_at)}</span>

        {/* Cadence — click to edit */}
        {editingCadence ? (
          <select
            autoFocus
            value={editCadence}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              setEditCadence(val);
              saveCadence(val);
            }}
            onBlur={() => setEditingCadence(false)}
            className="bg-surface border border-accent rounded px-2 py-0.5 text-sm text-zinc-300 font-mono"
          >
            {[15, 30, 60, 120, 240].map((m) => (
              <option key={m} value={m}>
                Every {m}min
              </option>
            ))}
          </select>
        ) : (
          <button
            onClick={() => {
              setEditCadence(hunt.cadence_minutes);
              setEditingCadence(true);
            }}
            className="hover:text-zinc-200 transition-colors cursor-pointer"
            title="Click to edit cadence"
          >
            Every {hunt.cadence_minutes}min
          </button>
        )}

        {/* Categories — click to edit */}
        {editingCategories ? (
          <span className="flex items-center gap-1">
            <span className="text-zinc-500">Categories:</span>
            <input
              autoFocus
              value={editCategories}
              onChange={(e) => setEditCategories(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveCategories();
                if (e.key === 'Escape') setEditingCategories(false);
              }}
              onBlur={() => saveCategories()}
              placeholder="e.g. 175672,171957"
              className="bg-surface border border-accent rounded px-2 py-0.5 text-sm text-zinc-300 font-mono w-40"
            />
          </span>
        ) : (
          <button
            onClick={() => {
              setEditCategories(hunt.category_ids || '');
              setEditingCategories(true);
            }}
            className="hover:text-zinc-200 transition-colors cursor-pointer"
            title="Click to edit categories"
          >
            {hunt.category_ids ? `Categories: ${hunt.category_ids}` : 'No categories'}
          </button>
        )}

        {/* Monitoring toggle */}
        {hunt.status !== 'closed' && (
          <button
            onClick={toggleMonitoring}
            className={cn(
              'flex items-center gap-1 transition-colors',
              hunt.monitoring
                ? 'text-success hover:text-green-400'
                : 'text-zinc-500 hover:text-zinc-300',
            )}
            title="Toggle monitoring"
          >
            <span
              className={cn(
                'inline-block w-2 h-2 rounded-full',
                hunt.monitoring ? 'bg-success' : 'bg-zinc-600',
              )}
            />
            {hunt.monitoring ? 'Monitoring' : 'Not monitoring'}
          </button>
        )}
      </div>

      {/* Criteria + Search Terms */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
        {/* Criteria */}
        <div className="lg:col-span-2 bg-surface border border-zinc-800 rounded-lg p-4">
          <h3 className="text-heading text-zinc-300 mb-3">Criteria</h3>
          <div className="space-y-2 text-sm">
            {criteria.budget && (
              <div>
                <span className="text-zinc-500">Budget: </span>
                <span className="font-mono text-zinc-50">
                  ≤ {formatPrice(criteria.budget)}
                </span>
              </div>
            )}
            {criteria.must_haves && (
              <div>
                <span className="text-zinc-500">Must: </span>
                <span className="text-zinc-300">
                  {Array.isArray(criteria.must_haves)
                    ? criteria.must_haves.join(', ')
                    : criteria.must_haves}
                </span>
              </div>
            )}
            {criteria.nice_to_haves && (
              <div>
                <span className="text-zinc-500">Nice: </span>
                <span className="text-zinc-400">
                  {Array.isArray(criteria.nice_to_haves)
                    ? criteria.nice_to_haves.join(', ')
                    : criteria.nice_to_haves}
                </span>
              </div>
            )}
            {Object.keys(criteria).length === 0 && (
              <span className="text-zinc-600">No criteria set</span>
            )}
          </div>
        </div>

        {/* Search Terms */}
        <div className="lg:col-span-3 bg-surface border border-zinc-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-heading text-zinc-300">Search Terms</h3>
            {!editing && hunt.status !== 'closed' && (
              <button
                onClick={startEdit}
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                <Pencil size={12} /> Edit
              </button>
            )}
            {editing && (
              <div className="flex gap-2">
                <button
                  onClick={() => setEditing(false)}
                  className="text-xs text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  onClick={saveTerms}
                  className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover"
                >
                  <Save size={12} /> Save
                </button>
              </div>
            )}
          </div>

          {!editing ? (
            <div className="space-y-1.5">
              {searchTerms.map((term, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-zinc-300">"{term}"</span>
                </div>
              ))}
              {searchTerms.length === 0 && (
                <span className="text-sm text-zinc-600">
                  No search terms set
                </span>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {editTerms.map((term, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="font-mono text-zinc-300 flex-1">
                    "{term}"
                  </span>
                  <button
                    onClick={() =>
                      setEditTerms(editTerms.filter((_, j) => j !== i))
                    }
                    className="text-zinc-500 hover:text-danger"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newTerm}
                  onChange={(e) => setNewTerm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTerm()}
                  placeholder="Add search term..."
                  className="flex-1 px-2 py-1 text-sm bg-zinc-900 border border-zinc-700 rounded-md text-zinc-300 placeholder-zinc-600 focus:border-accent focus:outline-none"
                />
                <button
                  onClick={addTerm}
                  className="text-accent hover:text-accent-hover"
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Pipeline bar */}
      <PipelineBar
        new_count={hunt.new_count}
        evaluated_count={hunt.evaluated_count}
        watching_count={hunt.watching_count}
        dismissed_count={hunt.dismissed_count}
        className="mb-6"
      />

      {/* Offer tabs */}
      <div className="border-b border-zinc-800 mb-4">
        <div className="flex gap-0">
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
              <span className="font-mono text-xs">{tab.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Offers table */}
      {offers && offers.length > 0 ? (
        <div className="bg-surface border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
                <th className="text-left py-2.5 px-4 font-medium">Title</th>
                <th className="text-right py-2.5 px-3 font-medium">Price</th>
                <th className="text-center py-2.5 px-3 font-medium">vs Base</th>
                {activeTab === 'watching' && (
                  <th className="text-right py-2.5 px-3 font-medium">
                    Change
                  </th>
                )}
                <th className="text-left py-2.5 px-3 font-medium">
                  Condition
                </th>
                <th className="text-left py-2.5 px-3 font-medium">Format</th>
                {(activeTab === 'watching' || activeTab === 'new') && (
                  <th className="text-right py-2.5 px-3 font-medium">
                    Ends
                  </th>
                )}
                {(activeTab === 'evaluated' ||
                  activeTab === 'dismissed') && (
                  <th className="text-left py-2.5 px-3 font-medium">
                    Decision
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {offers.map((offer) => {
                const change = priceChange(
                  offer.current_price,
                  offer.first_price,
                );
                const urgency = getCountdownUrgency(offer.auction_end_time);
                const offerAssessment = assessOffer(offer.current_price, offer.title);
                const offerSeg = matchSegment(offer.title);
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
                          (change == null || change === 0) &&
                            'text-zinc-500',
                        )}
                      >
                        {change != null ? formatPercent(change) : '—'}
                      </td>
                    )}
                    <td className="py-2.5 px-3 text-zinc-400 text-xs">
                      {offer.condition || '—'}
                    </td>
                    <td className="py-2.5 px-3 text-zinc-400 text-xs">
                      {offer.buying_format?.includes('AUCTION')
                        ? 'Auc.'
                        : offer.buying_format?.includes('FIXED')
                          ? 'BIN'
                          : offer.buying_format || '—'}
                    </td>
                    {(activeTab === 'watching' || activeTab === 'new') && (
                      <td
                        className={cn(
                          'py-2.5 px-3 text-right font-mono text-xs',
                          urgency === 'critical' &&
                            'text-danger font-semibold',
                          urgency === 'warning' && 'text-warning',
                          urgency === 'normal' && 'text-zinc-400',
                        )}
                      >
                        {formatCountdown(offer.auction_end_time) || '—'}
                      </td>
                    )}
                    {(activeTab === 'evaluated' ||
                      activeTab === 'dismissed') && (
                      <td className="py-2.5 px-3">
                        {/* Show latest evaluation decision */}
                        <StatusBadge variant="dismissed">
                          {activeTab}
                        </StatusBadge>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : offers ? (
        <div className="text-center py-8 text-zinc-500 text-sm">
          No {activeTab} offers
        </div>
      ) : (
        <div className="h-32 bg-surface border border-zinc-800 rounded-lg animate-pulse" />
      )}

      {/* Recent evaluations */}
      {evaluations && evaluations.length > 0 && (
        <div className="mt-6">
          <h3 className="text-heading text-zinc-300 mb-3">
            Recent Evaluations
          </h3>
          <div className="bg-surface border border-zinc-800 rounded-lg divide-y divide-zinc-800/50">
            {evaluations.slice(0, 10).map((ev) => (
              <div key={ev.id} className="px-4 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <StatusBadge
                    variant={ev.decision as 'alert' | 'skip' | 'watch'}
                  >
                    {ev.decision}
                  </StatusBadge>
                  <span className="text-sm text-zinc-300 truncate">
                    {ev.offer_title}
                  </span>
                  <span className="ml-auto text-xs font-mono text-zinc-500">
                    {formatRelativeTime(ev.evaluated_at)}
                  </span>
                </div>
                {ev.reasoning && (
                  <p className="text-xs text-zinc-500 mt-1 line-clamp-2">
                    {ev.reasoning}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Close dialog */}
      {showCloseDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setShowCloseDialog(false)}
          />
          <div className="relative bg-surface border border-zinc-700 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-zinc-50 mb-2">
              Close hunt: {hunt.name}?
            </h3>
            <p className="text-sm text-zinc-400 mb-4">
              This will dismiss all offers and stop monitoring. This cannot
              be undone.
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
