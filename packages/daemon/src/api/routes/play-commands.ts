// SPDX-License-Identifier: MPL-2.0
import { available, type CommandRegistrar } from './command.js';
import type { CommandRouteDeps } from './deps.js';
import { playOf } from './scenarios.js';

/**
 * The commands on plays (P6 of docs/17): cancel, and, since N176, pause and resume. The commands on
 * one Actor are in `attempt-commands.ts`.
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

  register('pausePlay', async ({ params, body }) => {
    const runner = available(deps.runner, 'pause a play');
    const play = await runner.send(params.playId, {
      type: 'PAUSE',
      mode: body?.mode ?? deps.pauseMode?.() ?? 'drain',
      ...(body?.reason === undefined ? {} : { reason: body.reason }),
    });
    return { play: playOf(play) };
  });

  register('resumePlay', async ({ params, body }) => {
    const runner = available(deps.runner, 'resume a play');
    const play = await runner.send(params.playId, {
      type: 'RESUME',
      ...(body?.reason === undefined ? {} : { reason: body.reason }),
    });
    return { play: playOf(play) };
  });
}
