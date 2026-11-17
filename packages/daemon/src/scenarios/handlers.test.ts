// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientAdapter, ToolDefinition } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { ToolFailure, ToolHandlers, type ToolCall } from '../mcp/handlers.js';
import { AttachmentService } from './attachments.js';
import type { ConsultService } from './consult.js';
import { ScenarioHandlers } from './handlers.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let root: string;
let store: InMemoryStore;
let handlers: ToolHandlers;
let consulted: { scenarioId: string; question: string }[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'otheater-scenario-handlers-'));
  const clock = new FakeClock();
  store = new InMemoryStore({ clock });
  await store.scenarios.create({
    id: 's1',
    kind: 'chat',
    flowId: 'chat',
    name: 's1',
    folder: root,
  });
  await store.scenarios.create({
    id: 's2',
    kind: 'chat',
    flowId: 'chat',
    name: 's2',
    folder: root,
  });
  const attachments = new AttachmentService({
    store,
    clock,
    scenariosDir: join(root, 'scenarios'),
    limits: () => ({ maxSize: 0, readMax: 1024 }),
  });
  await attachments.addText('s1', { text: 'the plan', name: 'plan.txt' });
  const image = join(root, 'a.png');
  await writeFile(image, PNG);
  await attachments.addFile('s1', { path: image });
  consulted = [];
  const consult = {
    consult: (scenarioId: string, input: { question: string }) => {
      consulted.push({ scenarioId, question: input.question });
      return Promise.resolve({ answer: 'ok' });
    },
  } as unknown as ConsultService;
  const adapters = {
    adapterOf: (client: string) =>
      ({
        capabilities: client === 'vision' ? { inputTypes: ['image'] } : {},
      }) as unknown as ClientAdapter,
  };
  const scenarioHandlers = new ScenarioHandlers();
  scenarioHandlers.bind({
    store,
    directors: { scenarioOf: (attemptId) => (attemptId === 'director/s1' ? 's1' : undefined) },
    attachments,
    consult,
    adapters,
    config: parseConfig('orchestration:\n  executor: { client: plain, profile: one, model: m }'),
  });
  handlers = scenarioHandlers.register(new ToolHandlers());
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function call(
  tool: string,
  input: unknown,
  caller: { role: string; attemptId: string; playId?: string },
): ToolCall {
  return {
    tool: { name: tool } as ToolDefinition,
    input,
    caller: {
      role: caller.role,
      attemptId: caller.attemptId,
      sessionId: undefined,
      correlation: caller.playId === undefined ? {} : { playId: caller.playId },
      record: () => Promise.resolve(),
    },
  };
}

async function run(tool: string, input: unknown, caller: Parameters<typeof call>[2]) {
  const handler = handlers.get(tool);
  if (handler === undefined) throw new Error(`no handler for ${tool}`);
  return await handler(call(tool, input, caller));
}

async function putAttempt(client: string, attemptId: string): Promise<void> {
  await store.plays
    .create({ id: 's1', scenarioId: 's1', need: 'x' } as never)
    .catch(() => undefined);
  await store.attempts.put({
    attemptId,
    playId: 's1',
    demandId: 'consult-1',
    attempt: 1,
    client,
    profile: 'one',
    state: 'executing',
    cause: null,
    sessionId: null,
    worktree: '/w',
    branch: 'b',
    lastCheckpoint: null,
    lastCheckpointAt: null,
    lastEventAt: null,
    resumes: 0,
    freeResumes: 0,
  } as never);
}

describe('the scenario handlers', () => {
  it('registers consult and read_attachment, and skips a name that is taken', () => {
    expect(handlers.has('consult')).toBe(true);
    expect(handlers.has('read_attachment')).toBe(true);
    const taken = new ToolHandlers().register('consult', () => 'mine');
    expect(
      new ScenarioHandlers().register(taken).get('consult')?.(
        call(
          'consult',
          {},
          {
            role: 'director',
            attemptId: 'x',
          },
        ),
      ),
    ).toBe('mine');
  });

  it('consult runs the consultation of the scenario of the Director', async () => {
    const reply = await run(
      'consult',
      { question: 'why' },
      { role: 'director', attemptId: 'director/s1' },
    );
    expect(reply).toEqual({ answer: 'ok' });
    expect(consulted).toEqual([{ scenarioId: 's1', question: 'why' }]);
  });

  it('consult is refused for a caller that is no Director', async () => {
    const reply = await run(
      'consult',
      { question: 'why' },
      { role: 'actor', attemptId: 'play-1/a/1' },
    );
    expect(reply).toBeInstanceOf(ToolFailure);
    expect((reply as ToolFailure).code).toBe('no_scenario');
  });

  it('read_attachment gives the text to a consultation of the scenario', async () => {
    await putAttempt('plain', 's1/consult-1/1');
    const reply = await run(
      'read_attachment',
      { id: 'A1' },
      {
        role: 'consultant',
        attemptId: 's1/consult-1/1',
        playId: 's1',
      },
    );
    expect(reply).toMatchObject({ kind: 'text', content: 'the plan' });
  });

  it('read_attachment does not hand an image to a client that does not accept images', async () => {
    await putAttempt('plain', 's1/consult-1/1');
    const refused = await run(
      'read_attachment',
      { id: 'A2' },
      {
        role: 'consultant',
        attemptId: 's1/consult-1/1',
        playId: 's1',
      },
    );
    expect((refused as ToolFailure).code).toBe('image_not_supported');

    await putAttempt('vision', 's1/consult-2/1');
    const given = await run(
      'read_attachment',
      { id: 'A2' },
      {
        role: 'consultant',
        attemptId: 's1/consult-2/1',
        playId: 's1',
      },
    );
    expect(given).toMatchObject({ kind: 'image', mime: 'image/png', encoding: 'base64' });
  });

  it('read_attachment stays inside the scenario of the caller', async () => {
    await putAttempt('plain', 's1/consult-1/1');
    const missing = await run(
      'read_attachment',
      { id: 'A9' },
      {
        role: 'consultant',
        attemptId: 's1/consult-1/1',
        playId: 's1',
      },
    );
    expect((missing as ToolFailure).code).toBe('not_found');
    const nowhere = await run('read_attachment', { id: 'A1' }, { role: 'actor', attemptId: 'z' });
    expect((nowhere as ToolFailure).code).toBe('no_scenario');
  });
});
