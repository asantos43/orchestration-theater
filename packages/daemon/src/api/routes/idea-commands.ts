// SPDX-License-Identifier: MPL-2.0
import type { IdeaRecord } from '@otheater/core';
import { available, type CommandRegistrar } from './command.js';
import type { CommandRouteDeps } from './deps.js';

/**
 * The commands on the idea queue of a scenario (P6 of docs/17). [proposta] An idea given through the
 * API has the source `tui`, the one the service already has for a client that is not the chat nor
 * the terminal. The service writes the events (`idea.*`).
 */
export function registerIdeaCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  const wrap = (idea: IdeaRecord): { idea: IdeaRecord } => ({ idea });
  const ideas = () => available(deps.ideas, 'queue ideas');

  register('addIdea', async ({ params, body }) =>
    wrap(
      await ideas().add(params.scenarioId, {
        text: body.text,
        source: 'tui',
        ...(body.area === undefined ? {} : { area: body.area }),
      }),
    ),
  );

  register('drainIdeas', async ({ params }) => {
    const result = await ideas().drain(params.scenarioId);
    return { groups: result.groups, stopped: result.stopped ?? null };
  });

  register('discardIdea', async ({ params, body }) =>
    wrap(await ideas().discard(params.ideaId, body.reason)),
  );
  register('deferIdea', async ({ params, body }) =>
    wrap(await ideas().defer(params.ideaId, body.reason)),
  );
  register('requeueIdea', async ({ params }) => wrap(await ideas().requeue(params.ideaId)));
}
