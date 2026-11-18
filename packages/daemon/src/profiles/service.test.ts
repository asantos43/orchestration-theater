// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Conflict,
  InvalidInput,
  Secret,
  VaultLocked,
  type EventEnvelope,
  type Profile,
  type ProfileRecord,
  type RolePolicy,
} from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dataPaths, type DataPaths } from '../paths.js';
import { captureLogger, makeTempDataDir, type LoggedLine } from '../test-helpers.js';
import { apiKeyEnvName, apiKeyRefOf, profileSecretEnv } from './secret-env.js';
import {
  ProfileService,
  profileSettingsOf,
  type ProfileSettings,
  type ProfileSessions,
} from './service.js';

const KEY = 'sk-test-0123456789-NEVER-LOGGED';
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const policy: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface RigOptions {
  readonly notice?: ProfileSettings['sameProviderNotice'];
  readonly onTimeout?: ProfileSettings['drain']['onTimeout'];
  readonly removedDir?: ProfileSettings['drain']['removedDir'];
  readonly timeoutMs?: number;
  readonly login?: 'logged_in' | 'logged_out' | 'unknown';
  readonly vault?: InMemorySecretVault;
  readonly failLogout?: boolean;
  readonly sessions?: ProfileSessions;
}

async function setup(options: RigOptions = {}) {
  const dataDir = await makeTempDataDir();
  cleanups.push(dataDir.dispose);
  const paths: DataPaths = dataPaths(dataDir.dir);
  const clock = new FakeClock(T0);
  const inner = new InMemoryStore({ clock });
  // `fail.create` / `fail.removed` make the next N writes of that kind reject, to test the undo.
  const fail = { create: 0, removed: 0 };
  const profilesTable = new Proxy(inner.profiles, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === 'create' && typeof value === 'function') {
        return (...args: unknown[]) =>
          fail.create-- > 0
            ? Promise.reject(new Error('disk full'))
            : (value as (...a: unknown[]) => unknown).apply(target, args);
      }
      if (prop === 'update' && typeof value === 'function') {
        return (id: string, patch: { state?: string }) =>
          patch.state === 'removed' && fail.removed-- > 0
            ? Promise.reject(new Error('disk full'))
            : (value as (...a: unknown[]) => unknown).call(target, id, patch);
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  const store = new Proxy(inner, {
    get(target, prop) {
      return prop === 'profiles' ? profilesTable : (Reflect.get(target, prop) as unknown);
    },
  });
  const vault = options.vault ?? new InMemorySecretVault();
  const { logger, lines } = captureLogger();
  const launcher = new FakeProcessLauncher();
  const transport = new FakeSessionTransport();
  const prepared: string[] = [];
  const logins = new Map<string, string>();
  const adapters = new Map<string, FakeClientAdapter>();
  for (const client of ['claude-code', 'codex']) {
    adapters.set(
      client,
      new FakeClientAdapter({
        id: client,
        launcher,
        baseEnv: { PATH: '/bin' },
        adapterVersion: '1.0.0',
        command: { cmd: 'fake-client', args: ['--acp'] },
        secretEnv: profileSecretEnv({ store, vault, logger }),
        loginState: options.login ?? 'logged_in',
        onPrepareProfile: (profile) => prepared.push(profile.id),
        onLogout: (profile) => {
          if (options.failLogout === true) throw new Error('logout exploded');
          logins.set(profile.id, 'out');
        },
      }),
    );
  }
  const settings: ProfileSettings = {
    sameProviderNotice: options.notice ?? 'once',
    drain: {
      timeoutMs: options.timeoutMs ?? 600_000,
      onTimeout: options.onTimeout ?? 'handoff',
      removedDir: options.removedDir ?? 'delete',
    },
  };
  const service = new ProfileService({
    store,
    vault,
    vaultBackend: 'encrypted-file',
    clock,
    logger,
    paths,
    settings,
    adapters: (client) => adapters.get(client),
    transport: () => transport,
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    pollMs: 1000,
  });
  return {
    service,
    store,
    fail,
    vault,
    clock,
    paths,
    dataDir: dataDir.dir,
    lines,
    launcher,
    adapters,
    prepared,
    loggedOut: logins,
  };
}

type Rig = Awaited<ReturnType<typeof setup>>;

/** The value, or a failed test when it is missing (a stand-in for a non-null assertion). */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/**
 * Lets the fake clock run while `work` waits: each time the service sleeps, time moves one step.
 * (The store answers on real ticks, so a single `advance` could come before the first sleep.)
 */
async function settled<T>(rig: Rig, work: Promise<T>, stepMs = 1000): Promise<T> {
  const state = { done: false };
  const isDone = (): boolean => state.done;
  const guarded = work.finally(() => {
    state.done = true;
  });
  guarded.catch(() => undefined);
  for (let i = 0; i < 2000 && !isDone(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!isDone() && rig.clock.pendingSleeps > 0) await rig.clock.advance(stepMs);
  }
  return guarded;
}

async function eventsOf(rig: Rig, prefix = 'profile.'): Promise<EventEnvelope[]> {
  return (await rig.store.events.readFrom(0, 1000)).filter((e) => e.type.startsWith(prefix));
}

async function addSub(
  rig: Rig,
  client: string,
  name: string,
  provider = 'anthropic',
  accept = true,
) {
  const result = await rig.service.add({
    client,
    name,
    kind: 'token_plan',
    provider,
    acceptNotice: accept,
  });
  if (result.status !== 'added') throw new Error('expected the profile to be added');
  return result;
}

async function addApi(rig: Rig, client: string, name: string, provider = 'anthropic') {
  const result = await rig.service.add({
    client,
    name,
    kind: 'api',
    provider,
    apiKey: new Secret(KEY),
  });
  if (result.status !== 'added') throw new Error('expected the profile to be added');
  return result;
}

function profileOf(record: ProfileRecord): Profile {
  return { client: record.client, profile: record.name, id: record.id, dir: record.dir };
}

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

describe('ProfileService.add (Phase 5, P2)', () => {
  it('[proposta] makes three profiles, two of one client and one of them API, with the notice once', async () => {
    const rig = await setup();
    const first = await addSub(rig, 'claude-code', 'main');
    expect(first.notice).toBeNull();
    expect(first.login).toBe('logged_in');
    expect(first.profile).toMatchObject({
      id: 'claude-code/main',
      state: 'active',
      kind: 'token_plan',
    });
    expect(first.profile.noticeAcceptedAt).toBeNull();

    // The second subscription of the provider: nothing is made until the notice is accepted.
    const refused = await rig.service.add({
      client: 'claude-code',
      name: 'second',
      kind: 'token_plan',
      provider: 'anthropic',
    });
    expect(refused).toEqual({
      status: 'needs_notice',
      notice: { provider: 'anthropic', existing: ['claude-code/main'], mode: 'once' },
    });
    expect(await rig.store.profiles.get('claude-code/second')).toBeUndefined();
    expect(existsSync(join(rig.paths.profiles, 'claude-code', 'second'))).toBe(false);

    const second = await addSub(rig, 'claude-code', 'second');
    expect(second.notice).toMatchObject({ provider: 'anthropic', existing: ['claude-code/main'] });
    expect(second.profile.noticeAcceptedAt).toBe(T0);

    // An API account never raises it, and the third subscription finds it already accepted.
    const api = await addApi(rig, 'claude-code', 'api-key');
    expect(api.notice).toBeNull();
    expect(api.login).toBeNull();
    expect(api).toMatchObject({ hasSecret: true, secretBackend: 'encrypted-file' });
    const third = await addSub(rig, 'codex', 'third');
    expect(third.notice).toBeNull();

    const events = await eventsOf(rig);
    expect(events.map((e) => e.type)).toEqual([
      'profile.added',
      'profile.added',
      'profile.notice_accepted',
      'profile.added',
      'profile.added',
    ]);
    expect((await rig.store.profiles.list()).map((p) => p.id)).toEqual([
      'claude-code/api-key',
      'claude-code/main',
      'claude-code/second',
      'codex/third',
    ]);
  });

  it('[proposta] honours the three modes of profiles.same_provider_notice', async () => {
    const always = await setup({ notice: 'always' });
    await addSub(always, 'claude-code', 'a');
    await addSub(always, 'claude-code', 'b');
    const again = await always.service.add({
      client: 'claude-code',
      name: 'c',
      kind: 'token_plan',
      provider: 'anthropic',
    });
    expect(again.status).toBe('needs_notice');

    const off = await setup({ notice: 'off' });
    await addSub(off, 'claude-code', 'a', 'anthropic', false);
    const second = await addSub(off, 'claude-code', 'b', 'anthropic', false);
    expect(second.notice).toBeNull();
    expect(await eventsOf(off, 'profile.notice_accepted')).toEqual([]);
  });

  it('[proposta] another provider, or a removed subscription, does not raise the notice', async () => {
    const rig = await setup();
    await addSub(rig, 'claude-code', 'a', 'anthropic');
    expect((await addSub(rig, 'codex', 'b', 'openai', false)).notice).toBeNull();
    await rig.service.remove('claude-code/a', { timeoutMs: 0 });
    expect((await addSub(rig, 'claude-code', 'c', 'anthropic', false)).notice).toBeNull();
  });

  it('prepares the directory through the adapter, keeps the key in the vault and out of the row', async () => {
    const rig = await setup();
    const api = await addApi(rig, 'codex', 'key');
    expect(rig.prepared).toEqual(['codex/key']);
    const { profile } = api;
    expect(profile.dir).toBe(join(rig.paths.profiles, 'codex', 'key'));
    expect((await stat(profile.dir)).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect((await stat(profile.dir)).mode & 0o777).toBe(0o700);
    }
    expect(profile.secretRef).toBe(apiKeyRefOf('codex', 'key'));
    expect((await rig.vault.get(apiKeyRefOf('codex', 'key')))?.reveal()).toBe(KEY);
    expect(JSON.stringify(profile)).not.toContain(KEY);
  });

  it('refuses what is wrong before anything is made', async () => {
    const rig = await setup();
    await addSub(rig, 'claude-code', 'main');
    const bad = [
      { client: 'claude-code', name: 'x', kind: 'api' as const, provider: 'anthropic' },
      {
        client: 'claude-code',
        name: 'x',
        kind: 'api' as const,
        provider: 'anthropic',
        apiKey: new Secret('  '),
      },
      {
        client: 'claude-code',
        name: 'x',
        kind: 'token_plan' as const,
        provider: 'anthropic',
        apiKey: new Secret(KEY),
      },
      { client: 'claude-code', name: '../x', kind: 'token_plan' as const, provider: 'anthropic' },
      { client: 'Claude', name: 'x', kind: 'token_plan' as const, provider: 'anthropic' },
      { client: 'claude-code', name: 'x', kind: 'token_plan' as const, provider: 'bad provider' },
    ];
    for (const input of bad) await expect(rig.service.add(input)).rejects.toThrow(InvalidInput);
    await expect(
      rig.service.add({
        client: 'claude-code',
        name: 'main',
        kind: 'token_plan',
        provider: 'anthropic',
      }),
    ).rejects.toThrow(Conflict);
    expect(await rig.store.profiles.list()).toHaveLength(1);
    expect(await rig.vault.list()).toEqual([]);
  });

  it('undoes the directory and the key when a step fails', async () => {
    const rig = await setup();
    // The key is stored before the row: a store failure must take it back out.
    rig.fail.create = 1;
    await expect(addApi(rig, 'codex', 'key')).rejects.toThrow('disk full');
    expect(await rig.vault.list()).toEqual([]);
    expect(existsSync(join(rig.paths.profiles, 'codex', 'key'))).toBe(false);
    expect(await eventsOf(rig)).toEqual([]);
    // A retry works: nothing was left behind.
    await expect(addApi(rig, 'codex', 'key')).resolves.toMatchObject({ status: 'added' });
  });

  it('stops with VaultLocked when the vault is locked, and leaves nothing', async () => {
    const rig = await setup({ vault: new InMemorySecretVault({ locked: true }) });
    await expect(addApi(rig, 'codex', 'key')).rejects.toThrow(VaultLocked);
    expect(existsSync(join(rig.paths.profiles, 'codex', 'key'))).toBe(false);
    expect(await rig.store.profiles.list()).toEqual([]);
  });

  it('answers unknown when the client cannot tell the login state', async () => {
    const rig = await setup({ login: 'unknown' });
    expect((await addSub(rig, 'claude-code', 'main')).login).toBe('unknown');
  });
});

describe('the key reaches only its own profile (sweep)', () => {
  it('[proposta] is in the environment of the API profile, and in no other profile, file, event or log line', async () => {
    const rig = await setup();
    const sub = await addSub(rig, 'claude-code', 'main');
    const other = await addSub(rig, 'claude-code', 'second');
    const api = await addApi(rig, 'claude-code', 'api-key');
    const apiCodex = await rig.service.add({
      client: 'codex',
      name: 'other-key',
      kind: 'api',
      provider: 'openai',
      apiKey: new Secret('sk-test-OTHER-KEY'),
    });
    expect(apiCodex.status).toBe('added');

    const envOf = async (record: ProfileRecord, client: string) => {
      const adapter = rig.adapters.get(client);
      if (adapter === undefined) throw new Error('no adapter');
      return (await adapter.launchSpec(profileOf(record), policy, '/work')).env;
    };
    const apiEnv = await envOf(api.profile, 'claude-code');
    expect(apiEnv).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: KEY });
    for (const record of [sub.profile, other.profile]) {
      const env = await envOf(record, 'claude-code');
      expect(env).toEqual({ PATH: '/bin' });
      expect(JSON.stringify(env)).not.toContain(KEY);
    }
    // Another API profile gets its own key under its own variable, never this one.
    const codexEnv = await envOf(must(await rig.store.profiles.get('codex/other-key')), 'codex');
    expect(codexEnv).toEqual({ PATH: '/bin', OPENAI_API_KEY: 'sk-test-OTHER-KEY' });

    const text = JSON.stringify([
      await eventsOf(rig, ''),
      await rig.store.profiles.list(),
      rig.lines.map((line: LoggedLine) => line),
    ]);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('OTHER-KEY');
    for (const file of await filesUnder(rig.dataDir)) {
      expect(await readFile(file, 'utf8')).not.toContain(KEY);
    }
  });

  it('is not even in the log when the removal and the drain run', async () => {
    const rig = await setup();
    await addApi(rig, 'claude-code', 'api-key');
    await rig.service.drain('claude-code/api-key', { timeoutMs: 0 });
    await rig.service.remove('claude-code/api-key', { timeoutMs: 0 });
    expect(JSON.stringify(rig.lines)).not.toContain(KEY);
    expect(await rig.vault.list()).toEqual([]);
  });
});

describe('profileSecretEnv', () => {
  it('maps a provider to its variable: the config first, then the known ones, then a derived name', () => {
    expect(apiKeyEnvName('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(apiKeyEnvName('openai')).toBe('OPENAI_API_KEY');
    expect(apiKeyEnvName('minimax')).toBe('MINIMAX_API_KEY');
    expect(apiKeyEnvName('z.ai')).toBe('Z_AI_API_KEY');
    expect(apiKeyEnvName('minimax', { minimax: 'MY_KEY' })).toBe('MY_KEY');
    expect(apiKeyEnvName('constructor')).toBe('CONSTRUCTOR_API_KEY');
  });

  it('gives nothing for an unknown, a subscription or a removed profile', async () => {
    const rig = await setup();
    await addSub(rig, 'claude-code', 'main');
    await addApi(rig, 'codex', 'key', 'openai');
    const env = profileSecretEnv({ store: rig.store, vault: rig.vault });
    const names = (id: string) => ({
      client: must(id.split('/')[0]),
      profile: must(id.split('/')[1]),
      id,
      dir: '/x',
    });
    expect(await env(names('nobody/none'))).toEqual({});
    expect(await env(names('claude-code/main'))).toEqual({});
    expect(await env(names('codex/key'))).toEqual({ OPENAI_API_KEY: KEY });
    await rig.service.remove('codex/key', { timeoutMs: 0 });
    expect(await env(names('codex/key'))).toEqual({});
  });
});

describe('ProfileService.drain', () => {
  async function withSessions(rig: Rig, profileId: string, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = `s-${profileId.replace('/', '-')}-${String(i)}`;
      await rig.store.sessions.open({
        id,
        client: must(profileId.split('/')[0]),
        profile: profileId,
      });
      ids.push(id);
    }
    return ids;
  }

  it('[proposta] takes no new session once draining, and an idle profile drains at once', async () => {
    const rig = await setup();
    await addSub(rig, 'claude-code', 'main');
    expect(await rig.service.acceptsSessions('claude-code/main')).toBe(true);
    const result = await rig.service.drain('claude-code/main');
    expect(result).toMatchObject({ outcome: 'finished', sessions: 0 });
    expect(await rig.service.acceptsSessions('claude-code/main')).toBe(false);
    expect((await rig.store.profiles.get('claude-code/main'))?.state).toBe('draining');
    expect(await rig.service.acceptsSessions('nobody/none')).toBe(false);
    expect((await eventsOf(rig, 'profile.dr')).map((e) => e.type)).toEqual([
      'profile.draining',
      'profile.drained',
    ]);
  });

  it('waits for the running sessions to end by themselves', async () => {
    const rig = await setup();
    await addSub(rig, 'claude-code', 'main');
    const [session] = await withSessions(rig, 'claude-code/main', 1);
    const drained = rig.service.drain('claude-code/main');
    while (rig.clock.pendingSleeps === 0) await new Promise<void>((r) => setImmediate(r));
    await rig.clock.advance(3000);
    await rig.store.sessions.update(must(session), { state: 'closed' });
    expect(await settled(rig, drained)).toMatchObject({ outcome: 'finished', sessions: 0 });
    const [event] = await eventsOf(rig, 'profile.draining');
    expect(event?.payload).toMatchObject({ activeSessions: 1, onTimeout: 'handoff' });
  });

  it('[proposta] on_timeout handoff sends the sessions back to the queue', async () => {
    const rig = await setup({ timeoutMs: 5000, onTimeout: 'handoff' });
    await addSub(rig, 'claude-code', 'main');
    const ids = await withSessions(rig, 'claude-code/main', 2);
    const drained = rig.service.drain('claude-code/main');
    expect(await settled(rig, drained)).toMatchObject({ outcome: 'handoff', sessions: 2 });
    for (const id of ids) {
      expect((await rig.store.sessions.get(id))?.state).toBe('awaiting_resume');
    }
  });

  it('[proposta] on_timeout force closes them and wait leaves the profile draining', async () => {
    const force = await setup({ timeoutMs: 2000, onTimeout: 'force' });
    await addSub(force, 'claude-code', 'main');
    const [id] = await withSessions(force, 'claude-code/main', 1);
    const run = force.service.drain('claude-code/main');
    expect(await settled(force, run)).toMatchObject({ outcome: 'forced', sessions: 1 });
    expect((await force.store.sessions.get(must(id)))?.state).toBe('closed');

    const wait = await setup({ timeoutMs: 2000, onTimeout: 'wait' });
    await addSub(wait, 'claude-code', 'main');
    const [kept] = await withSessions(wait, 'claude-code/main', 1);
    const waiting = wait.service.drain('claude-code/main');
    expect(await settled(wait, waiting)).toMatchObject({ outcome: 'still_running', sessions: 0 });
    expect((await wait.store.sessions.get(must(kept)))?.state).toBe('active');
    expect((await wait.store.profiles.get('claude-code/main'))?.state).toBe('draining');
    // Calling it again waits again, without a second `profile.draining`.
    const again = wait.service.drain('claude-code/main');
    expect(await settled(wait, again)).toMatchObject({ outcome: 'still_running' });
    expect(await eventsOf(wait, 'profile.draining')).toHaveLength(1);
  });

  it('a timeout of 0 does not wait, and refuses an unknown or removed profile', async () => {
    const rig = await setup();
    await addSub(rig, 'claude-code', 'main');
    await withSessions(rig, 'claude-code/main', 1);
    expect(await rig.service.drain('claude-code/main', { timeoutMs: 0 })).toMatchObject({
      outcome: 'handoff',
      sessions: 1,
    });
    await expect(rig.service.drain('nobody/none')).rejects.toThrow(/does not exist/);
    await rig.service.remove('claude-code/main');
    await expect(rig.service.drain('claude-code/main')).rejects.toThrow(Conflict);
  });
});

describe('ProfileService.remove', () => {
  it('[proposta] logs out, deletes the directory and the key, and leaves the Executors invalid', async () => {
    const rig = await setup();
    const sub = await addSub(rig, 'claude-code', 'main');
    const api = await addApi(rig, 'codex', 'key');
    for (const profileId of ['claude-code/main', 'codex/key']) {
      await rig.store.executors.create({
        profileId,
        model: 'm',
        effort: 'high',
        provider: 'anthropic',
      });
      await rig.store.executors.create({
        profileId,
        model: 'm',
        effort: null,
        provider: 'anthropic',
      });
    }
    await writeFile(join(sub.profile.dir, 'client-state.json'), '{}');

    const result = await rig.service.remove('claude-code/main');
    expect(result).toMatchObject({ loggedOut: true, dir: 'deleted', secretDeleted: false });
    expect(result.executorsInvalidated).toEqual(['m-high@claude-code/main', 'm@claude-code/main']);
    expect(existsSync(sub.profile.dir)).toBe(false);
    expect(rig.loggedOut.get('claude-code/main')).toBe('out');
    expect(await rig.store.profiles.get('claude-code/main')).toMatchObject({
      state: 'removed',
      removedAt: T0,
    });
    const executors = await rig.store.executors.list({ profileId: 'claude-code/main' });
    expect(executors).toHaveLength(2);
    for (const executor of executors) {
      expect(executor).toMatchObject({ validity: 'invalid', invalidReason: 'profile_removed' });
    }
    // The other profile's Executors are untouched.
    for (const executor of await rig.store.executors.list({ profileId: 'codex/key' })) {
      expect(executor.validity).toBe('valid');
    }

    const removedApi = await rig.service.remove('codex/key');
    expect(removedApi).toMatchObject({ loggedOut: false, secretDeleted: true, dir: 'deleted' });
    expect(existsSync(api.profile.dir)).toBe(false);
    expect(await rig.vault.get(apiKeyRefOf('codex', 'key'))).toBeUndefined();
    expect(rig.loggedOut.has('codex/key')).toBe(false);
    expect((await eventsOf(rig, 'profile.removed')).map((e) => e.payload)).toMatchObject([
      { profileId: 'claude-code/main', executorsInvalidated: expect.any(Array) as string[] },
      { profileId: 'codex/key', secretDeleted: true },
    ]);
  });

  it('drains an active profile first and goes on after the handoff', async () => {
    const rig = await setup({ timeoutMs: 1000, onTimeout: 'handoff' });
    await addSub(rig, 'claude-code', 'main');
    await rig.store.sessions.open({ id: 's1', client: 'claude-code', profile: 'claude-code/main' });
    const removal = rig.service.remove('claude-code/main');
    const result = await settled(rig, removal);
    expect(result.drain).toMatchObject({ outcome: 'handoff', sessions: 1 });
    expect((await rig.store.sessions.get('s1'))?.state).toBe('awaiting_resume');
    expect(result.profile.state).toBe('removed');
  });

  it('refuses while sessions still run (on_timeout wait), and the profile stays draining', async () => {
    const rig = await setup({ timeoutMs: 1000, onTimeout: 'wait' });
    const { profile } = await addSub(rig, 'claude-code', 'main');
    await rig.store.sessions.open({ id: 's1', client: 'claude-code', profile: 'claude-code/main' });
    const removal = rig.service.remove('claude-code/main');
    await expect(settled(rig, removal)).rejects.toThrow(Conflict);
    expect((await rig.store.profiles.get('claude-code/main'))?.state).toBe('draining');
    expect(existsSync(profile.dir)).toBe(true);
    expect(rig.loggedOut.size).toBe(0);
  });

  it('[proposta] removed_dir keep_backup moves the directory aside instead of deleting it', async () => {
    const rig = await setup({ removedDir: 'keep_backup' });
    const { profile } = await addSub(rig, 'claude-code', 'main');
    await writeFile(join(profile.dir, 'note.txt'), 'kept');
    const result = await rig.service.remove('claude-code/main', { timeoutMs: 0 });
    expect(result.dir).toBe('backup');
    expect(existsSync(profile.dir)).toBe(false);
    const backup = join(rig.paths.profiles, '.removed', `claude-code-main-${String(T0)}`);
    expect(await readFile(join(backup, 'note.txt'), 'utf8')).toBe('kept');
  });

  it('does not log out a client that has no login, and a failed logout does not stop the removal', async () => {
    const out = await setup({ login: 'logged_out' });
    await addSub(out, 'claude-code', 'main');
    expect(await out.service.remove('claude-code/main', { timeoutMs: 0 })).toMatchObject({
      loggedOut: false,
      dir: 'deleted',
    });
    expect(out.loggedOut.size).toBe(0);

    const broken = await setup({ failLogout: true });
    await addSub(broken, 'claude-code', 'main');
    const result = await broken.service.remove('claude-code/main', { timeoutMs: 0 });
    expect(result).toMatchObject({ loggedOut: false, dir: 'deleted' });
    expect(broken.lines.some((l) => l.level === 'warn' && l.msg.includes('logout failed'))).toBe(
      true,
    );
    expect((await broken.store.profiles.get('claude-code/main'))?.state).toBe('removed');
  });

  it('finishes a removal that failed halfway, and refuses the same profile after it is done', async () => {
    const rig = await setup();
    await addSub(rig, 'claude-code', 'main');
    rig.fail.removed = 1;
    await expect(rig.service.remove('claude-code/main', { timeoutMs: 0 })).rejects.toThrow(
      'disk full',
    );
    // The directory is gone already, the profile is still draining: calling again finishes it.
    expect((await rig.store.profiles.get('claude-code/main'))?.state).toBe('draining');
    const result = await rig.service.remove('claude-code/main', { timeoutMs: 0 });
    expect(result).toMatchObject({ dir: 'missing' });
    expect((await rig.store.profiles.get('claude-code/main'))?.state).toBe('removed');
    await expect(rig.service.remove('claude-code/main')).rejects.toThrow(Conflict);
  });

  it('[proposta] never deletes outside <data>/profiles, whatever the row says', async () => {
    const rig = await setup();
    const { profile } = await addSub(rig, 'claude-code', 'main');
    const outside = join(rig.dataDir, 'precious');
    await mkdir(outside);
    await writeFile(join(outside, 'file.txt'), 'safe');

    // A row edited to point elsewhere is refused and nothing is removed.
    await rig.store.profiles.update('claude-code/main', { dir: outside });
    await expect(rig.service.remove('claude-code/main', { timeoutMs: 0 })).rejects.toThrow(
      InvalidInput,
    );
    expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('safe');
    expect(existsSync(profile.dir)).toBe(true);
    await rig.store.profiles.update('claude-code/main', { dir: profile.dir });
  });

  it('[proposta] unlinks a symlink where the directory was, and never follows it', async () => {
    if (process.platform === 'win32') return;
    const rig = await setup();
    const { profile } = await addSub(rig, 'claude-code', 'main');
    const outside = join(rig.dataDir, 'precious');
    await mkdir(outside);
    await writeFile(join(outside, 'file.txt'), 'safe');
    await rig.service.drain('claude-code/main', { timeoutMs: 0 });
    await import('node:fs/promises').then(async (fs) => {
      await fs.rm(profile.dir, { recursive: true });
      await symlink(outside, profile.dir);
    });
    const result = await rig.service.remove('claude-code/main', { timeoutMs: 0 });
    expect(result.dir).toBe('deleted');
    expect(existsSync(profile.dir)).toBe(false);
    expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('safe');
  });

  it('refuses a file in the place of the directory', async () => {
    const rig = await setup();
    const { profile } = await addSub(rig, 'claude-code', 'main');
    await rig.service.drain('claude-code/main', { timeoutMs: 0 });
    const fs = await import('node:fs/promises');
    await fs.rm(profile.dir, { recursive: true });
    await writeFile(profile.dir, 'not a directory');
    await expect(rig.service.remove('claude-code/main', { timeoutMs: 0 })).rejects.toThrow(
      Conflict,
    );
    expect(await readFile(profile.dir, 'utf8')).toBe('not a directory');
  });
});

describe('ProfileService.list', () => {
  it('lists the live profiles with the key flag and the Executors, and the login only when asked', async () => {
    const rig = await setup();
    await addSub(rig, 'claude-code', 'main');
    await addApi(rig, 'codex', 'key', 'openai');
    await rig.store.executors.create({
      profileId: 'claude-code/main',
      model: 'm',
      effort: null,
      provider: 'anthropic',
    });
    await addSub(rig, 'claude-code', 'gone', 'anthropic');
    await rig.service.remove('claude-code/gone', { timeoutMs: 0 });

    const plain = await rig.service.list();
    expect(plain.map((s) => s.profile.id)).toEqual(['claude-code/main', 'codex/key']);
    expect(plain[0]).toMatchObject({ hasSecret: false, executors: { valid: 1, invalid: 0 } });
    expect(plain[1]).toMatchObject({ hasSecret: true });
    expect('login' in must(plain[0])).toBe(false);

    const checked = await rig.service.list({ checkLogin: true });
    expect(checked.map((s) => s.login)).toEqual(['logged_in', null]);
    expect((await rig.service.list({ includeRemoved: true })).map((s) => s.profile.state)).toEqual([
      'removed',
      'active',
      'active',
    ]);
    expect((await rig.service.list({ client: 'codex' })).map((s) => s.profile.id)).toEqual([
      'codex/key',
    ]);
    expect(JSON.stringify(plain)).not.toContain(KEY);
  });
});

describe('profileSettingsOf', () => {
  it('reads the profiles.* block of the config', () => {
    expect(
      profileSettingsOf({
        profiles: {
          same_provider_notice: 'always',
          drain: { timeout: 90_000, on_timeout: 'force', removed_dir: 'keep_backup' },
          api_key_env: {},
        },
      }),
    ).toEqual({
      sameProviderNotice: 'always',
      drain: { timeoutMs: 90_000, onTimeout: 'force', removedDir: 'keep_backup' },
    });
  });
});
