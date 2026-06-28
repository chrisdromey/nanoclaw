import { ExternalLink } from 'lucide-react';
import type { Offer } from '@shared/types';

const SOURCE_LABELS: Record<string, string> = {
  ebay: 'eBay',
  autotrader: 'AutoTrader',
};

interface ViewOnSourceLinkProps {
  offer: Offer;
}

/**
 * Renders a "View on {Source}" button linking to the offer URL.
 * Label is derived from offer.source; falls back to a generic label.
 */
export default function ViewOnSourceLink({ offer }: ViewOnSourceLinkProps) {
  if (!offer.url) return null;

  const label = SOURCE_LABELS[offer.source] ?? offer.source;

  return (
    <a
      href={offer.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-accent hover:bg-accent-muted border border-zinc-700 rounded-md transition-colors"
    >
      View on {label} <ExternalLink size={12} />
    </a>
  );
}
