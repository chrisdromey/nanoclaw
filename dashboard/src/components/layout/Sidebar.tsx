import { NavLink } from 'react-router-dom';
import {
  Home,
  Target,
  Eye,
  Search,
  Bot,
  Activity,
  BarChart3,
  ScrollText,
  Zap,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SSEStatus } from '@/hooks/use-sse';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  sseStatus?: SSEStatus;
}

const navItems = [
  { to: '/', icon: Home, label: 'Overview' },
  { to: '/hunts', icon: Target, label: 'Hunts' },
  { to: '/watched', icon: Eye, label: 'Watched' },
  { to: '/searches', icon: Search, label: 'Searches' },
];

const agentItems = [
  { to: '/agent', icon: Activity, label: 'Activity' },
  { to: '/agent/evaluations', icon: BarChart3, label: 'Evaluations' },
  { to: '/agent/logs', icon: ScrollText, label: 'Logs' },
];

const systemItems = [
  { to: '/system', icon: Zap, label: 'System' },
];

function NavItem({
  to,
  icon: Icon,
  label,
  collapsed,
  end,
}: {
  to: string;
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  collapsed: boolean;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 h-10 rounded-md transition-colors duration-150',
          collapsed ? 'justify-center px-2' : 'px-3',
          isActive
            ? 'bg-accent-muted text-zinc-50 border-l-2 border-accent'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-raised border-l-2 border-transparent',
        )
      }
      title={collapsed ? label : undefined}
    >
      <Icon size={18} />
      {!collapsed && <span className="text-sm">{label}</span>}
    </NavLink>
  );
}

export default function Sidebar({ collapsed, onToggle, sseStatus }: SidebarProps) {
  return (
    <aside
      className={cn(
        'fixed top-0 left-0 h-screen bg-surface border-r border-zinc-800 flex flex-col transition-all duration-200 z-40',
        collapsed ? 'w-14' : 'w-60',
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'h-14 flex items-center border-b border-zinc-800 shrink-0',
          collapsed ? 'justify-center px-2' : 'px-4',
        )}
      >
        <span className="text-sm font-semibold text-zinc-50">
          {collapsed ? 'DH' : 'Deal Hunter'}
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
        {navItems.map((item) => (
          <NavItem
            key={item.to}
            {...item}
            collapsed={collapsed}
            end={item.to === '/'}
          />
        ))}

        {/* Agent section */}
        {!collapsed && (
          <div className="pt-4 pb-1 px-3">
            <span className="text-tiny text-zinc-500 uppercase tracking-wider">
              Agent
            </span>
          </div>
        )}
        {collapsed && <div className="h-3" />}
        <div className={cn(!collapsed && 'pl-1')}>
          {agentItems.map((item) => (
            <NavItem
              key={item.to}
              {...item}
              collapsed={collapsed}
              end={item.to === '/agent'}
            />
          ))}
        </div>

        {/* System section */}
        {!collapsed && (
          <div className="pt-4 pb-1 px-3">
            <span className="text-tiny text-zinc-500 uppercase tracking-wider">
              System
            </span>
          </div>
        )}
        {collapsed && <div className="h-3" />}
        {systemItems.map((item) => (
          <NavItem key={item.to} {...item} collapsed={collapsed} />
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-zinc-800 p-2 shrink-0 space-y-1">
        {/* SSE Status */}
        <div
          className={cn(
            'flex items-center gap-2 px-2 h-7',
            collapsed && 'justify-center',
          )}
        >
          <div
            className={cn(
              'w-1.5 h-1.5 rounded-full shrink-0',
              sseStatus === 'connected' && 'bg-success',
              sseStatus === 'reconnecting' && 'bg-warning animate-stale-pulse',
              sseStatus === 'disconnected' && 'bg-danger',
              !sseStatus && 'bg-zinc-600',
            )}
          />
          {!collapsed && (
            <span className="text-tiny text-zinc-500">
              {sseStatus === 'connected'
                ? 'Connected'
                : sseStatus === 'reconnecting'
                  ? 'Reconnecting...'
                  : 'Disconnected'}
            </span>
          )}
        </div>
        <button
          onClick={onToggle}
          className="flex items-center justify-center w-full h-8 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-raised transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronsRight size={16} />
          ) : (
            <ChevronsLeft size={16} />
          )}
        </button>
      </div>
    </aside>
  );
}
