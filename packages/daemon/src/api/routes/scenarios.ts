// SPDX-License-Identifier: MPL-2.0
import { NotFound, type JsonObject, type PlayRecord, type ScenarioRecord } from '@otheater/core';
import type { ApiPlay, ApiScenario } from '@otheater/protocol';
import type { ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';
import { paginate } from './paging.js';
import { redactTree } from './redact.js';

/** A copy of the record without the named fields. */
function without<Row extends object, Name extends keyof Row>(
  record: Row,
  names: readonly Name[],
): Omit<Row, Name> {
  const kept = Object.entries(record).filter(([name]) => !names.includes(name as Name));
  return Object.fromEntries(kept) as Omit<Row, Name>;
}

/** The scenario as a list shows it: without the parts the detail carries. */
export const scenarioOf = (record: ScenarioRecord): ApiScenario =>
  without(record, ['conventions', 'configOverride']);

/** The play without the machine's own snapshot. */
export const playOf = (record: PlayRecord): ApiPlay => without(record, ['snapshot']);

/** A tree of the scenario (conventions, overrides) with what could be a secret held back. */
const safe = (tree: JsonObject): JsonObject => redactTree(tree).value;

export function registerScenarioRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { store } = deps;

  async function scenarioOrNotFound(scenarioId: string): Promise<ScenarioRecord> {
    const record = await store.scenarios.get(scenarioId);
    if (record === undefined) throw new NotFound(`There is no scenario "${scenarioId}"`);
    return record;
  }

  handlers.register('listScenarios', async ({ query }) => {
    const rows = await store.scenarios.list({
      ...(query.kind === undefined ? {} : { kinds: [query.kind] }),
      ...(query.state === undefined ? {} : { states: [query.state] }),
    });
    return paginate(rows.map(scenarioOf), (item) => [item.createdAt, item.id], query);
  });

  handlers.register('getScenario', async ({ params }) => {
    const record = await scenarioOrNotFound(params.scenarioId);
    const scenarioId = record.id;
    const [repos, openPlays, pending, attachments] = await Promise.all([
      store.scenarioRepos.list(scenarioId),
      store.plays.list({ scenarioId, open: true }),
      store.decisions.list({ scenarioId, states: ['pending'] }),
      store.attachments.list(scenarioId),
    ]);
    return {
      scenario: scenarioOf(record),
      conventions: record.conventions === null ? null : safe(record.conventions),
      configOverride: safe(record.configOverride),
      repos: [...repos],
      counts: {
        openPlays: openPlays.length,
        pendingDecisions: pending.length,
        attachments: attachments.length,
      },
    };
  });

  handlers.register('listScenarioPlays', async ({ params, query }) => {
    await scenarioOrNotFound(params.scenarioId);
    const rows = await store.plays.list({
      scenarioId: params.scenarioId,
      ...(query.open === undefined ? {} : { open: query.open === 'true' }),
      ...(query.state === undefined ? {} : { states: [query.state] }),
    });
    return paginate(rows.map(playOf), (item) => [item.createdAt, item.id], query);
  });

  handlers.register('getPlay', async ({ params }) => {
    const play = await store.plays.get(params.playId);
    if (play === undefined) throw new NotFound(`There is no play "${params.playId}"`);
    const [stages, demands] = await Promise.all([
      store.stages.list({ playId: play.id }),
      store.demands.list({ playId: play.id }),
    ]);
    return { play: playOf(play), stages: [...stages], demands: [...demands] };
  });

  handlers.register('listScenarioDecisions', async ({ params, query }) => {
    await scenarioOrNotFound(params.scenarioId);
    const rows = await store.decisions.list({
      scenarioId: params.scenarioId,
      ...(query.playId === undefined ? {} : { playId: query.playId }),
      ...(query.kind === undefined ? {} : { kinds: [query.kind] }),
      ...(query.state === undefined ? {} : { states: [query.state] }),
    });
    return paginate(rows, (item) => [item.createdAt, item.id], query);
  });
}
