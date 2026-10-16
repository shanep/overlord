// The current time for elapsed columns. Ticks once a second by default;
// tests pin it with NowProvider so output does not depend on the clock.

import type { ReactElement, ReactNode } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';

const NowContext = createContext<number | null>(null);

export function NowProvider(props: {
  readonly now: number;
  readonly children: ReactNode;
}): ReactElement {
  return <NowContext value={props.now}>{props.children}</NowContext>;
}

function useTicking(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return (): void => {
      clearInterval(timer);
    };
  }, [enabled]);
  return now;
}

export function useNow(): number {
  const pinned = useContext(NowContext);
  const ticking = useTicking(pinned === null);
  return pinned ?? ticking;
}
