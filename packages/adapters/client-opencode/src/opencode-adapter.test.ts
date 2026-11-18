// SPDX-License-Identifier: MPL-2.0
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  PermissionDenied,
  QuotaExhausted,
  ROLE_POLICY_FIELDS,
  type Profile,
  type RolePolicy,
} from '@otheater/core';
import { FakeProcessLauncher, FakeSessionTransport } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPENCODE_ADAPTER_BASE_VERSION,
  OPENCODE_PINNED_VERSION,
  OpenCodeAdapter,
  opencodeAdapterVersion,
  type OpenCodeAdapterOptions,
} from './opencode-adapter.js';
import { PERMISSION_PROBE_ID } from './permission-probe.js';
import { opencodePermission, serializePermission } from './permission.js';

const reader: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};
const writer: RolePolicy = { ...reader, nativeTools: ['read', 'search', 'edit'] };

const NO_OS = { fields: [] } as const;
const ALL_OS = { fields: ROLE_POLICY_FIELDS } as const;

/** Reaches the protected members the base calls, to test them without a session. */
class Exposed extends OpenCodeAdapter {
  prepare(profile: Profile, policy: RolePolicy): Promise<void> {
    return this.prepareProfile(profile, policy);
  }
  env(profile: Profile): Record<string, string> {
    return this.profileEnv(profile);
  }
}

describe('OpenCodeAdapter', () => {
  let root: string;
  let profile: Profile;
  let launcher: FakeProcessLauncher;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'otheater-opencode-adapter-'));
    profile = {
      client: 'opencode',
      profile: 'work',
      id: 'opencode/work',
      dir: join(root, 'work'),
    };
    launcher = new FakeProcessLauncher();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function make(extra: Partial<OpenCodeAdapterOptions> = {}): OpenCodeAdapter {
    return new OpenCodeAdapter({
      launcher,
      baseEnv: { PATH: '/usr/bin', FROM_BASE: 'base' },
      adapterVersion: opencodeAdapterVersion(),
      processModel: 'per_session',
      sandbox: ALL_OS,
      profileDir: (ref) => join(root, ref.profile),
      ...extra,
    });
  }

  function exposed(extra: Partial<OpenCodeAdapterOptions> = {}): Exposed {
    return new Exposed({
      launcher,
      baseEnv: {},
      adapterVersion: opencodeAdapterVersion(),
      processModel: 'per_session',
      sandbox: ALL_OS,
      ...extra,
    });
  }

  const permissionOf = (index: number): unknown => {
    const text = launcher.launched[index]?.options.env.OPENCODE_PERMISSION;
    return text === undefined ? undefined : JSON.parse(text);
  };

  describe('identity', () => {
    it('is the opencode client, with the quota probe and the catalog of its own', () => {
      const adapter = make();
      expect(adapter.id).toBe('opencode');
      expect(adapter.implements.port).toBe('ClientAdapter');
      expect(adapter.models.discovery).toBe('assisted');
      expect(adapter.quota.id).toBe('opencode-quota');
    });

    it('announces what Phase 0 measured: load, MCP over http, three config options, headless', () => {
      expect(make().capabilities).toEqual({
        loadSession: true,
        mcpHttp: true,
        configOptions: ['model', 'thought_level', 'mode'],
        headless: true,
        extensions: [],
        inputTypes: ['image'],
      });
    });

    it('has no extensions: the quota signal of the shells is not an OpenCode thing', () => {
      expect(make().capabilities.extensions).toEqual([]);
    });

    it('builds the version of the adapter from its own and the client one', () => {
      expect(OPENCODE_PINNED_VERSION).toBe('1.19.5');
      expect(opencodeAdapterVersion()).toBe(`${OPENCODE_ADAPTER_BASE_VERSION}+opencode.1.19.5`);
      expect(opencodeAdapterVersion('1.20.0')).toBe(
        `${OPENCODE_ADAPTER_BASE_VERSION}+opencode.1.20.0`,
      );
    });
  });

  describe('process model (pool.opencode.process_model)', () => {
    it('per_profile (the default) is multi-session, per_session is process-per-session', () => {
      const base = { launcher, baseEnv: {}, adapterVersion: '1' };
      expect(new OpenCodeAdapter(base).processModel).toBe('multi-session');
      expect(new OpenCodeAdapter({ ...base, processModel: 'per_profile' }).processModel).toBe(
        'multi-session',
      );
      expect(new OpenCodeAdapter({ ...base, processModel: 'per_session' }).processModel).toBe(
        'process-per-session',
      );
    });

    it('refuses a value it does not know', () => {
      expect(
        () =>
          new OpenCodeAdapter({
            launcher,
            baseEnv: {},
            adapterVersion: '1',
            processModel: 'shared' as never,
          }),
      ).toThrow(InvalidInput);
    });

    it('per_profile: sessions with the same policy share one process', async () => {
      const adapter = make({ processModel: 'per_profile' });
      const via = new FakeSessionTransport();
      const first = await adapter.openSession(profile, reader, '/work', via);
      const second = await adapter.openSession(profile, reader, '/work', via);
      expect(launcher.launched).toHaveLength(1);
      await first.close();
      expect(launcher.running).toHaveLength(1);
      await second.close();
      expect(launcher.running).toHaveLength(0);
    });

    it('per_profile: a session with another policy gets another process (the policy is in the environment)', async () => {
      const adapter = make({ processModel: 'per_profile' });
      const via = new FakeSessionTransport();
      const a = await adapter.openSession(profile, reader, '/work', via);
      const b = await adapter.openSession(profile, writer, '/work', via);
      const c = await adapter.openSession(profile, reader, '/work', via);
      expect(launcher.launched).toHaveLength(2);
      expect(permissionOf(0)).not.toEqual(permissionOf(1));
      await Promise.all([a.close(), b.close(), c.close()]);
      expect(launcher.running).toHaveLength(0);
    });

    it('per_session: every session has its own process', async () => {
      const adapter = make({ processModel: 'per_session' });
      const via = new FakeSessionTransport();
      const first = await adapter.openSession(profile, reader, '/work', via);
      const second = await adapter.openSession(profile, reader, '/work', via);
      expect(launcher.launched).toHaveLength(2);
      await Promise.all([first.close(), second.close()]);
    });
  });

  describe('launch', () => {
    it('starts `opencode acp` in the worktree', async () => {
      const via = new FakeSessionTransport();
      await (await make().openSession(profile, reader, '/work', via)).close();
      expect(launcher.launched[0]?.options).toMatchObject({
        cmd: 'opencode',
        args: ['acp'],
        cwd: '/work',
      });
    });

    it('takes another command, for an install outside PATH', async () => {
      const adapter = make({ command: { cmd: '/opt/oc/bin/opencode', args: ['acp', '--pure'] } });
      await (
        await adapter.openSession(profile, reader, '/work', new FakeSessionTransport())
      ).close();
      expect(launcher.launched[0]?.options).toMatchObject({
        cmd: '/opt/oc/bin/opencode',
        args: ['acp', '--pure'],
      });
    });

    it('puts the isolation, the pinned permission and the project-config switch in the environment', async () => {
      await (
        await make().openSession(profile, reader, '/work', new FakeSessionTransport())
      ).close();
      const env = launcher.launched[0]?.options.env;
      expect(env).toMatchObject({
        PATH: '/usr/bin',
        FROM_BASE: 'base',
        XDG_DATA_HOME: join(profile.dir, 'data'),
        XDG_CONFIG_HOME: join(profile.dir, 'config'),
        XDG_STATE_HOME: join(profile.dir, 'state'),
        OPENCODE_DB: join(profile.dir, 'db', 'opencode.db'),
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_PERMISSION: serializePermission(opencodePermission(reader)),
      });
      expect(env).not.toHaveProperty('XDG_CACHE_HOME');
    });

    it('the permission follows the role: a writer gets edit, a reader does not', async () => {
      const adapter = make();
      await (
        await adapter.openSession(profile, reader, '/work', new FakeSessionTransport())
      ).close();
      await (
        await adapter.openSession(profile, writer, '/work', new FakeSessionTransport())
      ).close();
      expect(permissionOf(0)).toMatchObject({ edit: 'deny', bash: 'deny' });
      expect(permissionOf(1)).toMatchObject({ edit: 'allow', bash: 'deny' });
    });

    it('the project config can be left on, and the homes to isolate are a setting', async () => {
      const adapter = make({ projectConfig: 'enabled', isolation: ['data', 'config'] });
      await (
        await adapter.openSession(profile, reader, '/work', new FakeSessionTransport())
      ).close();
      const env = launcher.launched[0]?.options.env;
      expect(env).not.toHaveProperty('OPENCODE_DISABLE_PROJECT_CONFIG');
      expect(env).not.toHaveProperty('XDG_STATE_HOME');
    });

    it('the shell keys are a setting', async () => {
      const adapter = make({ shellKeys: ['bash', 'shell'] });
      await (
        await adapter.openSession(profile, reader, '/work', new FakeSessionTransport())
      ).close();
      expect(permissionOf(0)).toMatchObject({ bash: 'deny', shell: 'deny' });
    });

    it('the environment of the profile wins over the base one', async () => {
      const adapter = make({ baseEnv: { OPENCODE_DB: '/elsewhere', PATH: '/usr/bin' } });
      await (
        await adapter.openSession(profile, reader, '/work', new FakeSessionTransport())
      ).close();
      expect(launcher.launched[0]?.options.env.OPENCODE_DB).toBe(
        join(profile.dir, 'db', 'opencode.db'),
      );
    });
  });

  describe('prepareProfile', () => {
    it('makes the profile directories and writes opencode.json in the config home', async () => {
      await (
        await make().openSession(profile, reader, '/work', new FakeSessionTransport())
      ).close();
      for (const dir of ['data', 'config', 'db']) await access(join(profile.dir, dir));
      const config = JSON.parse(
        await readFile(join(profile.dir, 'config', 'opencode', 'opencode.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(config).toMatchObject({ autoupdate: false, share: 'disabled' });
    });

    it('profileConfig null writes no opencode.json, an object writes that object', async () => {
      await (
        await make({ profileConfig: null }).openSession(
          profile,
          reader,
          '/work',
          new FakeSessionTransport(),
        )
      ).close();
      await expect(
        access(join(profile.dir, 'config', 'opencode', 'opencode.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const other = { ...profile, dir: join(root, 'other') };
      await (
        await make({ profileConfig: { theme: 'x' } }).openSession(
          other,
          reader,
          '/work',
          new FakeSessionTransport(),
        )
      ).close();
      expect(
        JSON.parse(await readFile(join(other.dir, 'config', 'opencode', 'opencode.json'), 'utf8')),
      ).toEqual({ theme: 'x' });
    });

    it('is the same profile again: the files are not rewritten differently', async () => {
      const adapter = make();
      await (
        await adapter.openSession(profile, reader, '/work', new FakeSessionTransport())
      ).close();
      const file = join(profile.dir, 'config', 'opencode', 'opencode.json');
      const first = await readFile(file, 'utf8');
      await (
        await adapter.openSession(profile, reader, '/work', new FakeSessionTransport())
      ).close();
      expect(await readFile(file, 'utf8')).toBe(first);
    });

    it('does not create the login file: the client owns it', async () => {
      await (
        await make().openSession(profile, reader, '/work', new FakeSessionTransport())
      ).close();
      const entries = await import('node:fs/promises').then((fs) =>
        fs.readdir(join(profile.dir, 'data')),
      );
      expect(entries).toEqual([]);
    });
  });

  describe('permission slot (profileEnv has no policy)', () => {
    it('two launches of one profile at once each get the permission of their own policy', async () => {
      const adapter = make();
      const [a, b, c] = await Promise.all([
        adapter.openSession(profile, reader, '/work', new FakeSessionTransport()),
        adapter.openSession(profile, writer, '/work', new FakeSessionTransport()),
        adapter.openSession(profile, reader, '/work', new FakeSessionTransport()),
      ]);
      expect(launcher.launched).toHaveLength(3);
      expect([0, 1, 2].map((i) => (permissionOf(i) as { edit: string }).edit)).toEqual([
        'deny',
        'allow',
        'deny',
      ]);
      await Promise.all([a.close(), b.close(), c.close()]);
    });

    it('profiles of different directories do not wait for each other', async () => {
      const adapter = make();
      const other: Profile = {
        ...profile,
        profile: 'home',
        id: 'opencode/home',
        dir: join(root, 'home'),
      };
      const sessions = await Promise.all([
        adapter.openSession(profile, reader, '/work', new FakeSessionTransport()),
        adapter.openSession(other, writer, '/work', new FakeSessionTransport()),
      ]);
      expect(launcher.launched).toHaveLength(2);
      await Promise.all(sessions.map((session) => session.close()));
    });

    it('a launch that fails frees the turn of the next one', async () => {
      const adapter = make();
      const via = new FakeSessionTransport();
      via.failWith = new AdapterUnavailable('no answer');
      await expect(adapter.openSession(profile, reader, '/work', via)).rejects.toBe(via.failWith);
      await (
        await adapter.openSession(profile, writer, '/work', new FakeSessionTransport())
      ).close();
      expect(permissionOf(1)).toMatchObject({ edit: 'allow' });
    });

    it('without a slot the environment denies everything (fail closed)', () => {
      const adapter = exposed();
      const env = adapter.env(profile);
      const permission = JSON.parse(env.OPENCODE_PERMISSION ?? 'null') as Record<string, string>;
      expect(permission).toMatchObject({ edit: 'deny', bash: 'deny', read: 'deny' });
      expect(permission['*']).toBe('ask');
    });

    it('the slot is used once: the next call without prepareProfile is closed again', async () => {
      const adapter = exposed();
      await adapter.prepare(profile, writer);
      expect(JSON.parse(adapter.env(profile).OPENCODE_PERMISSION ?? 'null')).toMatchObject({
        edit: 'allow',
      });
      expect(JSON.parse(adapter.env(profile).OPENCODE_PERMISSION ?? 'null')).toMatchObject({
        edit: 'deny',
      });
    });

    it('a slot nobody takes is dropped after slotTimeoutMs, so the next launch is not stuck', async () => {
      const adapter = exposed({ slotTimeoutMs: 20 });
      await adapter.prepare(profile, writer);
      const second = adapter.prepare(profile, reader);
      await expect(second).resolves.toBeUndefined();
      expect(JSON.parse(adapter.env(profile).OPENCODE_PERMISSION ?? 'null')).toMatchObject({
        edit: 'deny',
      });
    });
  });

  describe('sessionSetup', () => {
    it('over ACP there is nothing to select by default: the pinned permission is the mechanism', async () => {
      const via = new FakeSessionTransport();
      await (await make().openSession(profile, reader, '/work', via)).close();
      expect(via.opened[0]?.setup).toEqual({ via: 'acp', configOptions: {} });
    });

    it('readOnlyMode plan selects the plan mode for a role that cannot edit, and only for it', async () => {
      const adapter = make({ readOnlyMode: 'plan' });
      const readOnly = new FakeSessionTransport();
      await (await adapter.openSession(profile, reader, '/work', readOnly)).close();
      expect(readOnly.opened[0]?.setup).toEqual({ via: 'acp', configOptions: { mode: 'plan' } });
      const editing = new FakeSessionTransport();
      await (await adapter.openSession(profile, writer, '/work', editing)).close();
      expect(editing.opened[0]?.setup).toEqual({ via: 'acp', configOptions: {} });
    });

    it('headless runs `opencode run --format json` and never `--auto`', async () => {
      const via = new FakeSessionTransport({ id: 'headless' });
      await (await make().openSession(profile, reader, '/work', via)).close();
      const setup = via.opened[0]?.setup;
      expect(setup).toEqual({ via: 'headless', args: ['run', '--format', 'json'], env: {} });
      expect(JSON.stringify(setup)).not.toContain('--auto');
    });
  });

  describe('guarantee (enforcement)', () => {
    it('over ACP: the client enforces tools, shell and writes; onAsk and bypass also the daemon', () => {
      const report = make().guarantee(reader, NO_OS);
      expect(report.fields.nativeTools.layers).toEqual(['client']);
      expect(report.fields.nativeShell.layers).toEqual(['client']);
      expect(report.fields.writeScope.layers).toEqual(['client']);
      expect(report.fields.onAsk.layers).toEqual(['client', 'daemon']);
      expect(report.fields.bypass.layers).toEqual(['client', 'daemon']);
      expect(report.fields.mcpServers.layers).toEqual(['client']);
    });

    it('the network has no layer of the client: it is short until a sandbox gives it', () => {
      const adapter = make();
      expect(adapter.guarantee(reader, NO_OS).short).toEqual(['network']);
      expect(adapter.guarantee(reader, { fields: ['network'] }).ok).toBe(true);
    });

    it("with the project config on, or the config home shared, the MCP servers are not the client's to enforce", () => {
      expect(
        make({ projectConfig: 'enabled' }).guarantee(reader, NO_OS).fields.mcpServers.layers,
      ).toEqual([]);
      expect(
        make({ isolation: ['data'] }).guarantee(reader, NO_OS).fields.mcpServers.layers,
      ).toEqual([]);
    });

    it('headless has nobody to answer a request: onAsk is short, bypass is the client alone', () => {
      const report = make().guarantee(reader, NO_OS, 'headless');
      expect(report.fields.onAsk.layers).toEqual([]);
      expect(report.fields.bypass.layers).toEqual(['client']);
      expect(report.short).toContain('onAsk');
    });

    it('refuses to open a session short of layers (the default `refuse`), launching nothing', async () => {
      const adapter = make({ sandbox: NO_OS });
      await expect(
        adapter.openSession(profile, reader, '/work', new FakeSessionTransport()),
      ).rejects.toBeInstanceOf(PermissionDenied);
      expect(launcher.launched).toHaveLength(0);
    });
  });

  describe('translation', () => {
    it('mapConfig: model first, then the effort and the mode with the option ids of Phase 0', () => {
      const adapter = make();
      expect(adapter.configOptionsFor({ model: 'a/b' })).toEqual({ model: 'a/b' });
      const full = adapter.configOptionsFor({ model: 'a/b', effort: 'high', mode: 'plan' });
      expect(full).toEqual({ model: 'a/b', effort: 'high', mode: 'plan' });
      expect(Object.keys(full)[0]).toBe('model');
    });

    it('updates reach the listener normalized, and a quota failure is a QuotaExhausted', async () => {
      const via = new FakeSessionTransport();
      const session = await make().openSession(profile, reader, '/work', via);
      const kinds: string[] = [];
      session.onUpdate((update) => kinds.push(update.kind));
      await session.prompt([{ type: 'text', text: '#script:tool-call\n' }]);
      expect(kinds).toEqual(['tool_call', 'tool_call_update']);
      await expect(
        session.prompt([{ type: 'text', text: '#script:quota-signal\n' }]),
      ).rejects.toBeInstanceOf(QuotaExhausted);
      await session.close();
    });
  });

  describe('Phase 5 and the probes', () => {
    it('the quota probe has no reading without a configured ledger', async () => {
      const adapter = make();
      await expect(adapter.quota.read(profile)).rejects.toThrow(/no usage ledger configured/);
      await expect(adapter.quota.read(profile)).rejects.toBeInstanceOf(AdapterUnavailable);
    });

    it('conformance fails closed when no permission probe was configured', async () => {
      const report = await make().checkConformance(profile);
      expect(report.ok).toBe(false);
      expect(report.probes).toEqual([
        expect.objectContaining({ id: PERMISSION_PROBE_ID, ok: false }),
      ]);
      expect(report.adapterVersion).toBe(opencodeAdapterVersion());
    });

    it('conformance runs the permission probe when it was configured', async () => {
      const adapter = make({
        permissionProbe: { via: new FakeSessionTransport(), scratchRoot: root, timeoutMs: 5_000 },
      });
      const report = await adapter.checkConformance(profile);
      expect(report.probes).toEqual([
        expect.objectContaining({ id: PERMISSION_PROBE_ID, ok: true }),
      ]);
      expect(report.ok).toBe(true);
    });
  });
});
