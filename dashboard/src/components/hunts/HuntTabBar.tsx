import { useRef, useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';

export type HuntTab = 'market' | 'offers' | 'activity' | 'settings';

interface TabDef {
  value: HuntTab;
  label: string;
  badge?: number;
}

const TABS: TabDef[] = [
  { value: 'market', label: 'Market' },
  { value: 'offers', label: 'Offers' },
  { value: 'activity', label: 'Activity' },
  { value: 'settings', label: 'Settings' },
];

interface HuntTabBarProps {
  active: HuntTab;
  onChange: (tab: HuntTab) => void;
  offerCount?: number;
}

export default function HuntTabBar({ active, onChange, offerCount }: HuntTabBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<HuntTab, HTMLButtonElement>>(new Map());
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  const measure = useCallback(() => {
    const el = tabRefs.current.get(active);
    const container = containerRef.current;
    if (!el || !container) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    setIndicator({
      left: elRect.left - containerRect.left,
      width: elRect.width,
    });
  }, [active]);

  useEffect(() => {
    measure();
    // Re-measure on resize
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measure]);

  const tabs = TABS.map((t) => ({
    ...t,
    badge: t.value === 'offers' ? offerCount : undefined,
  }));

  return (
    <div ref={containerRef} className="relative flex gap-0">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          ref={(el) => { if (el) tabRefs.current.set(tab.value, el); }}
          onClick={() => onChange(tab.value)}
          className={cn(
            'relative px-4 py-2.5 text-sm transition-colors whitespace-nowrap',
            active === tab.value
              ? 'text-zinc-50'
              : 'text-zinc-500 hover:text-zinc-300',
          )}
        >
          {tab.label}
          {tab.badge != null && tab.badge > 0 && (
            <span className="ml-1.5 font-mono text-xs text-zinc-500">{tab.badge}</span>
          )}
        </button>
      ))}
      {/* Sliding indicator */}
      <div
        className="absolute bottom-0 h-0.5 bg-accent rounded-full transition-all duration-150 ease-out"
        style={{
          left: indicator.left,
          width: indicator.width,
          boxShadow: '0 1px 6px rgba(139, 92, 246, 0.3)',
        }}
      />
    </div>
  );
}
