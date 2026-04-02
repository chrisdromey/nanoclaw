import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import CommandPalette from '../CommandPalette';
import GhostKeyNavigator from '../GhostKeyNavigator';
import { useSidebar } from '@/hooks/use-sidebar';
import { useSSE } from '@/hooks/use-sse';
import { cn } from '@/lib/utils';

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
        <div className="max-w-[1400px] mx-auto p-6 2xl:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
