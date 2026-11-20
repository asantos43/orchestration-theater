// SPDX-License-Identifier: MPL-2.0
import { available, type CommandRegistrar } from './command.js';
import type { CommandRouteDeps } from './deps.js';
import { playOf } from './scenarios.js';

/**
 * The commands on plays (P6 of docs/17). Only cancelling a play: the daemon has no command to
 * pause or resume a play, nor to pause, resume or cancel one Actor, and the API does not invent
 * one (the plan lists them as missing).
 */
export function registerPlayCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  register('cancelPlay', async ({ params, body }) => {
    const runner = available(deps.runner, 'cancel a play');
    const play = await runner.send(params.playId, {
      type: 'CANCEL',
      ...(body?.reason === undefined ? {} : { reason: body.reason }),
    });
    return { play: playOf(play) };
  });
}
