import { cn } from '@/lib/utils';

type BadgeVariant =
  | 'active'
  | 'paused'
  | 'closed'
  | 'new'
  | 'evaluated'
  | 'watching'
  | 'dismissed'
  | 'alert'
  | 'skip'
  | 'watch'
  | 'high'
  | 'medium'
  | 'low'
  | 'success'
  | 'error'
  | 'running'
  | 'slow'
  | 'stale';

const variantStyles: Record<BadgeVariant, string> = {
  // Hunt status
  active: 'bg-success-muted text-success',
  paused: 'bg-warning-muted text-warning',
  closed: 'bg-zinc-800 text-zinc-400',
  // Pipeline status
  new: 'bg-info-muted text-info',
  evaluated: 'bg-accent-muted text-accent',
  watching: 'bg-success-muted text-success',
  dismissed: 'bg-zinc-800 text-zinc-400',
  // Decision
  alert: 'bg-danger-muted text-danger',
  skip: 'bg-zinc-800 text-zinc-400',
  watch: 'bg-success-muted text-success',
  // Urgency
  high: 'bg-danger text-white',
  medium: 'border border-warning text-warning',
  low: 'border border-zinc-600 text-zinc-400',
  // System
  success: 'bg-success-muted text-success',
  error: 'bg-danger-muted text-danger',
  running: 'bg-success-muted text-success',
  slow: 'bg-warning-muted text-warning',
  stale: 'bg-danger-muted text-danger',
};

interface StatusBadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

export default function StatusBadge({
  variant,
  children,
  className,
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-md text-tiny font-medium',
        variantStyles[variant] || 'bg-zinc-800 text-zinc-400',
        className,
      )}
    >
      {children}
    </span>
  );
}
