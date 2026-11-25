// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventEnvelope } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { armFaults, disarmFaults } from '../chaos/crash-points.js';
import { defaultVcs } from '../compose.js';
import { editingTransport, editsPrompt, TEST_POLICY, TEST_PROFILE } from '../test-helpers.js';
import { AttemptRunner, attemptStartedWork } from './attempt-runner.js';
import { makeRig, specOf, until, type Rig, type RigParts } from './attempt-fixture.js';
import { SessionPool } from './pool.js';
import type { ExecutionSettings } from './settings.js';

/**
 * `resume.when_unstarted` [proposta]: the daemon dies between `session.opened` and the prompt of
 * the attempt (`attempt.before_prompt`), so the conversation it reloads at the restart never got
 * the task. With `prompt` (the default) the native resume sends the task again; with `continue` it
 * sends the continue prompt, as before the key. The continue prompt here is a script that fails, so
 * the outcome tells which of the two went.
 */

const TEST_TIMEOUT_MS = 30_000;
const ATTEMPT_ID = 'play-1/demand-1/1';
const TASK = editsPrompt({ 'a.txt': 'a\n' });

function fakes() {
  const clock = new FakeClock();
  const launcher = new FakeProcessLauncher();
  return {
    clock,
    store: new InMemoryStore({ clock }),
    launcher,
    transport: new FakeSessionTransport(),
    adapter: new FakeClientAdapter({
      launcher,
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: 'fake-client', args: [] },
    }),
  } satisfies RigParts;
}

type TestRig = Rig<ReturnType<typeof fakes>>;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  disarmFaults();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

afterAll(disposeTestGitIsolation);

/**
 * Runs the attempt until the point, where it stays (as a killed daemon would: nothing more of it
 * reaches the store), and resumes the record on a second runner with its own pool (the restarted
 * daemon).
 */
async function killedBeforePrompt(overrides: Partial<ExecutionSettings>) {
  const r: TestRig = await makeRig(fakes(), {
    continuePrompt: '#throw transient',
    maxResumes: 0,
    ...overrides,
  });
  cleanups.push(() => r.dispose());
  let reached = false;
  armFaults(
    { crash: [{ point: 'attempt.before_prompt', nth: 1 }], fail: [] },
    {
      onCrash: () => {
        reached = true;
        return new Promise<void>(() => undefined);
      },
    },
  );
  void r.runner.run(specOf(r, TASK));
  await until(() => reached, 'the attempt at attempt.before_prompt');
  const record = await r.store.attempts.get(ATTEMPT_ID);
  if (record === undefined) throw new Error('no record');
  expect(record).toMatchObject({ state: 'executing', sessionId: 'fake-session-1' });

  const pool = new SessionPool({
    clients: [r.adapter],
    launcher: r.launcher,
    transport: () => editingTransport(r.transport),
    clock: r.clock,
    settings: r.settings.pool,
  });
  cleanups.unshift(() => pool.shutdown());
  const next = new AttemptRunner({
    store: r.store,
    vcs: defaultVcs(),
    pool,
    clock: r.clock,
    settings: r.settings,
    worktreeRoot: r.worktreeRoot,
    logger: pino({ level: 'silent' }),
  });
  const outcome = await next.resume(record, {
    profile: TEST_PROFILE,
    executor: { model: 'fake-model' },
    policy: TEST_POLICY,
    prompt: TASK,
  });
  return { r, outcome };
}

describe('AttemptRunner, resume.when_unstarted', () => {
  it(
    'prompt (default): the reloaded conversation that never got the task is given it again',
    async () => {
      const { r, outcome } = await killedBeforePrompt({});
      expect(outcome).toMatchObject({ state: 'completed' });
      expect(r.transport.loaded.map((load) => load.sessionId)).toEqual(['fake-session-1']);
      // the task ran in the worktree of the attempt
      expect(await readFile(join(outcome.worktree, 'a.txt'), 'utf8')).toBe('a\n');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'continue: the continue prompt goes, as for any other resume',
    async () => {
      const { r, outcome } = await killedBeforePrompt({ whenUnstarted: 'continue' });
      expect(outcome.state).not.toBe('completed');
      expect(r.transport.loaded.map((load) => load.sessionId)).toEqual(['fake-session-1']);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('attemptStartedWork', () => {
  const event = (type: string, payload: unknown): EventEnvelope =>
    ({ id: 1, type, schemaVersion: 1, payload, at: 0 }) as unknown as EventEnvelope;
  const update = (kind: string) => event('session.update', { sessionId: 's', update: { kind } });

  it('sees no work in the opening of a session and in what the client says before a prompt', () => {
    expect(attemptStartedWork([])).toBe(false);
    expect(
      attemptStartedWork([
        event('session.opened', { sessionId: 's' }),
        update('available_commands'),
        update('config_changed'),
        update('usage'),
      ]),
    ).toBe(false);
  });

  it.each(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'])(
    'sees work in a %s',
    (kind) => {
      expect(attemptStartedWork([update('available_commands'), update(kind)])).toBe(true);
    },
  );

  it.each(['tool.called', 'terminal.output'])('sees work in a %s', (type) => {
    expect(attemptStartedWork([event(type, {})])).toBe(true);
  });
});
