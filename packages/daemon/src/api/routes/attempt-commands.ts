// SPDX-License-Identifier: MPL-2.0
import { NotFound } from '@otheater/core';
import { ApiAttemptSchema, type ApiAttempt } from '@otheater/protocol';
import { available, type CommandRegistrar } from './command.js';
import type { CommandRouteDeps } from './deps.js';

/**
 * The commands on one attempt, the work of an Actor in flight (Phase 7, P2, N176): pause, resume
 * and cancel. They act on the runner of the attempts; what the registry says about the attempt is
 * the answer (it is read after the command took effect). The pause of a whole play is in
 * `play-commands.ts`.
 */
export function registerAttemptCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  const view = async (attemptId: string): Promise<{ attempt: ApiAttempt }> => {
    const record = await deps.store.attempts.get(attemptId);
    if (record === undefined) throw new NotFound(`There is no attempt "${attemptId}"`);
    const rest: Partial<typeof record> = { ...record };
    delete rest.worktree;
    return { attempt: ApiAttemptSchema.parse(rest) };
  };
  const known = async (attemptId: string): Promise<void> => {
    if ((await deps.store.attempts.get(attemptId)) === undefined) {
      throw new NotFound(`There is no attempt "${attemptId}"`);
    }
  };

  register('pauseAttempt', async ({ params }) => {
    const runner = available(deps.attempts, 'pause an attempt');
    await known(params.attemptId);
    await runner.pauseAttempt(params.attemptId, 'actor');
    return view(params.attemptId);
  });

  register('resumeAttempt', async ({ params }) => {
    const runner = available(deps.attempts, 'resume an attempt');
    await known(params.attemptId);
    runner.resumeAttempt(params.attemptId, 'actor');
    return view(params.attemptId);
  });

  register('cancelAttempt', async ({ params }) => {
    const runner = available(deps.attempts, 'cancel an attempt');
    await known(params.attemptId);
    await runner.cancelAttempt(params.attemptId);
    return view(params.attemptId);
  });
}
