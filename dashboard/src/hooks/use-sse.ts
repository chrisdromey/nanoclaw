import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

export type SSEStatus = 'connected' | 'reconnecting' | 'disconnected';

type SSECallback = (data: unknown) => void;

const listeners = new Map<string, Set<SSECallback>>();

export function useSSESubscribe(
  eventType: string,
  callback: SSECallback,
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const wrapped: SSECallback = (data) => callbackRef.current(data);
    if (!listeners.has(eventType)) listeners.set(eventType, new Set());
    listeners.get(eventType)!.add(wrapped);
    return () => {
      listeners.get(eventType)?.delete(wrapped);
    };
  }, [eventType]);
}

function notifyListeners(eventType: string, data: unknown) {
  listeners.get(eventType)?.forEach((cb) => cb(data));
}

export function useSSE() {
  const [status, setStatus] = useState<SSEStatus>('disconnected');
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef(0);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    const es = new EventSource('/api/events');
    esRef.current = es;

    es.onopen = () => {
      setStatus('connected');
      retryRef.current = 0;
    };

    es.addEventListener('search_completed', (e) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      queryClient.invalidateQueries({ queryKey: queryKeys.systemHealth });
      notifyListeners('search_completed', JSON.parse(e.data));
    });

    es.addEventListener('price_change', (e) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.watched });
      queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      notifyListeners('price_change', JSON.parse(e.data));
    });

    es.addEventListener('new_evaluation', (e) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      notifyListeners('new_evaluation', JSON.parse(e.data));
    });

    es.addEventListener('new_offers', (e) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      queryClient.invalidateQueries({ queryKey: queryKeys.hunts.all });
      notifyListeners('new_offers', JSON.parse(e.data));
    });

    es.addEventListener('agent_invocation', (e) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agent.activity(),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.systemHealth });
      notifyListeners('agent_invocation', JSON.parse(e.data));
    });

    es.onerror = () => {
      es.close();
      setStatus('reconnecting');
      const delay = Math.min(1000 * Math.pow(2, retryRef.current), 30_000);
      retryRef.current++;
      if (retryRef.current > 10) {
        setStatus('disconnected');
      }
      setTimeout(connect, delay);
    };
  }, [queryClient]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
    };
  }, [connect]);

  return status;
}
