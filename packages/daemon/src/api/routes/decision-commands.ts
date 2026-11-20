// SPDX-License-Identifier: MPL-2.0
import { NotFound } from '@otheater/core';
import { writeSituation } from '../../situations.js';
import { available, type CommandRegistrar } from './command.js';
import type { CommandRouteDeps } from './deps.js';

/** The command that answers a decision of the Producer (P6 of docs/17). */
export function registerDecisionCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  const { store, logger } = deps;

  register('answerDecision', async ({ params, body }) => {
    const channel = available(deps.channel, 'answer a decision');
    const before = await store.decisions.get(params.decisionId);
    if (before === undefined) throw new NotFound(`There is no decision "${params.decisionId}"`);
    // The channel checks the answer against the kind of the decision and throws what the API maps.
    await channel.answer(params.decisionId, body.answer);
    const decision = (await store.decisions.get(params.decisionId)) ?? before;
    // The answer itself stays in the decision; the event says only who answered what, so a hook
    // sees it without the text the Producer wrote.
    await writeSituation(
      store.events,
      logger,
      'scenario.decision_answered',
      {
        scenarioId: before.scenarioId,
        decisionId: before.id,
        kind: before.kind,
        playId: before.playId,
      },
      {
        scenarioId: before.scenarioId,
        ...(before.playId === null ? {} : { playId: before.playId }),
      },
    );
    return { decision };
  });
}
