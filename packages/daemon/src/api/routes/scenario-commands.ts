// SPDX-License-Identifier: MPL-2.0
import { NotFound } from '@otheater/core';
import { available, type CommandRegistrar } from './command.js';
import type { CommandRouteDeps } from './deps.js';
import { scenarioOf } from './scenarios.js';

/** The commands on scenarios and what is attached to them (P6 of docs/17). */
export function registerScenarioCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  const { store } = deps;

  register('openScenario', async ({ body }) => {
    const channel = available(deps.channel, 'open a scenario');
    const { scenarioId, cursor } = await channel.openChat({
      ...(body.type === undefined ? {} : { type: body.type }),
      ...(body.repo === undefined ? {} : { repo: body.repo }),
      ...(body.base === undefined ? {} : { base: body.base }),
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.newProject === undefined ? {} : { newProject: body.newProject }),
    });
    const record = await store.scenarios.get(scenarioId);
    if (record === undefined) throw new NotFound(`There is no scenario "${scenarioId}"`);
    return { scenario: scenarioOf(record), cursor };
  });

  register('addAttachment', async ({ params, body }) => {
    const channel = available(deps.channel, 'attach to a scenario');
    return channel.attach(
      params.scenarioId,
      'text' in body
        ? { text: body.text, ...(body.name === undefined ? {} : { name: body.name }) }
        : { path: body.path, ...(body.mode === undefined ? {} : { mode: body.mode }) },
    );
  });
}
