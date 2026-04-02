import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { HuntSummary } from '@shared/types';
import {
  Home,
  Target,
  Eye,
  Search,
  Activity,
  BarChart3,
  ScrollText,
  Zap,
} from 'lucide-react';

const navItems = [
  { label: 'Overview', path: '/', icon: Home },
  { label: 'Hunts', path: '/hunts', icon: Target },
  { label: 'Watched Items', path: '/watched', icon: Eye },
  { label: 'Searches', path: '/searches', icon: Search },
  { label: 'Agent Activity', path: '/agent', icon: Activity },
  { label: 'Evaluations', path: '/agent/evaluations', icon: BarChart3 },
  { label: 'Container Logs', path: '/agent/logs', icon: ScrollText },
  { label: 'System', path: '/system', icon: Zap },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  const { data: hunts } = useQuery({
    queryKey: queryKeys.hunts.all,
    queryFn: () => apiGet<HuntSummary[]>('/hunts?status=all'),
    enabled: open,
  });

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery('');
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    },
    [open],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const go = (path: string) => {
    navigate(path);
    setOpen(false);
  };

  if (!open) return null;

  const q = query.toLowerCase();
  const filteredNav = navItems.filter((item) =>
    item.label.toLowerCase().includes(q),
  );
  const filteredHunts = (hunts || []).filter((h) =>
    h.name.toLowerCase().includes(q),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={() => setOpen(false)}
      />
      <div className="relative w-full max-w-lg bg-surface border border-zinc-700 rounded-lg shadow-2xl overflow-hidden">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search pages, hunts..."
          className="w-full px-4 py-3 text-sm bg-transparent text-zinc-50 placeholder-zinc-500 border-b border-zinc-700 focus:outline-none"
          autoFocus
        />
        <div className="max-h-64 overflow-y-auto py-2">
          {filteredNav.length > 0 && (
            <div>
              <div className="px-4 py-1 text-tiny text-zinc-500 uppercase">
                Pages
              </div>
              {filteredNav.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.path}
                    onClick={() => go(item.path)}
                    className="w-full flex items-center gap-3 px-4 py-2 text-sm text-zinc-300 hover:bg-raised transition-colors"
                  >
                    <Icon size={16} className="text-zinc-500" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          )}
          {filteredHunts.length > 0 && (
            <div>
              <div className="px-4 py-1 text-tiny text-zinc-500 uppercase mt-1">
                Hunts
              </div>
              {filteredHunts.map((hunt) => (
                <button
                  key={hunt.id}
                  onClick={() => go(`/hunts/${hunt.id}`)}
                  className="w-full flex items-center gap-3 px-4 py-2 text-sm text-zinc-300 hover:bg-raised transition-colors"
                >
                  <Target size={16} className="text-zinc-500" />
                  {hunt.name}
                  <span className="ml-auto text-tiny text-zinc-500">
                    {hunt.status}
                  </span>
                </button>
              ))}
            </div>
          )}
          {filteredNav.length === 0 && filteredHunts.length === 0 && (
            <div className="px-4 py-3 text-sm text-zinc-500">
              No results
            </div>
          )}
        </div>
        <div className="border-t border-zinc-700 px-4 py-2 text-tiny text-zinc-600">
          ↑↓ to navigate · Enter to select · Esc to close
        </div>
      </div>
    </div>
  );
}
