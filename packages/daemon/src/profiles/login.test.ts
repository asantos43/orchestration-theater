// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, Conflict, InvalidInput, NotFound } from '@otheater/core';
import type { LoginFlow, ProfileRecord } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeLoginFlow,
  FakeProcessLauncher,
  InMemoryStore,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../test-helpers.js';
import { ProfileLoginService } from './login.js';

const URL_SECRET = 'https://login.example.test/authorize?state=URL-STATE-4711';
const CODE_SECRET = 'WXYZ-9876';
const PASTED_SECRET = 'PASTED-CODE-5555';
const TOKEN_SECRET = 'sk-ant-oat01-NEVER-IN-A-LOG-0123456789';
const SECRETS = [URL_SECRET, 'URL-STATE-4711', CODE_SECRET, PASTED_SECRET, TOKEN_SECRET];

interface RigOptions {
  /** What `login()` opens; default: one flow of the given mode, kept in `flows`. */
  readonly mode?: LoginFlow['mode'];
  readonly loginMode?: LoginFlow['mode'];
  readonly acceptsCode?: boolean;
  readonly openFails?: Error;
}

async function setup(options: RigOptions = {}) {
  const clock = new FakeClock(Date.UTC(2026, 10, 20, 12, 0, 0));
  const store = new InMemoryStore({ clock });
  const { logger, lines } = captureLogger();
  const flows: FakeLoginFlow[] = [];
  const adapter = new FakeClientAdapter({
    id: 'claude-code',
    launcher: new FakeProcessLauncher(),
    baseEnv: { PATH: '/bin' },
    adapterVersion: '1.0.0',
    command: { cmd: 'fake-client', args: ['--acp'] },
    ...(options.loginMode === undefined ? {} : { loginMode: options.loginMode }),
    login: () => {
      if (options.openFails !== undefined) throw options.openFails;
      const mode = options.mode ?? 'browser';
      const flow = new FakeLoginFlow({
        mode,
        ...(mode === 'terminal' ? {} : { url: URL_SECRET }),
        ...(mode === 'device_code' ? { code: CODE_SECRET } : {}),
        acceptsCode: options.acceptsCode ?? mode === 'browser',
        expectCode: PASTED_SECRET,
      });
      flows.push(flow);
      return flow;
    },
  });
  const service = new ProfileLoginService({
    store,
    clock,
    logger,
    adapters: (client) => (client === 'claude-code' ? adapter : undefined),
  });
  const add = (name: string, extra: Partial<ProfileRecord> = {}) =>
    store.profiles.create({
      client: 'claude-code',
      name,
      kind: 'token_plan',
      provider: 'anthropic',
      dir: `/tmp/not-used/${name}`,
      secretRef: null,
      ...extra,
    } as never);
  await add('main');
  return { clock, store, lines, flows, adapter, service, add };
}

type Rig = Awaited<ReturnType<typeof setup>>;

async function loginEvents(rig: Rig) {
  return (await rig.store.events.readFrom(0, 1000)).filter((e) =>
    e.type.startsWith('profile.login.'),
  );
}

/** Nothing the daemon wrote (log lines, events) holds what only the opening answer may hold. */
async function expectNothingLeaked(rig: Rig) {
  const written = JSON.stringify({
    log: rig.lines,
    events: await rig.store.events.readFrom(0, 1000),
  });
  for (const secret of SECRETS) expect(written).not.toContain(secret);
}

describe('ProfileLoginService: the three modes', () => {
  it('browser: opens, answers the URL, takes the pasted code and completes', async () => {
    const rig = await setup({ mode: 'browser' });
    const result = await rig.service.start('claude-code/main');
    expect(result).toEqual({
      status: 'started',
      profileId: 'claude-code/main',
      mode: 'browser',
      url: URL_SECRET,
      code: null,
      takesCode: true,
    });
    expect(rig.service.isOpen('claude-code/main')).toBe(true);
    expect(rig.adapter.loginsOpened.map((p) => p.id)).toEqual(['claude-code/main']);

    await rig.clock.advance(2_500);
    await rig.service.submitCode('claude-code/main', PASTED_SECRET);
    expect(rig.flows[0]?.submitted).toEqual([PASTED_SECRET]);
    await untilEnded(rig);

    const events = await loginEvents(rig);
    expect(events.map((e) => e.type)).toEqual(['profile.login.started', 'profile.login.completed']);
    expect(events[0]?.payload).toEqual({
      profileId: 'claude-code/main',
      mode: 'browser',
      takesCode: true,
    });
    expect(events[1]?.payload).toEqual({
      profileId: 'claude-code/main',
      mode: 'browser',
      durationMs: 2_500,
    });
    await expectNothingLeaked(rig);
  });

  it('device_code: answers the URL and the code, takes no code, completes', async () => {
    const rig = await setup({ mode: 'device_code' });
    const result = await rig.service.start('claude-code/main');
    expect(result).toMatchObject({
      status: 'started',
      mode: 'device_code',
      url: URL_SECRET,
      code: CODE_SECRET,
      takesCode: false,
    });
    await expect(rig.service.submitCode('claude-code/main', 'whatever')).rejects.toBeInstanceOf(
      Conflict,
    );
    rig.flows[0]?.finish();
    await untilEnded(rig);
    expect((await loginEvents(rig)).map((e) => e.type)).toEqual([
      'profile.login.started',
      'profile.login.completed',
    ]);
    await expectNothingLeaked(rig);
  });

  it('terminal: answers that the login is local and runs nothing (the mode is told first)', async () => {
    const rig = await setup({ mode: 'terminal', loginMode: 'terminal' });
    const result = await rig.service.start('claude-code/main');
    expect(result).toEqual({
      status: 'local',
      profileId: 'claude-code/main',
      mode: 'terminal',
      command: 'ot profile exec claude-code/main login',
    });
    expect(rig.adapter.loginsOpened).toEqual([]);
    expect(rig.flows).toEqual([]);
    expect(rig.service.isOpen('claude-code/main')).toBe(false);
    expect(await loginEvents(rig)).toEqual([]);
  });

  it('terminal: an adapter that cannot tell the mode first has its flow ended at once', async () => {
    const rig = await setup({ mode: 'terminal' });
    const result = await rig.service.start('claude-code/main');
    expect(result.status).toBe('local');
    expect(rig.flows).toHaveLength(1);
    expect(rig.flows[0]?.cancelled).toBe(true);
    expect(rig.service.isOpen('claude-code/main')).toBe(false);
    expect(await loginEvents(rig)).toEqual([]);
  });
});

describe('ProfileLoginService: cancel and failure', () => {
  it('cancel kills the process of the login and records profile.login.failed (cancelled)', async () => {
    const rig = await setup({ mode: 'browser' });
    await rig.service.start('claude-code/main');
    expect(await rig.service.cancel('claude-code/main')).toBe(true);
    expect(rig.flows[0]?.cancelled).toBe(true);
    expect(rig.service.isOpen('claude-code/main')).toBe(false);
    const events = await loginEvents(rig);
    expect(events.map((e) => e.type)).toEqual(['profile.login.started', 'profile.login.failed']);
    expect(events[1]?.payload).toMatchObject({
      profileId: 'claude-code/main',
      mode: 'browser',
      reason: 'cancelled',
    });
    // Nothing is open any more: a second cancel is a no-op, a code has nowhere to go.
    expect(await rig.service.cancel('claude-code/main')).toBe(false);
    await expect(rig.service.submitCode('claude-code/main', 'x')).rejects.toBeInstanceOf(Conflict);
    await expectNothingLeaked(rig);
  });

  it('a login the client ends badly is told by the class of the error, not by its message', async () => {
    const rig = await setup({ mode: 'browser' });
    await rig.service.start('claude-code/main');
    rig.flows[0]?.fail(new Error(`exit 1: ${TOKEN_SECRET} ${URL_SECRET} ${CODE_SECRET}`));
    await untilEnded(rig);
    const events = await loginEvents(rig);
    expect(events.at(-1)?.type).toBe('profile.login.failed');
    expect(events.at(-1)?.payload).toMatchObject({ reason: 'error', mode: 'browser' });
    await expectNothingLeaked(rig);
  });

  it('a login that cannot be opened is an error and one profile.login.failed with no mode', async () => {
    const rig = await setup({ openFails: new AdapterUnavailable(`no ${TOKEN_SECRET}`) });
    await expect(rig.service.start('claude-code/main')).rejects.toBeInstanceOf(AdapterUnavailable);
    const events = await loginEvents(rig);
    expect(events.map((e) => e.type)).toEqual(['profile.login.failed']);
    expect(events[0]?.payload).toMatchObject({ mode: null, reason: 'unavailable' });
    expect(rig.service.isOpen('claude-code/main')).toBe(false);
    await expectNothingLeaked(rig);
  });

  it('stop() cancels every open login', async () => {
    const rig = await setup({ mode: 'browser' });
    await rig.add('second');
    await rig.service.start('claude-code/main');
    await rig.service.start('claude-code/second');
    await rig.service.stop();
    expect(rig.flows.map((f) => f.cancelled)).toEqual([true, true]);
    expect(rig.service.isOpen('claude-code/main')).toBe(false);
    expect(rig.service.isOpen('claude-code/second')).toBe(false);
  });
});

describe('ProfileLoginService: refusals', () => {
  it('refuses an unknown profile, an API profile, a draining one and a second login', async () => {
    const rig = await setup({ mode: 'browser' });
    await expect(rig.service.start('claude-code/ghost')).rejects.toBeInstanceOf(NotFound);
    await expect(rig.service.cancel('claude-code/ghost')).rejects.toBeInstanceOf(NotFound);
    await expect(rig.service.submitCode('claude-code/ghost', 'x')).rejects.toBeInstanceOf(NotFound);
    await rig.add('keyed', { kind: 'api', secretRef: 'vault:keyed' });
    await expect(rig.service.start('claude-code/keyed')).rejects.toBeInstanceOf(Conflict);
    await rig.add('leaving');
    await rig.store.profiles.update('claude-code/leaving', { state: 'draining' });
    await expect(rig.service.start('claude-code/leaving')).rejects.toBeInstanceOf(Conflict);

    await rig.service.start('claude-code/main');
    await expect(rig.service.start('claude-code/main')).rejects.toBeInstanceOf(Conflict);
    expect(rig.adapter.loginsOpened).toHaveLength(1);
  });

  it('answers unavailable for a client with no adapter', async () => {
    const rig = await setup();
    await rig.store.profiles.create({
      client: 'codex',
      name: 'one',
      kind: 'token_plan',
      provider: 'openai',
      dir: '/tmp/not-used/codex',
      secretRef: null,
    });
    await expect(rig.service.start('codex/one')).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('hands an invalid code (an empty one) back as InvalidInput and leaves the login open', async () => {
    const rig = await setup({ mode: 'browser' });
    await rig.service.start('claude-code/main');
    await expect(rig.service.submitCode('claude-code/main', '   ')).rejects.toBeInstanceOf(
      InvalidInput,
    );
    expect(rig.service.isOpen('claude-code/main')).toBe(true);
  });
});

/** Waits for the end of the login to be written as an event (the service reaches it on its own). */
async function untilEnded(rig: Rig): Promise<void> {
  const ended = async () =>
    (await loginEvents(rig)).some((e) => e.type !== 'profile.login.started');
  for (let i = 0; i < 400 && !(await ended()); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await ended()).toBe(true);
}
