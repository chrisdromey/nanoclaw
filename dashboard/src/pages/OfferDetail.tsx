import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut, apiPost } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import {
  formatPrice,
  formatRelativeTime,
  formatPercent,
  priceChange,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import PageHeader from '@/components/layout/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import type { OfferDetail as OfferDetailType, Price } from '@shared/types';
import { Eye, EyeOff, XCircle, Clock, Package, ImageOff, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useBaseline } from '@/hooks/use-baseline';
import { assessmentColor, assessmentLabel } from '@/lib/segment-matcher';
import PriceTierBar, { priceToPct } from '@/components/shared/PriceTierBar';
import EbayAuctionBlock from '@/components/source-specific/EbayAuctionBlock';
import EbayConditionBadge from '@/components/source-specific/EbayConditionBadge';
import ViewOnSourceLink from '@/components/source-specific/ViewOnSourceLink';
import CarAttributesBlock from '@/components/source-specific/CarAttributesBlock';
import MustHaveChips from '@/components/verticals/cars/MustHaveChips';
import { parseCarAttributes, parseFeatures } from '@/lib/attributes';
import type { CarAttributes, HuntTargetsData, TargetInfo } from '@shared/types';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';

/** Case-insensitive "one contains the other" string match. */
function ciContains(a: string | undefined, b: unknown): boolean {
  if (!a || typeof b !== 'string' || b.trim() === '') return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al.includes(bl) || bl.includes(al);
}

/**
 * Resolve which hunt target an offer belongs to, for the "Spec sheet →" link.
 * Primary: parsed attributes make+model vs target criteria — exact model
 * equality (case-insensitive) wins outright; otherwise a contains-match counts
 * only when it is UNIQUE (overlapping model names like "EV6" / "EV6 GT" would
 * otherwise resolve by target order). Fallback: the single target whose
 * target_key appears in the offer title (case-insensitive). Returns the
 * target_key, or null when unresolved/ambiguous.
 */
export function resolveOfferTarget(
  attrs: CarAttributes,
  title: string,
  targets: TargetInfo[],
): string | null {
  const candidates = targets.filter((t) => {
    const c = t.criteria;
    return !!c && ciContains(attrs.make, c.make) && ciContains(attrs.model, c.model);
  });

  const model = attrs.model?.trim().toLowerCase();
  if (model) {
    const exact = candidates.find((t) => {
      const cm = t.criteria?.model;
      return typeof cm === 'string' && cm.trim().toLowerCase() === model;
    });
    if (exact) return exact.target_key;
  }
  if (candidates.length === 1) return candidates[0].target_key;
  if (candidates.length > 1) return null; // ambiguous — no exact winner

  const titleLower = title.toLowerCase();
  const inTitle = targets.filter((t) =>
    titleLower.includes(t.target_key.toLowerCase()),
  );
  return inTitle.length === 1 ? inTitle[0].target_key : null;
}

export default function OfferDetail() {
  const { id } = useParams();
  const offerId = parseInt(id!);
  const queryClient = useQueryClient();
  const [dismissingHuntId, setDismissingHuntId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const { data: offer } = useQuery({
    queryKey: queryKeys.offers.detail(offerId),
    queryFn: () => apiGet<OfferDetailType>(`/offers/${offerId}`),
  });

  const { data: prices } = useQuery({
    queryKey: queryKeys.offers.prices(offerId),
    queryFn: () => apiGet<Price[]>(`/offers/${offerId}/prices`),
  });

  const primaryHuntId = offer?.hunt_associations?.find(
    (ha) => ha.status !== 'dismissed',
  )?.hunt_id ?? offer?.hunt_associations?.[0]?.hunt_id ?? null;

  const { match, assess } = useBaseline(primaryHuntId);

  // Cars offers: hunt targets for must-have chips + "Spec sheet →" link.
  // Uses primaryHuntId (prefers non-dismissed associations) so the must-haves
  // shown belong to the same hunt as the market context. Skips silently when
  // the offer has no hunt associations.
  const { data: targetsData } = useQuery({
    queryKey: queryKeys.hunts.targets(primaryHuntId!),
    queryFn: () => apiGet<HuntTargetsData>(`/hunts/${primaryHuntId}/targets`),
    enabled: offer?.vertical === 'cars' && primaryHuntId != null,
  });

  if (!offer) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-64 bg-zinc-800 rounded" />
        <div className="h-48 bg-surface border border-zinc-800 rounded-lg" />
      </div>
    );
  }

  const specs = (() => {
    try { return JSON.parse(offer.specs_extracted || '{}'); } catch { return {}; }
  })();

  const watchConditions = (() => {
    try { return JSON.parse(offer.watch_conditions || '{}'); } catch { return {}; }
  })();

  const latestPrice = prices?.length ? prices[prices.length - 1] : null;
  const currentPrice = latestPrice ? (latestPrice.total_landed_gbp ?? latestPrice.price) : null;
  const currentItemPrice = latestPrice?.price ?? null;
  const currentShipping = latestPrice?.shipping ?? null;
  const firstPrice = prices?.length ? (prices[0].total_landed_gbp ?? prices[0].price) : null;
  const change = priceChange(currentPrice, firstPrice);

  const isEbayAuction = offer.source === 'ebay' && (offer.buying_format?.includes('AUCTION') ?? false);

  const chartData = prices?.map((p) => ({
    date: new Date(p.observed_at + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
    price: p.total_landed_gbp ?? p.price,
    itemPrice: p.price,
    shipping: p.shipping ?? 0,
    timestamp: p.observed_at,
  })) ?? [];

  const segMatch = match(offer.title);
  const assessment = assess(currentPrice, offer.title);

  const handleToggleWatch = async () => {
    if (!primaryHuntId) return;
    try {
      await apiPut(`/offers/${offerId}/watch`, {
        watching: offer.watching ? 0 : 1,
        hunt_id: primaryHuntId,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.offers.detail(offerId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.watched });
      toast.success(offer.watching ? 'Stopped watching' : 'Now watching');
    } catch { toast.error('Failed to update watch status'); }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await apiPost<{ status: string; refreshed?: boolean; refresh_id?: string }>(`/offers/${offerId}/refresh`);
      if (result.status === 'pending' && result.refresh_id) {
        // Async path (e.g. AutoTrader) — poll for result
        toast.info('Checking listing status…');
        const pollInterval = setInterval(async () => {
          try {
            const poll = await apiGet<{ status: string; error?: string }>(`/offers/${offerId}/refresh/${result.refresh_id}`);
            if (poll.status !== 'pending') {
              clearInterval(pollInterval);
              setRefreshing(false);
              queryClient.invalidateQueries({ queryKey: queryKeys.offers.detail(offerId) });
              if (poll.error) {
                // The async source check failed — surface it like the eBay sync path
                // does, instead of falsely reporting the listing as still active.
                toast.error('Failed to check listing status');
              } else if (poll.status === 'removed' || poll.status === 'ended' || poll.status === 'sold') {
                toast.success(`Listing has ${poll.status} — status updated`);
              } else {
                toast.success('Listing is still active');
              }
            }
          } catch {
            clearInterval(pollInterval);
            setRefreshing(false);
          }
        }, 2000);
        return; // don't call setRefreshing(false) in finally — polling handles it
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.offers.detail(offerId) });
      if (result.status === 'removed' || result.status === 'ended' || result.status === 'sold') {
        toast.success(`Listing has ${result.status} — status updated`);
      } else {
        toast.success('Listing is still active');
      }
    } catch {
      toast.error('Failed to check listing status');
    } finally {
      setRefreshing(false);
    }
  };

  const handleDismiss = async (huntId: number) => {
    try {
      await apiPost(`/offers/${offerId}/dismiss`, { hunt_id: huntId });
      queryClient.invalidateQueries({ queryKey: queryKeys.offers.detail(offerId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.watched });
      setDismissingHuntId(null);
      toast.success('Offer dismissed from hunt');
    } catch { toast.error('Failed to dismiss offer'); }
  };

  return (
    <div>
      <PageHeader
        title={offer.title}
        breadcrumbs={[
          { label: 'Offers' },
          { label: `#${offer.id}` },
        ]}
        actions={
          <div className="flex items-center gap-2">
            {primaryHuntId && (
              <button
                onClick={handleToggleWatch}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-sm border border-zinc-700 rounded-md transition-colors',
                  offer.watching
                    ? 'text-zinc-400 hover:text-zinc-200'
                    : 'text-success hover:bg-success-muted',
                )}
              >
                {offer.watching ? <><EyeOff size={14} /> Stop Watching</> : <><Eye size={14} /> Watch</>}
              </button>
            )}
            <button
              onClick={handleRefresh}
              disabled={refreshing || offer.status === 'removed'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
            <ViewOnSourceLink offer={offer} />
          </div>
        }
      />

      {/* Top section: Thumbnail + Key Info */}
      <div className="flex gap-6 mb-6">
        {/* Thumbnail */}
        <div className="w-32 h-32 shrink-0 bg-surface border border-zinc-800 rounded-lg overflow-hidden flex items-center justify-center">
          {offer.thumbnail_url ? (
            <img
              src={offer.thumbnail_url}
              alt=""
              className="w-full h-full object-contain"
              loading="lazy"
            />
          ) : (
            <ImageOff size={24} className="text-zinc-700" />
          )}
        </div>

        {/* Key metadata */}
        <div className="flex-1 min-w-0">
          {/* Badges row */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {offer.source === 'ebay' && <EbayConditionBadge condition={offer.condition} />}
            {offer.buying_format && (
              <StatusBadge variant={isEbayAuction ? 'alert' : 'new'}>
                {isEbayAuction ? 'Auction' : 'BIN'}
              </StatusBadge>
            )}
            <StatusBadge variant={offer.watching ? 'watching' : 'dismissed'}>
              {offer.watching ? 'Watching' : offer.status}
            </StatusBadge>
            <span className="font-mono text-xs text-zinc-600">
              {offer.source}#{offer.source_id}
            </span>
          </div>

          {/* Price + shipping breakdown */}
          <div className="flex items-baseline gap-4 mb-3">
            <span className="text-2xl font-mono text-zinc-50">
              {formatPrice(currentPrice)}
            </span>
            {currentShipping != null && currentShipping > 0 && (
              <span className="text-sm text-zinc-500">
                <span className="font-mono text-zinc-400">{formatPrice(currentItemPrice)}</span>
                {' + '}
                <span className="font-mono text-zinc-400">{formatPrice(currentShipping)}</span>
                <span className="ml-1">shipping</span>
              </span>
            )}
            {change != null && (
              <span className={cn(
                'font-mono text-sm',
                change < 0 ? 'text-success' : change > 0 ? 'text-danger' : 'text-zinc-500',
              )}>
                {formatPercent(change)}
              </span>
            )}
          </div>

          {/* Seller + timeline */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-400">
            {offer.seller && (
              <span>
                Seller: <span className="text-zinc-300">{offer.seller}</span>
                {offer.seller_rating != null && (
                  <span className={cn(
                    'ml-1',
                    offer.seller_rating >= 99 ? 'text-success'
                      : offer.seller_rating >= 97 ? 'text-warning' : 'text-danger',
                  )}>
                    ({offer.seller_rating}%)
                  </span>
                )}
              </span>
            )}
            <span className="flex items-center gap-1 text-xs text-zinc-500">
              <Clock size={10} />
              First seen {formatRelativeTime(offer.first_seen_at)}
            </span>
            {offer.first_seen_at !== offer.last_seen_at && (
              <span className="text-xs text-zinc-500">
                Last seen {formatRelativeTime(offer.last_seen_at)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Auction info bar — eBay only */}
      {isEbayAuction && <EbayAuctionBlock offer={offer} />}

      {/* Car attributes — cars vertical only */}
      {offer.vertical === 'cars' && (
        <CarAttributesBlock attributes={offer.attributes ?? {}} source={offer.source} />
      )}

      {/* Must-haves — cars vertical only, needs hunt targets */}
      {offer.vertical === 'cars' && targetsData && targetsData.must_have.length > 0 && (() => {
        const carAttrs = parseCarAttributes(offer.attributes ?? {});
        const features = parseFeatures(offer.attributes ?? {});
        const targetKey = resolveOfferTarget(carAttrs, offer.title, targetsData.targets);
        return (
          <div className="bg-surface border border-zinc-800 rounded-lg p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-heading text-zinc-300">Must-haves</h3>
              {targetKey && primaryHuntId != null && (
                <Link
                  to={`/hunts/${primaryHuntId}/models/${encodeURIComponent(targetKey)}`}
                  className="text-sm text-accent hover:underline"
                >
                  Spec sheet &rarr;
                </Link>
              )}
            </div>
            <MustHaveChips
              mustHaves={targetsData.must_have}
              features={features}
              mode="full"
            />
          </div>
        );
      })()}

      {/* Market context — full width */}
      {segMatch && (
        <div className="bg-surface border border-zinc-800 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-heading text-zinc-300">
              Market: {segMatch.segment.name}
            </h3>
            <span className="text-xs text-zinc-500">
              {segMatch.segment.sample_size} samples · <span className={cn(
                segMatch.segment.confidence === 'HIGH' ? 'text-success' :
                segMatch.segment.confidence === 'LOW' ? 'text-zinc-600' : 'text-zinc-400',
              )}>{segMatch.segment.confidence.toLowerCase()}</span> confidence
            </span>
          </div>
          {segMatch.segment.price_low != null && segMatch.segment.price_high != null && (
            <div className="mb-3">
              <PriceTierBar segment={segMatch.segment}>
                {currentPrice != null && (
                  <div
                    className="absolute w-2.5 h-4 bg-white rounded-full -top-0.5 border-2 border-zinc-900"
                    style={{ left: `${priceToPct(currentPrice, segMatch.segment)}%` }}
                    title={`Current: ${formatPrice(currentPrice)}`}
                  />
                )}
              </PriceTierBar>
            </div>
          )}
          <div className="flex items-center gap-3 text-sm">
            {assessment && (
              <span className={cn('font-mono text-xs', assessmentColor(assessment))}>
                {assessmentLabel(assessment)}
                {currentPrice != null && segMatch.segment.price_mid != null && (
                  <span className="text-zinc-500 ml-1">
                    (mid: {formatPrice(segMatch.segment.price_mid)})
                  </span>
                )}
              </span>
            )}
          </div>
          {segMatch.segment.notes && (
            <p className="text-xs text-zinc-500 italic mt-2">{segMatch.segment.notes}</p>
          )}
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Left column: Deal intelligence (wider) */}
        <div className="lg:col-span-2 space-y-6">
          {/* Price chart */}
          {chartData.length > 1 && (
            <div className="bg-surface border border-zinc-800 rounded-lg p-4">
              <h3 className="text-heading text-zinc-300 mb-3">Price History</h3>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.2} />
                      <stop offset="100%" stopColor="#8B5CF6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid horizontal vertical={false} stroke="#27272A" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: '#71717A' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#71717A', fontFamily: 'JetBrains Mono' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `£${v}`}
                    width={60}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#3F3F46',
                      border: '1px solid #52525B',
                      borderRadius: '6px',
                      fontSize: '12px',
                    }}
                    formatter={(value: number, name: string) => {
                      const label = name === 'shipping' ? 'Shipping' : 'Item price';
                      return [formatPrice(value), label];
                    }}
                    labelStyle={{ color: '#A1A1AA' }}
                  />
                  {/* Shipping stacked under item price */}
                  {chartData.some((d) => d.shipping > 0) && (
                    <Area
                      type="monotone"
                      dataKey="shipping"
                      stackId="1"
                      stroke="#52525B"
                      strokeWidth={1}
                      fill="#52525B"
                      fillOpacity={0.2}
                      dot={false}
                    />
                  )}
                  <Area
                    type="monotone"
                    dataKey="itemPrice"
                    stackId="1"
                    stroke="#8B5CF6"
                    strokeWidth={2}
                    fill="url(#priceGradient)"
                    dot={{ r: 3, fill: '#8B5CF6', strokeWidth: 0 }}
                  />
                  {/* Budget reference line from segment */}
                  {segMatch?.segment.price_mid != null && (
                    <ReferenceLine
                      y={segMatch.segment.price_mid}
                      stroke="#71717A"
                      strokeDasharray="4 4"
                      strokeWidth={1}
                    />
                  )}
                </AreaChart>
              </ResponsiveContainer>
              {/* Price breakdown below chart */}
              <div className="flex items-center gap-4 mt-3 pt-3 border-t border-zinc-800">
                <div>
                  <span className="text-xs text-zinc-500">Total landed</span>
                  <div className="font-mono text-zinc-50">{formatPrice(currentPrice)}</div>
                </div>
                {currentShipping != null && currentShipping > 0 && (
                  <>
                    <div>
                      <span className="text-xs text-zinc-500">Item</span>
                      <div className="font-mono text-sm text-zinc-300">{formatPrice(currentItemPrice)}</div>
                    </div>
                    <div>
                      <span className="text-xs text-zinc-500 flex items-center gap-1"><Package size={10} /> Shipping</span>
                      <div className="font-mono text-sm text-zinc-300">{formatPrice(currentShipping)}</div>
                    </div>
                  </>
                )}
                {prices && prices.length > 0 && (
                  <div className="ml-auto text-right">
                    <span className="text-xs text-zinc-500">{prices.length} observation{prices.length !== 1 ? 's' : ''}</span>
                    <div className="text-xs text-zinc-500">
                      {formatRelativeTime(prices[0].observed_at)} → {formatRelativeTime(prices[prices.length - 1].observed_at)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Single price observation (no chart) */}
          {chartData.length === 1 && (
            <div className="bg-surface border border-zinc-800 rounded-lg p-4">
              <h3 className="text-heading text-zinc-300 mb-2">Price</h3>
              <div className="flex items-center gap-4">
                <span className="font-mono text-lg text-zinc-50">{formatPrice(currentPrice)}</span>
                {currentShipping != null && currentShipping > 0 && (
                  <span className="text-sm text-zinc-500">
                    ({formatPrice(currentItemPrice)} + {formatPrice(currentShipping)} shipping)
                  </span>
                )}
                <span className="text-xs text-zinc-500">
                  Observed {formatRelativeTime(prices![0].observed_at)}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Right column: Details */}
        <div className="space-y-4">
          {/* Specs */}
          {Object.keys(specs).length > 0 && (
            <div className="bg-surface border border-zinc-800 rounded-lg p-4">
              <h3 className="text-heading text-zinc-300 mb-3">Specifications</h3>
              <dl className="space-y-1.5">
                {Object.entries(specs).map(([key, value]) => (
                  <div key={key} className="flex gap-2 text-sm">
                    <dt className="text-zinc-500 shrink-0">{key}:</dt>
                    <dd className="text-zinc-300">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Watch conditions */}
          {Object.keys(watchConditions).length > 0 && (
            <div className="bg-surface border border-zinc-800 rounded-lg p-4">
              <h3 className="text-heading text-zinc-300 mb-3">Watch Conditions</h3>
              <dl className="space-y-1.5">
                {Object.entries(watchConditions).map(([key, value]) => (
                  <div key={key} className="flex gap-2 text-sm">
                    <dt className="text-zinc-500">{key}:</dt>
                    <dd className="font-mono text-zinc-300">
                      {typeof value === 'number' ? formatPrice(value) : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Hunt associations */}
          {offer.hunt_associations.length > 0 && (
            <div className="bg-surface border border-zinc-800 rounded-lg p-4">
              <h3 className="text-heading text-zinc-300 mb-3">Hunts</h3>
              <div className="space-y-2">
                {offer.hunt_associations.map((ha) => (
                  <div key={ha.hunt_id} className="flex items-center gap-2 text-sm">
                    <Link to={`/hunts/${ha.hunt_id}`} className="text-accent hover:text-accent-hover">
                      {ha.hunt_name}
                    </Link>
                    <StatusBadge variant={ha.status as 'new' | 'watching' | 'dismissed' | 'evaluated'}>
                      {ha.status}
                    </StatusBadge>
                    {ha.status !== 'dismissed' && (
                      <>
                        {dismissingHuntId === ha.hunt_id ? (
                          <span className="flex items-center gap-2 ml-auto">
                            <button onClick={() => handleDismiss(ha.hunt_id)} className="text-xs text-danger hover:text-red-400">Yes</button>
                            <button onClick={() => setDismissingHuntId(null)} className="text-xs text-zinc-500 hover:text-zinc-300">No</button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setDismissingHuntId(ha.hunt_id)}
                            className="ml-auto flex items-center gap-1 text-xs text-zinc-500 hover:text-danger transition-colors"
                          >
                            <XCircle size={12} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Full-width bottom sections: Evaluations + Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Evaluations */}
        {offer.evaluations.length > 0 && (
          <div className="bg-surface border border-zinc-800 rounded-lg p-4">
            <h3 className="text-heading text-zinc-300 mb-3">Evaluation History</h3>
            <div className="space-y-3">
              {offer.evaluations.map((ev) => (
                <div key={ev.id} className="bg-raised rounded-md p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono text-zinc-500">
                      {formatRelativeTime(ev.evaluated_at)}
                    </span>
                    <StatusBadge variant={ev.decision as 'alert' | 'skip' | 'watch'}>
                      {ev.decision}
                    </StatusBadge>
                  </div>
                  {ev.reasoning && (
                    <p className="text-xs text-zinc-400 mt-1">{ev.reasoning}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Alerts */}
        {offer.alerts.length > 0 && (
          <div className="bg-surface border border-zinc-800 rounded-lg p-4">
            <h3 className="text-heading text-zinc-300 mb-3">Alert History</h3>
            <div className="space-y-3">
              {offer.alerts.map((alert) => (
                <div key={alert.id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-zinc-500">
                      {formatRelativeTime(alert.alerted_at)}
                    </span>
                    <StatusBadge variant={alert.urgency as 'high' | 'medium' | 'low'}>
                      {alert.urgency}
                    </StatusBadge>
                  </div>
                  {alert.message_sent && (
                    <p className="text-zinc-400 text-xs mt-1">{alert.message_sent}</p>
                  )}
                  {alert.user_response && (
                    <p className="text-zinc-500 text-xs mt-1 pl-4">Response: {alert.user_response}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
