import { useState, useEffect } from 'react';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

interface RelativeTimeProps {
  timestamp: string | null | undefined;
  className?: string;
}

export default function RelativeTime({
  timestamp,
  className,
}: RelativeTimeProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className={cn('font-mono text-zinc-500', className)}>
      {formatRelativeTime(timestamp)}
    </span>
  );
}
