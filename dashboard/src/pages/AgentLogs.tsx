import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatRelativeTime, formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import PageHeader from '@/components/layout/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import type { ContainerLog } from '@shared/types';
import { ChevronDown, ChevronRight } from 'lucide-react';

export default function AgentLogs() {
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.agent.activity(1),
    queryFn: () =>
      apiGet<{
        container_logs: ContainerLog[];
        total_container_logs: number;
      }>('/agent/activity?limit=50'),
  });

  return (
    <div>
      <PageHeader title="Container Logs" />

      {isLoading && (
        <div className="h-64 bg-surface border border-zinc-800 rounded-lg animate-pulse" />
      )}

      {data && data.container_logs.length === 0 && (
        <div className="text-center py-12 text-zinc-500 text-sm">
          No container logs found
        </div>
      )}

      {data && data.container_logs.length > 0 && (
        <div className="bg-surface border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
                <th className="w-8 py-2.5 px-2" />
                <th className="text-left py-2.5 px-3 font-medium">Time</th>
                <th className="text-right py-2.5 px-3 font-medium">
                  Duration
                </th>
                <th className="text-center py-2.5 px-3 font-medium">Exit</th>
                <th className="text-left py-2.5 px-3 font-medium">
                  Session
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {data.container_logs.map((log) => {
                const isError = log.exit_code !== 0;
                const isExpanded = expandedLog === log.filename;
                return (
                  <>
                    <tr
                      key={log.filename}
                      onClick={() =>
                        setExpandedLog(isExpanded ? null : log.filename)
                      }
                      className={cn(
                        'hover:bg-raised cursor-pointer transition-colors',
                        isError && 'border-l-2 border-l-danger',
                      )}
                    >
                      <td className="py-2.5 px-2 text-zinc-500">
                        {isExpanded ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-zinc-300 text-xs">
                        {formatRelativeTime(log.timestamp)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-zinc-400 text-xs">
                        {formatDuration(log.duration_ms)}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <StatusBadge variant={isError ? 'error' : 'success'}>
                          {log.exit_code}
                        </StatusBadge>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-zinc-500 text-xs">
                        {log.session_id?.slice(0, 8) || '—'}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${log.filename}-content`}>
                        <td colSpan={5} className="p-0">
                          <LogContent filename={log.filename} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LogContent({ filename }: { filename: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.agent.logs(filename),
    queryFn: () =>
      apiGet<{ filename: string; content: string }>(
        `/agent/logs/${filename}`,
      ),
  });

  if (isLoading) {
    return (
      <div className="p-4 bg-[#09090B] animate-pulse h-32" />
    );
  }

  if (!data?.content) {
    return (
      <div className="p-4 bg-[#09090B] text-zinc-500 text-xs">
        Failed to load log content
      </div>
    );
  }

  const lines = data.content.split('\n');

  return (
    <div className="bg-[#09090B] p-4 max-h-96 overflow-auto">
      <pre className="text-xs font-mono leading-5">
        {lines.map((line, i) => {
          const isError =
            line.includes('ERROR') || line.includes('error');
          const isWarn =
            line.includes('WARN') || line.includes('warn');
          return (
            <div
              key={i}
              className={cn(
                'px-2 -mx-2',
                isError && 'bg-danger-muted',
                isWarn && 'bg-warning-muted',
              )}
            >
              <span className="text-zinc-600 select-none mr-3 inline-block w-6 text-right">
                {i + 1}
              </span>
              <span className={cn(
                'text-zinc-400',
                isError && 'text-danger',
                isWarn && 'text-warning',
              )}>
                {line}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
