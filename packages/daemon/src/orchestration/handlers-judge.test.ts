// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { DaemonConfigSchema } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { ToolFailure, ToolHandlers } from '../mcp/handlers.js';
import { OrchestrationHandlers, type OrchestrationRuntime } from './handlers.js';

const DECISION = 'p1:j:classify_critique:-:1';

let store: InMemoryStore;
let tools: ToolHandlers;
let sent: unknown[];

beforeEach(async () => {
  store = new InMemoryStore({ clock: new FakeClock() });
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play',
    name: 's1',
    folder: '/x',
  });
  await store.plays.create({
    id: 'p1',
    scenarioId: 's1',
    need: 'slugify',
    flowId: 'play',
    flowVersion: 1,
    state: 'DECIDING',
    counters: {},
  });
  await store.decisions.create({
    id: DECISION,
    scenarioId: 's1',
    playId: 'p1',
    kind: 'judge.classify_critique',
    input: {
      playId: 'p1',
      point: 'classify_critique',
      demandId: null,
      dependentIds: [],
      reason: 'the tests are missing',
      demandIds: ['slugify-impl'],
      approvedDemands: [],
    },
  });
  sent = [];
  const handlers = new OrchestrationHandlers();
  handlers.bind({
    store,
    config: DaemonConfigSchema.parse({}),
    logger: createSilentLogger(),
    directors: { scenarioOf: () => 's1' },
    runner: {
      send: (_playId: string, event: unknown) => {
        sent.push(event);
        return Promise.resolve();
      },
    },
  } as unknown as OrchestrationRuntime);
  tools = handlers.register(new ToolHandlers());
});

function call(name: string, input: unknown): Promise<unknown> {
  const handler = tools.get(name);
  if (handler === undefined) throw new Error(`no handler for ${name}`);
  return Promise.resolve(
    handler({ tool: { name } as never, input, caller: { attemptId: 'a1' } as never }),
  );
}

describe('the Director answers a judgment point (2026-11-20, phase6 with haiku)', () => {
  it('next_action shows the schema of the answer and an example that names a real demand', async () => {
    const reply = (await call('next_action', {})) as {
      decisions: { id: string; answer?: { schema: Record<string, unknown>; example: unknown } }[];
    };
    const [decision] = reply.decisions;
    expect(decision?.id).toBe(DECISION);
    expect(decision?.answer?.schema).toMatchObject({
      type: 'object',
      required: ['failures'],
      properties: { failures: { type: 'array', minItems: 1 } },
    });
    expect(decision?.answer?.example).toEqual({
      failures: [{ kind: 'execution', demandIds: ['slugify-impl'], note: 'what failed and why' }],
    });
  });

  it('decide says what does not fit, with an example, and leaves the decision pending', async () => {
    const reply = await call('decide', {
      decisionId: DECISION,
      payload: { classification: 'execution', demandIds: ['slugify-impl'] },
    });
    expect(reply).toBeInstanceOf(ToolFailure);
    const failure = reply as ToolFailure;
    expect(failure.code).toBe('invalid_answer');
    expect(failure.message).toContain('failures');
    expect(failure.message).toContain('"demandIds":["slugify-impl"]');
    expect(sent).toEqual([]);
    expect((await store.decisions.get(DECISION))?.state).toBe('pending');
  });

  it('decide refuses an execution failure without demands, by the rule of the schema', async () => {
    const reply = await call('decide', {
      decisionId: DECISION,
      payload: { failures: [{ kind: 'execution' }] },
    });
    expect((reply as ToolFailure).message).toContain(
      'an execution failure lists the affected demands',
    );
    expect(sent).toEqual([]);
  });

  it('decide refuses a demand the script does not have, instead of cancelling the decision', async () => {
    const reply = await call('decide', {
      decisionId: DECISION,
      payload: { failures: [{ kind: 'execution', demandIds: ['invented'] }] },
    });
    expect((reply as ToolFailure).code).toBe('invalid_answer');
    expect((reply as ToolFailure).message).toContain(
      '"invented" is not a demand of the script (slugify-impl)',
    );
    expect(sent).toEqual([]);
    expect((await store.decisions.get(DECISION))?.state).toBe('pending');
  });

  it('decide sends a fitting answer to the play and settles the decision', async () => {
    const payload = {
      failures: [{ kind: 'execution', demandIds: ['slugify-impl'], note: 'no tests' }],
    };
    expect(await call('decide', { decisionId: DECISION, payload })).toEqual({ ok: true });
    expect(sent).toEqual([{ type: 'JUDGED', point: 'classify_critique', answer: payload }]);
    expect((await store.decisions.get(DECISION))?.state).toBe('decided');
  });
});
