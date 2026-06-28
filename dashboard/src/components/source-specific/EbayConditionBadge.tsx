import StatusBadge from '@/components/shared/StatusBadge';

interface EbayConditionBadgeProps {
  condition: string | null;
}

/**
 * Renders a condition badge for eBay listings.
 * Returns null when condition is not set (non-eBay sources, or eBay with no condition data).
 */
export default function EbayConditionBadge({ condition }: EbayConditionBadgeProps) {
  if (!condition) return null;
  return <StatusBadge variant="evaluated">{condition}</StatusBadge>;
}
