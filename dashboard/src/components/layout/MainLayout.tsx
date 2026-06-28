import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import Sidebar from './Sidebar';
import CommandPalette from '../CommandPalette';
import GhostKeyNavigator from '../GhostKeyNavigator';
import { useSidebar } from '@/hooks/use-sidebar';
import { useSSE } from '@/hooks/use-sse';
import { cn } from '@/lib/utils';

const VERTICAL_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'computers', label: 'Computers' },
  { value: 'cars', label: 'Cars' },
];

function VerticalFilter() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentVertical = searchParams.get('vertical') ?? '';

  // Only show on hunts list page
  if (location.pathname !== '/hunts') return null;

  const handleChange = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set('vertical', value);
    } else {
      params.delete('vertical');
    }
    navigate(`/hunts?${params.toString()}`, { replace: true });
  };

  return (
    <div
      role="group"
      aria-label="Filter by vertical"
      className="flex items-center gap-1.5 bg-surface border border-zinc-800 rounded-md p-0.5"
    >
      {VERTICAL_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => handleChange(opt.value)}
          aria-pressed={currentVertical === opt.value ? 'true' : 'false'}
          className={cn(
            'px-3 py-1 rounded text-xs transition-colors',
            currentVertical === opt.value
              ? 'bg-accent text-white'
              : 'text-zinc-400 hover:text-zinc-200',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export default function MainLayout() {
  const { collapsed, toggle } = useSidebar();
  const sseStatus = useSSE();

  return (
    <div className="min-h-screen">
      <Sidebar collapsed={collapsed} onToggle={toggle} sseStatus={sseStatus} />
      <CommandPalette />
      <GhostKeyNavigator />
      <main
        className={cn(
          'transition-all duration-200 min-h-screen',
          collapsed ? 'ml-14' : 'ml-60',
        )}
      >
        {/* Global header bar — only visible when vertical filter is relevant */}
        <div className="flex items-center justify-end px-6 pt-4 2xl:px-8 2xl:pt-6">
          <VerticalFilter />
        </div>
        <div className="max-w-[1400px] mx-auto px-6 pb-6 2xl:px-8 2xl:pb-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
