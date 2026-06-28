import { cn } from '@/lib/utils';
import { formatCountdown, getCountdownUrgency } from '@/lib/format';
import { Gavel } from 'lucide-react';
import type { Offer } from '@shared/types';

interface EbayAuctionBlockProps {
  offer: Offer;
}

/**
 * Renders the auction countdown + bid info bar for eBay auction listings.
 * Only mount this when `offer.source === 'ebay'` and buying_format includes 'AUCTION'.
 */
export default function EbayAuctionBlock({ offer }: EbayAuctionBlockProps) {
  const auctionUrgency = getCountdownUrgency(offer.auction_end_time);
  const auctionCountdown = formatCountdown(offer.auction_end_time);

  if (!auctionCountdown) return null;

  return (
    <div
      className={cn(
        'flex items-center justify-between px-4 py-3 rounded-lg border mb-6',
        auctionUrgency === 'critical'
          ? 'bg-danger/5 border-danger/30'
          : auctionUrgency === 'warning'
            ? 'bg-warning/5 border-warning/30'
            : 'bg-surface border-zinc-800',
      )}
    >
      <div className="flex items-center gap-3">
        <Gavel
          size={16}
          className={cn(
            auctionUrgency === 'critical'
              ? 'text-danger'
              : auctionUrgency === 'warning'
                ? 'text-warning'
                : 'text-zinc-400',
          )}
        />
        <div>
          <span
            className={cn(
              'font-mono text-sm',
              auctionUrgency === 'critical'
                ? 'text-danger font-semibold'
                : auctionUrgency === 'warning'
                  ? 'text-warning'
                  : 'text-zinc-300',
            )}
          >
            {auctionCountdown}
          </span>
          <span className="text-xs text-zinc-500 ml-2">remaining</span>
        </div>
      </div>
      <div className="flex items-center gap-4 text-sm">
        {offer.bid_count != null && (
          <span className="text-zinc-400">
            <span className="font-mono text-zinc-300">{offer.bid_count}</span>{' '}
            bid{offer.bid_count !== 1 ? 's' : ''}
          </span>
        )}
      </div>
    </div>
  );
}
