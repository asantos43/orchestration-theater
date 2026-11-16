// SPDX-License-Identifier: MPL-2.0
import { CLOCK_PORT_VERSION, type Adapter } from '@otheater/core';
import { z } from 'zod';

export { MAX_TIMER_MS, SystemClock } from './clock.js';

/**
 * Configuration of the system clock (`adapters.clock: system`). It has no options today; the
 * empty strict schema makes a typo in the config fail at start-up instead of being ignored.
 */
export const SystemClockConfigSchema = z.object({}).strict();

export type SystemClockConfig = z.infer<typeof SystemClockConfigSchema>;

/** Identity of this adapter for the composition point (architecture 5.18). */
export const systemClockAdapter: Adapter = {
  id: 'system',
  implements: { port: 'Clock', range: `^${CLOCK_PORT_VERSION}` },
};
