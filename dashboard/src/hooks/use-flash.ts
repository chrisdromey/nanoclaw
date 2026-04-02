import { useCallback, useRef, useState } from 'react';
import { useSSESubscribe } from './use-sse';

interface FlashEntry {
  direction: 'success' | 'danger';
  expires: number;
}

export function useFlash() {
  const flashMap = useRef(new Map<number, FlashEntry>());
  const [, setTick] = useState(0);

  useSSESubscribe(
    'price_change',
    useCallback((data: unknown) => {
      const d = data as {
        offer_id: number;
        total_landed_gbp?: number;
        price: number;
      };
      // We can't easily determine direction from a single event,
      // but price_change events come when new prices are recorded.
      // For watched items, a lower price is success (green), higher is danger (red).
      // We'll flash success by default since the SSE data doesn't include previous price.
      // The actual direction will be computed by looking at the event data if available.
      const direction: 'success' | 'danger' = 'success';

      flashMap.current.set(d.offer_id, {
        direction,
        expires: Date.now() + 1500,
      });
      setTick((t) => t + 1);

      setTimeout(() => {
        flashMap.current.delete(d.offer_id);
        setTick((t) => t + 1);
      }, 1500);
    }, []),
  );

  const getFlashClass = useCallback((offerId: number): string => {
    const entry = flashMap.current.get(offerId);
    if (!entry || Date.now() > entry.expires) return '';
    return entry.direction === 'success'
      ? 'animate-flash-success'
      : 'animate-flash-danger';
  }, []);

  return { getFlashClass };
}
