import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatRelativeTime, formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import PageHeader from '@/components/layout/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import type { ContainerLog, TaskRunLog } from '@shared/types';
import { MessageCircle, Calendar, AlertTriangle, Bot } from 'lucide-react';

export default function AgentActivity() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.agent.activity(1),
    queryFn: () =>
      apiGet<{
        task_logs: Array<TaskRunLog & { prompt?: string; schedule_type?: string }>;
        container_logs: ContainerLog[];
        total_container_logs: number;
      }>('/agent/activity?limit=50'),
    refetchInterval: 30_000,
  });

  // Merge and sort by time
  const items = (() => {
    if (!data) return [];
    const merged: Array<{
      type: 'task' | 'container';
      timestamp: string;
      data: Record<string, unknown>;
    }> = [];

    for (const log of data.container_logs) {
      merged.push({
        type: 'container',
        timestamp: log.timestamp,
        data: log as unknown as Record<string, unknown>,
      });
    }

    for (const log of data.task_logs) {
      merged.push({
        type: 'task',
        timestamp: log.run_at,
        data: log as unknown as Record<string, unknown>,
      });
    }

    return merged.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  })();

  return (
    <div>
      <PageHeader title="Agent Activity" />

      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-20 bg-surface border border-zinc-800 rounded-lg animate-pulse"
            />
          ))}
        </div>
      )}

      {data && items.length === 0 && (
        <div className="text-center py-12 text-zinc-500 text-sm">
          No agent activity recorded
        </div>
      )}

      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((item, i) => {
            if (item.type === 'container') {
              const log = item.data as unknown as ContainerLog;
              const isError = log.exit_code !== 0;
              return (
                <div
                  key={`container-${i}`}
                  className={cn(
                    'bg-surface border border-zinc-800 rounded-lg p-3',
                    isError && 'bg-danger-muted',
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Bot size={14} className="text-accent" />
                    <span className="text-sm text-zinc-300">
                      Container Run
                    </span>
                    <StatusBadge variant={isError ? 'error' : 'success'}>
                      {isError ? `Exit ${log.exit_code}` : 'Success'}
                    </StatusBadge>
                    <span className="ml-auto text-xs font-mono text-zinc-500">
                      {formatRelativeTime(log.timestamp)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-zinc-500">
                    <span>
                      Duration:{' '}
                      <span className="font-mono text-zinc-400">
                        {formatDuration(log.duration_ms)}
                      </span>
                    </span>
                    {log.session_id && (
                      <span>
                        Session:{' '}
                        <span className="font-mono text-zinc-400">
                          {log.session_id.slice(0, 8)}
                        </span>
                      </span>
                    )}
                    <Link
                      to="/agent/logs"
                      className="ml-auto text-accent hover:text-accent-hover"
                    >
                      View Log →
                    </Link>
                  </div>
                </div>
              );
            } else {
              const log = item.data as unknown as TaskRunLog & {
                prompt?: string;
                schedule_type?: string;
              };
              const isError = log.status !== 'success';
              return (
                <div
                  key={`task-${i}`}
                  className={cn(
                    'bg-surface border border-zinc-800 rounded-lg p-3',
                    isError && 'bg-danger-muted',
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Calendar size={14} className="text-info" />
                    <span className="text-sm text-zinc-300">
                      Scheduled Task
                    </span>
                    <StatusBadge variant={isError ? 'error' : 'success'}>
                      {log.status}
                    </StatusBadge>
                    <span className="ml-auto text-xs font-mono text-zinc-500">
                      {formatRelativeTime(log.run_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-zinc-500">
                    <span>
                      Duration:{' '}
                      <span className="font-mono text-zinc-400">
                        {formatDuration(log.duration_ms)}
                      </span>
                    </span>
                    {log.prompt && (
                      <span className="truncate max-w-xs text-zinc-500">
                        {log.prompt.slice(0, 80)}
                      </span>
                    )}
                  </div>
                  {isError && log.error && (
                    <p className="text-xs text-danger mt-1">{log.error}</p>
                  )}
                </div>
              );
            }
          })}
        </div>
      )}
    </div>
  );
}
