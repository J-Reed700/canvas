import { useEffect, useState } from 'react';

/** For destructive buttons: the first click arms, a second click within `ms` confirms. */
export function useArmed(ms = 3000): [boolean, (on: boolean) => void] {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ms);
    return () => clearTimeout(t);
  }, [armed, ms]);
  return [armed, setArmed];
}
