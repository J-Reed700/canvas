import { useEffect, useEffectEvent } from 'react';

/** One subscription with the latest committed callback; every owner releases its listener. */
export function useWindowEvent<K extends keyof WindowEventMap>(
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  enabled = true,
  capture = false,
) {
  const onEvent = useEffectEvent(listener);
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener(type, onEvent, capture);
    return () => window.removeEventListener(type, onEvent, capture);
  }, [type, enabled, capture]);
}
