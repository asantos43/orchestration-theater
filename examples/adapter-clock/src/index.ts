// SPDX-License-Identifier: MPL-2.0
import { CLOCK_PORT_VERSION, type Adapter } from '@otheater/core';
import { z } from 'zod';

export { ExampleClock } from './clock.js';

/** The configuration of the adapter. It has no options; `strict` makes a typo fail at start-up. */
export const ExampleClockConfigSchema = z.object({}).strict();

/**
 * The identity the composition point reads (architecture 5.18, "Versão dos contratos"): the id
 * written in the configuration, the port, and the range of the port contract that the adapter
 * accepts. `compose.ts` refuses the adapter when the range does not cover `CLOCK_PORT_VERSION`.
 */
export const exampleClockAdapter: Adapter = {
  id: 'example',
  implements: { port: 'Clock', range: `^${CLOCK_PORT_VERSION}` },
};
