import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const shortcuts: Record<string, { path: string; label: string }> = {
  h: { path: '/', label: 'Overview' },
  u: { path: '/hunts', label: 'Hunts' },
  w: { path: '/watched', label: 'Watched' },
  s: { path: '/searches', label: 'Searches' },
  a: { path: '/agent', label: 'Agent' },
  y: { path: '/system', label: 'System' },
};

export default function GhostKeyNavigator() {
  const [visible, setVisible] = useState(false);
  const navigate = useNavigate();
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const waitingRef = useRef(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore when in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (!waitingRef.current && e.key === 'g') {
        e.preventDefault();
        waitingRef.current = true;
        setVisible(true);
        timeoutRef.current = setTimeout(() => {
          waitingRef.current = false;
          setVisible(false);
        }, 1500);
        return;
      }

      if (waitingRef.current) {
        e.preventDefault();
        clearTimeout(timeoutRef.current);
        waitingRef.current = false;
        setVisible(false);

        if (e.key === 'Escape') return;

        const shortcut = shortcuts[e.key];
        if (shortcut) {
          navigate(shortcut.path);
        }
      }
    },
    [navigate],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timeoutRef.current);
    };
  }, [handleKeyDown]);

  if (!visible) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-overlay border border-zinc-600 rounded-full px-4 py-2 flex items-center gap-3 animate-feed-in">
      {Object.entries(shortcuts).map(([key, { label }]) => (
        <span key={key} className="text-tiny text-zinc-400">
          <kbd className="text-zinc-200 font-mono bg-zinc-700 px-1 py-0.5 rounded text-[10px]">
            {key}
          </kbd>{' '}
          {label}
        </span>
      ))}
    </div>
  );
}
