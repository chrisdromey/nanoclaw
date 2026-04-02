/** Format a number as GBP price: £1,284.50 */
export function formatPrice(value: number | null | undefined): string {
  if (value == null) return '—';
  return `£${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format a percentage with sign: +4.2% or -2.1% */
export function formatPercent(value: number | null | undefined): string {
  if (value == null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

/** Calculate percentage change between two prices */
export function priceChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Format duration: 3.2s, 450ms, 2h 14m */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Format relative time: 2m ago, 3h ago, 2d ago. Switch to date after 7 days. */
export function formatRelativeTime(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const date = new Date(
    isoString.includes('T') ? isoString : isoString + 'Z',
  );
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) return 'just now';
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  if (diffMs < 604_800_000) return `${Math.floor(diffMs / 86_400_000)}d ago`;

  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

/** Format countdown for auction end time */
export function formatCountdown(endTime: string | null | undefined): string | null {
  if (!endTime) return null;
  const end = new Date(endTime).getTime();
  const remaining = end - Date.now();
  if (remaining <= 0) return 'Ended';
  if (remaining < 3_600_000) {
    const m = Math.floor(remaining / 60_000);
    const s = Math.floor((remaining % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  if (remaining < 86_400_000) {
    const h = Math.floor(remaining / 3_600_000);
    const m = Math.floor((remaining % 3_600_000) / 60_000);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(remaining / 86_400_000);
  const h = Math.floor((remaining % 86_400_000) / 3_600_000);
  return `${d}d ${h}h`;
}

/** Get urgency level for countdown */
export function getCountdownUrgency(
  endTime: string | null | undefined,
): 'critical' | 'warning' | 'normal' | 'none' {
  if (!endTime) return 'none';
  const remaining = new Date(endTime).getTime() - Date.now();
  if (remaining <= 0) return 'none';
  if (remaining < 3_600_000) return 'critical';
  if (remaining < 4 * 3_600_000) return 'warning';
  return 'normal';
}

/** Format a count with comma thousands: 1,204 */
export function formatCount(value: number): string {
  return value.toLocaleString('en-GB');
}
