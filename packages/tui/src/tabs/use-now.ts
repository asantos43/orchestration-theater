// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState } from 'react';

/**
 * The clock of a tab, read again every `everyMs` while `active` (the time left of an Actor, the
 * age of a reading). The clock comes from the Shell, so a test passes a fake one. No tick runs
 * while nothing on the screen needs it.
 */
export function useNow(clock: () => number, active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    if (!active) return undefined;
    setNow(clock());
    const timer = setInterval(() => {
      setNow(clock());
    }, everyMs);
    return () => {
      clearInterval(timer);
    };
  }, [active, clock, everyMs]);
  return now;
}

/** `14:03:07` in the local time of the terminal. */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
