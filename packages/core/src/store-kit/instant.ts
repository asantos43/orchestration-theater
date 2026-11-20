// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '../ports/clock.js';

/**
 * The instant of one transaction (N177): a clock that reads `clock` the first time it is asked
 * and gives that same reading every time after. [proposta] Every record and every event written in
 * a transaction carry the same stamp, so the stamp of an event is the `createdAt`, `updatedAt` or
 * `finishedAt` of the record it describes (the client reducers rely on it). With two readings,
 * a clock that moves put the event and the record 1 or 2 ms apart. The reading is lazy, so a
 * transaction that stamps nothing does not read the clock.
 */
export function transactionInstant(clock: Pick<Clock, 'now'>): Pick<Clock, 'now'> {
  let reading: number | undefined;
  return {
    now: () => {
      reading ??= clock.now();
      return reading;
    },
  };
}
