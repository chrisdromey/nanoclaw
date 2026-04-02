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
import { ExternalLink, Eye, EyeOff, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useBaseline } from '@/hooks/use-baseline';
import { assessmentColor, assessmentLabel } from '@/lib/segment-matcher';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

export default function OfferDetail() {
  const { id } = useParams();
  const offerId = parseInt(id!);
  const queryClient = useQueryClient();
  const [dismissingHuntId, setDismissingHuntId] = useState<number | null>(null);

  const { data: offer } = useQuery({
    queryKey: queryKeys.offers.detail(offerId),
    queryFn: () => apiGet<OfferDetailType>(`/offers/${offerId}`),
  });

  const { data: prices } = useQuery({
    queryKey: queryKeys.offers.prices(offerId),
    queryFn: () => apiGet<Price[]>(`/offers/${offerId}/prices`),
  });

  // Derive primary hunt ID before hooks that depend on it
  const primaryHuntId = offer?.hunt_associations?.find(
    (ha) => ha.status !== 'dismissed',
  )?.hunt_id ?? offer?.hunt_associations?.[0]?.hunt_id ?? null;

  // Hook must be called unconditionally (before any early return)
  const { match, assess } = useBaseline(primaryHuntId);

  if (!offer) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-64 bg-zinc-800 rounded" />
        <div className="h-48 bg-surface border border-zinc-800 rounded-lg" />
      </div>
    );
  }

  const specs = (() => {
    try {
      return JSON.parse(offer.specs_extracted || '{}');
    } catch {
      return {};
    }
  })();

  const watchConditions = (() => {
    try {
      return JSON.parse(offer.watch_conditions || '{}');
    } catch {
      return {};
    }
  })();

  const currentPrice =
    prices && prices.length > 0
      ? (prices[prices.length - 1].total_landed_gbp ??
        prices[prices.length - 1].price)
      : null;
  const firstPrice =
    prices && prices.length > 0
      ? (prices[0].total_landed_gbp ?? prices[0].price)
      : null;
  const change = priceChange(currentPrice, firstPrice);

  const chartData =
    prices?.map((p) => ({
      date: new Date(p.observed_at + 'Z').toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
      }),
      price: p.total_landed_gbp ?? p.price,
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
    } catch {
      toast.error('Failed to update watch status');
    }
  };

  const handleDismiss = async (huntId: number) => {
    try {
      await apiPost(`/offers/${offerId}/dismiss`, { hunt_id: huntId });
      queryClient.invalidateQueries({ queryKey: queryKeys.offers.detail(offerId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.watched });
      setDismissingHuntId(null);
      toast.success('Offer dismissed from hunt');
    } catch {
      toast.error('Failed to dismiss offer');
    }
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
                {offer.watching ? (
                  <>
                    <EyeOff size={14} /> Stop Watching
                  </>
                ) : (
                  <>
                    <Eye size={14} /> Watch
                  </>
                )}
              </button>
            )}
          </div>
        }
      />

      {/* Metadata */}
      <div className="flex flex-wrap items-center gap-3 mb-4 text-sm text-zinc-400">
        <span className="font-mono text-zinc-500">
          {offer.source}#{offer.source_id}
        </span>
        {offer.condition && (
          <StatusBadge variant="evaluated">{offer.condition}</StatusBadge>
        )}
        {offer.buying_format && (
          <StatusBadge variant="new">
            {offer.buying_format.includes('AUCTION') ? 'Auction' : 'BIN'}
          </StatusBadge>
        )}
        <StatusBadge
          variant={offer.watching ? 'watching' : 'dismissed'}
        >
          {offer.watching ? 'Watching' : offer.status}
        </StatusBadge>
      </div>

      {/* Seller + eBay link */}
      <div className="flex items-center gap-4 mb-6 text-sm">
        {offer.seller && (
          <span className="text-zinc-400">
            Seller:{' '}
            <span className="text-zinc-300">{offer.seller}</span>
            {offer.seller_rating != null && (
              <span
                className={cn(
                  'ml-1',
                  offer.seller_rating >= 99
                    ? 'text-success'
                    : offer.seller_rating >= 97
                      ? 'text-warning'
                      : 'text-danger',
                )}
              >
                ({offer.seller_rating}%)
              </span>
            )}
          </span>
        )}
        {offer.url && (
          <a
            href={offer.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-accent hover:text-accent-hover"
          >
            View on eBay <ExternalLink size={12} />
          </a>
        )}
      </div>

      {/* Baseline context */}
      {segMatch && (
        <div className="bg-surface border border-zinc-800 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-heading text-zinc-300">
              Market Context: {segMatch.segment.name}
            </h3>
            <div className="flex items-center gap-2">
              <StatusBadge
                variant={
                  segMatch.segment.confidence === 'HIGH' ? 'active'
                    : segMatch.segment.confidence === 'MEDIUM' ? 'medium' : 'low'
                }
              >
                {segMatch.segment.confidence}
              </StatusBadge>
              <span className="text-xs font-mono text-zinc-500">
                n={segMatch.segment.sample_size}
              </span>
            </div>
          </div>
          {/* Price position on tier bar */}
          {segMatch.segment.price_low != null && segMatch.segment.price_high != null && (
            <div className="mb-3">
              <div className="flex justify-between text-xs font-mono text-zinc-500 mb-1">
                <span>{formatPrice(segMatch.segment.price_low)}</span>
                {segMatch.segment.price_mid != null && (
                  <span className="text-zinc-400">{formatPrice(segMatch.segment.price_mid)}</span>
                )}
                <span>{formatPrice(segMatch.segment.price_high)}</span>
              </div>
              <div className="relative h-3 rounded-full overflow-hidden flex">
                <div
                  className="bg-success/30 h-full"
                  style={{
                    width: segMatch.segment.price_mid
                      ? `${((segMatch.segment.price_mid - segMatch.segment.price_low) / (segMatch.segment.price_high - segMatch.segment.price_low)) * 100}%`
                      : '50%',
                  }}
                />
                <div className="bg-warning/30 h-full flex-1" />
                {/* Current price marker */}
                {currentPrice != null && (
                  <div
                    className="absolute w-2.5 h-4 bg-white rounded-full -top-0.5 border-2 border-zinc-900"
                    style={{
                      left: `${Math.max(0, Math.min(100, ((currentPrice - segMatch.segment.price_low) / (segMatch.segment.price_high - segMatch.segment.price_low)) * 100))}%`,
                    }}
                    title={`Current: ${formatPrice(currentPrice)}`}
                  />
                )}
              </div>
              <div className="flex justify-between text-tiny text-zinc-600 mt-0.5">
                <span>Good deal</span>
                <span>Overpriced</span>
              </div>
            </div>
          )}
          {/* Assessment + notes */}
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

      {/* Price chart */}
      {chartData.length > 1 && (
        <div className="bg-surface border border-zinc-800 rounded-lg p-4 mb-6">
          <h3 className="text-heading text-zinc-300 mb-3">Price History</h3>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#8B5CF6" stopOpacity={0} />
                </linearGradient>
              </defs>
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
                formatter={(value: number) => [formatPrice(value), 'Price']}
                labelStyle={{ color: '#A1A1AA' }}
              />
              <Area
                type="monotone"
                dataKey="price"
                stroke="#8B5CF6"
                strokeWidth={2}
                fill="url(#priceGradient)"
                dot={{ r: 3, fill: '#8B5CF6', strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
          <div className="mt-2 text-sm">
            <span className="text-zinc-400">Current: </span>
            <span className="font-mono text-zinc-50">
              {formatPrice(currentPrice)}
            </span>
            {change != null && (
              <span
                className={cn(
                  'ml-2 font-mono text-xs',
                  change < 0 ? 'text-success' : change > 0 ? 'text-danger' : 'text-zinc-500',
                )}
              >
                {formatPercent(change)} from first
              </span>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Specs */}
        {Object.keys(specs).length > 0 && (
          <div className="bg-surface border border-zinc-800 rounded-lg p-4">
            <h3 className="text-heading text-zinc-300 mb-3">
              Specifications
            </h3>
            <dl className="space-y-1.5">
              {Object.entries(specs).map(([key, value]) => (
                <div key={key} className="flex gap-2 text-sm">
                  <dt className="text-zinc-500 min-w-[100px]">{key}:</dt>
                  <dd className="text-zinc-300">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {/* Watch conditions */}
        {Object.keys(watchConditions).length > 0 && (
          <div className="bg-surface border border-zinc-800 rounded-lg p-4">
            <h3 className="text-heading text-zinc-300 mb-3">
              Watch Conditions
            </h3>
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
      </div>

      {/* Hunt associations */}
      {offer.hunt_associations.length > 0 && (
        <div className="bg-surface border border-zinc-800 rounded-lg p-4 mb-6">
          <h3 className="text-heading text-zinc-300 mb-3">
            Hunt Associations
          </h3>
          <div className="space-y-2">
            {offer.hunt_associations.map((ha) => (
              <div
                key={ha.hunt_id}
                className="flex items-center gap-2 text-sm"
              >
                <Link
                  to={`/hunts/${ha.hunt_id}`}
                  className="text-accent hover:text-accent-hover"
                >
                  {ha.hunt_name}
                </Link>
                <StatusBadge
                  variant={ha.status as 'new' | 'watching' | 'dismissed' | 'evaluated'}
                >
                  {ha.status}
                </StatusBadge>
                {ha.status !== 'dismissed' && (
                  <>
                    {dismissingHuntId === ha.hunt_id ? (
                      <span className="flex items-center gap-2 ml-auto">
                        <span className="text-xs text-zinc-500">Dismiss?</span>
                        <button
                          onClick={() => handleDismiss(ha.hunt_id)}
                          className="text-xs text-danger hover:text-red-400"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setDismissingHuntId(null)}
                          className="text-xs text-zinc-500 hover:text-zinc-300"
                        >
                          No
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setDismissingHuntId(ha.hunt_id)}
                        className="ml-auto flex items-center gap-1 text-xs text-zinc-500 hover:text-danger transition-colors"
                      >
                        <XCircle size={12} /> Dismiss
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Evaluations */}
      {offer.evaluations.length > 0 && (
        <div className="bg-surface border border-zinc-800 rounded-lg p-4 mb-6">
          <h3 className="text-heading text-zinc-300 mb-3">
            Evaluation History
          </h3>
          <div className="space-y-3">
            {offer.evaluations.map((ev) => (
              <div key={ev.id} className="bg-raised rounded-md p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-zinc-500">
                    {formatRelativeTime(ev.evaluated_at)}
                  </span>
                  <StatusBadge
                    variant={ev.decision as 'alert' | 'skip' | 'watch'}
                  >
                    {ev.decision}
                  </StatusBadge>
                </div>
                {ev.reasoning && (
                  <p className="text-xs text-zinc-400 mt-1">
                    {ev.reasoning}
                  </p>
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
                  <StatusBadge
                    variant={alert.urgency as 'high' | 'medium' | 'low'}
                  >
                    {alert.urgency}
                  </StatusBadge>
                </div>
                {alert.message_sent && (
                  <p className="text-zinc-400 text-xs mt-1">
                    {alert.message_sent}
                  </p>
                )}
                {alert.user_response && (
                  <p className="text-zinc-500 text-xs mt-1 pl-4">
                    Response: {alert.user_response}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
