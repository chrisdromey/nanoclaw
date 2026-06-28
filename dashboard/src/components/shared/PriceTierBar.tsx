import { formatPrice } from '@/lib/format';
import type { SegmentWithStats } from '@shared/types';

interface PriceTierBarProps {
  segment: Pick<SegmentWithStats, 'price_low' | 'price_mid' | 'price_high'>;
  /** Positioned absolutely inside the bar. Use priceToPct() to calculate left %. */
  children?: React.ReactNode;
}

/** Convert a price to a percentage position within a segment's tier range. Clamped 0–100. */
export function priceToPct(
  price: number,
  segment: Pick<SegmentWithStats, 'price_low' | 'price_high'>,
): number {
  if (segment.price_low == null || segment.price_high == null) return 50;
  const range = segment.price_high - segment.price_low || 1;
  return Math.max(0, Math.min(100, ((price - segment.price_low) / range) * 100));
}

export default function PriceTierBar({ segment, children }: PriceTierBarProps) {
  if (segment.price_low == null || segment.price_high == null) return null;

  const range = segment.price_high - segment.price_low || 1;
  const midPct = segment.price_mid != null
    ? ((segment.price_mid - segment.price_low) / range) * 100
    : 50;

  return (
    <div>
      <div className="flex justify-between text-xs font-mono text-zinc-500 mb-1">
        <span>{formatPrice(segment.price_low)}</span>
        {segment.price_mid != null && (
          <span className="text-zinc-300">{formatPrice(segment.price_mid)}</span>
        )}
        <span>{formatPrice(segment.price_high)}</span>
      </div>
      <div className="relative h-2.5">
        {/* Gradient bar — clipped for rounded ends */}
        <div className="absolute inset-0 rounded-full overflow-hidden flex">
          <div className="bg-success/40 h-full" style={{ width: `${midPct}%` }} />
          <div className="bg-warning/40 h-full flex-1" />
        </div>
        {/* Markers — not clipped */}
        {children}
      </div>
      <div className="flex justify-between text-tiny text-zinc-600 mt-0.5">
        <span>Good deal</span>
        <span>Overpriced</span>
      </div>
    </div>
  );
}
