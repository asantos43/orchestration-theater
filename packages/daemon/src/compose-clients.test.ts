// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ClientAdapter, type Profile } from '@otheater/core';
import { FakeClock, FakeProcessLauncher, FakeSessionTransport } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { fixtureAdapter, startFakeRegistry } from './adapters/adapter-fixture.js';
import { pathFinder, type ClientFactoryParts, type FindExecutable } from './clients.js';
import { DEFAULT_CLIENT_EXECUTABLES, productionClients } from './compose.js';
import { parseConfig } from './config.js';
import { dataPaths } from './paths.js';
import {
  captureLogger,
  makeTempDataDir,
  RecordingSituations,
  TEST_POLICY,
} from './test-helpers.js';

const ALL_FOUND: FindExecutable = (command) => `/bin/${command}`;
const NOTHING: FindExecutable = () => undefined;
/** No test reaches the real npm registry: the managed adapters' download fails offline. */
const OFFLINE = { fetch: () => Promise.reject(new Error('offline')) };
/** Not a real environment: what the daemon would hand to the clients. */
const ENV = { PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'sk-not-real', CUSTOM: 'x' };
/** The architecture's default refuses a policy the clients cannot guarantee (no sandbox yet); the tests look at what is built. */
const OPEN = 'security:\n  unenforced: allow\n';

async function setup(): Promise<{
  parts: ClientFactoryParts;
  launcher: FakeProcessLauncher;
  transport: FakeSessionTransport;
  lines: ReturnType<typeof captureLogger>['lines'];
  dir: string;
  profile: (client: string) => Profile;
  dispose: () => Promise<void>;
}> {
  const tmp = await makeTempDataDir();
  const launcher = new FakeProcessLauncher();
  const transport = new FakeSessionTransport();
  const { logger, lines } = captureLogger();
  const paths = dataPaths(tmp.dir);
  return {
    parts: { launcher, clock: new FakeClock(), transport, paths, logger },
    launcher,
    transport,
    lines,
    dir: tmp.dir,
    profile: (client) => ({
      client,
      profile: 'work',
      id: `${client}/work`,
      dir: join(paths.profiles, client, 'work'),
    }),
    dispose: tmp.dispose,
  };
}

function byId(adapters: readonly ClientAdapter[], id: string): ClientAdapter {
  const found = adapters.find((adapter) => adapter.id === id);
  if (found === undefined)
    throw new Error(`no ${id} adapter in ${adapters.map((a) => a.id).join()}`);
  return found;
}

describe('productionClients', () => {
  it('builds the three adapters when the three executables are found, in a fixed order', async () => {
    const t = await setup();
    try {
      const adapters = productionClients(parseConfig(''), {
        env: ENV,
        findExecutable: ALL_FOUND,
        adapters: OFFLINE,
      })(t.parts);
      expect(adapters.map((a) => a.id)).toEqual(['claude-code', 'codex', 'opencode']);
      expect(byId(adapters, 'claude-code').processModel).toBe('process-per-session');
      expect(byId(adapters, 'codex').processModel).toBe('multi-session');
      expect(byId(adapters, 'opencode').processModel).toBe('multi-session');
      expect(t.launcher.launched).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it('leaves out a client that is disabled or not found, and logs why', async () => {
    const t = await setup();
    try {
      const find: FindExecutable = (command) =>
        command === 'codex-acp' ? '/bin/codex-acp' : undefined;
      const config = parseConfig('clients:\n  opencode:\n    enabled: false\n');
      const adapters = productionClients(config, {
        env: ENV,
        findExecutable: find,
        adapters: OFFLINE,
      })(t.parts);
      expect(adapters.map((a) => a.id)).toEqual(['codex']);
      const reasons: Record<string, unknown> = Object.fromEntries(
        t.lines
          .filter((l) => l.msg === 'client')
          .map((l): [string, unknown] => [String(l.fields.client), l.fields.reason]),
      );
      expect(reasons).toEqual({
        'claude-code': 'not_found',
        codex: 'found_in_path',
        opencode: 'disabled',
      });
    } finally {
      await t.dispose();
    }
  });

  it('returns nothing when no client is configured or found', async () => {
    const t = await setup();
    try {
      expect(
        productionClients(parseConfig(''), {
          env: ENV,
          findExecutable: NOTHING,
          adapters: OFFLINE,
        })(t.parts),
      ).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it('turns a client on by its command alone, and warns when enabled: true finds nothing', async () => {
    const t = await setup();
    try {
      const config = parseConfig(
        'clients:\n  codex:\n    command: { cmd: /opt/codex-acp }\n  opencode:\n    enabled: true\n',
      );
      const adapters = productionClients(config, {
        env: ENV,
        findExecutable: NOTHING,
        adapters: OFFLINE,
      })(t.parts);
      expect(adapters.map((a) => a.id)).toEqual(['codex', 'opencode']);
      expect(t.lines.some((l) => l.level === 'warn' && l.fields.client === 'opencode')).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it('daemon.notice client_not_found: enabled: true with no executable is also an event (P24, N146)', async () => {
    const t = await setup();
    try {
      const situations = new RecordingSituations();
      const config = parseConfig('clients:\n  opencode:\n    enabled: true\n');
      productionClients(config, { env: ENV, findExecutable: NOTHING, adapters: OFFLINE })({
        ...t.parts,
        situations,
      });
      expect(situations.of('daemon.notice')).toEqual([
        { kind: 'client_not_found', subject: 'opencode', detail: expect.any(String) as string },
      ]);
    } finally {
      await t.dispose();
    }
  });

  it('searches the PATH of the injected environment when no search is injected', async () => {
    const t = await setup();
    try {
      const adapters = productionClients(parseConfig(''), { env: { PATH: '/nonexistent-dir' } })(
        t.parts,
      );
      expect(adapters).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it('searches for the executable each adapter starts by default', () => {
    expect(DEFAULT_CLIENT_EXECUTABLES).toEqual({
      'claude-code': 'claude-agent-acp',
      codex: 'codex-acp',
      opencode: 'opencode',
    });
  });

  it('starts Claude Code with its command, its profile and no account variable of the daemon', async () => {
    const t = await setup();
    try {
      const all = parseConfig(`${OPEN}clients:\n  claude-code:\n    env_inherit: all\n`);
      const claude = byId(
        productionClients(all, { env: ENV, findExecutable: ALL_FOUND, adapters: OFFLINE })(t.parts),
        'claude-code',
      );
      const spec = await claude.launchSpec(t.profile('claude-code'), TEST_POLICY, t.dir);
      expect(spec.cmd).toBe('claude-agent-acp');
      expect(spec.env.CLAUDE_CONFIG_DIR).toBe(t.profile('claude-code').dir);
      expect(spec.env.CUSTOM).toBe('x');
      expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();

      const keep = parseConfig(
        `${OPEN}clients:\n  claude-code:\n    env_inherit: all\n    account_env: keep\n    command: { cmd: node, args: [acp.js] }\n`,
      );
      const kept = byId(
        productionClients(keep, { env: ENV, findExecutable: ALL_FOUND, adapters: OFFLINE })(
          t.parts,
        ),
        'claude-code',
      );
      const keptSpec = await kept.launchSpec(t.profile('claude-code'), TEST_POLICY, t.dir);
      expect(keptSpec).toMatchObject({ cmd: 'node', args: ['acp.js'] });
      expect(keptSpec.env.ANTHROPIC_API_KEY).toBe('sk-not-real');
    } finally {
      await t.dispose();
    }
  });

  it('starts Codex with its command, CODEX_HOME and the minimal environment', async () => {
    const t = await setup();
    try {
      const config = parseConfig(
        `${OPEN}clients:\n  codex:\n    command: { cmd: /opt/codex-acp }\n    env_allow: [CUSTOM]\n    env: { RUST_LOG: warn }\n`,
      );
      const codex = byId(
        productionClients(config, { env: ENV, findExecutable: NOTHING, adapters: OFFLINE })(
          t.parts,
        ),
        'codex',
      );
      const spec = await codex.launchSpec(t.profile('codex'), TEST_POLICY, t.dir);
      expect(spec).toMatchObject({ cmd: '/opt/codex-acp', args: [] });
      expect(spec.env).toMatchObject({
        CODEX_HOME: t.profile('codex').dir,
        PATH: '/usr/bin',
        CUSTOM: 'x',
        RUST_LOG: 'warn',
      });
      // `minimal` never carries a key of the daemon's environment.
      expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      await t.dispose();
    }
  });

  it('follows clients.codex.process_model', async () => {
    const t = await setup();
    try {
      const config = parseConfig('clients:\n  codex:\n    process_model: process-per-session\n');
      const codex = byId(
        productionClients(config, { env: ENV, findExecutable: ALL_FOUND, adapters: OFFLINE })(
          t.parts,
        ),
        'codex',
      );
      expect(codex.processModel).toBe('process-per-session');
    } finally {
      await t.dispose();
    }
  });

  it('starts the Codex quota probe as `codex app-server` in the profile directory, ended after the timeout', async () => {
    const t = await setup();
    try {
      const config = parseConfig('clients:\n  codex:\n    quota: { timeout: 80ms }\n');
      const codex = byId(
        productionClients(config, { env: ENV, findExecutable: ALL_FOUND, adapters: OFFLINE })(
          t.parts,
        ),
        'codex',
      );
      expect(codex.quota.capabilities()).toEqual({
        windows: [],
        delivery: 'poll',
        precision: 'approximate',
      });

      await expect(codex.quota.read({ client: 'codex', profile: 'work' })).rejects.toThrow(
        /did not answer in 80 ms/u,
      );

      const [process] = t.launcher.launched;
      expect(process?.options).toMatchObject({ cmd: 'codex', args: ['app-server'] });
      expect(process?.options.cwd).toBe(t.profile('codex').dir);
      expect(process?.options.env.CODEX_HOME).toBe(t.profile('codex').dir);
      expect(process?.alive).toBe(false);
    } finally {
      await t.dispose();
    }
  });

  it('follows clients.codex.quota: command, watch and windows', async () => {
    const t = await setup();
    try {
      const config = parseConfig(
        [
          'clients:',
          '  codex:',
          '    quota:',
          '      command: { cmd: /opt/codex, args: [app-server, --listen, stdio] }',
          '      timeout: 40ms',
          '      watch: resident',
          '      windows: [5h, 7d]',
        ].join('\n'),
      );
      const codex = byId(
        productionClients(config, { env: ENV, findExecutable: ALL_FOUND, adapters: OFFLINE })(
          t.parts,
        ),
        'codex',
      );
      expect(codex.quota.capabilities()).toEqual({
        windows: ['5h', '7d'],
        delivery: 'both',
        precision: 'approximate',
      });

      await expect(codex.quota.read({ client: 'codex', profile: 'work' })).rejects.toThrow();

      expect(t.launcher.launched[0]?.options).toMatchObject({
        cmd: '/opt/codex',
        args: ['app-server', '--listen', 'stdio'],
      });
    } finally {
      await t.dispose();
    }
  });

  it('starts OpenCode with `opencode acp`, the isolated homes of its profile and project config off', async () => {
    const t = await setup();
    try {
      const opencode = byId(
        productionClients(parseConfig(OPEN), {
          env: ENV,
          findExecutable: ALL_FOUND,
          adapters: OFFLINE,
        })(t.parts),
        'opencode',
      );
      const profile = t.profile('opencode');
      const spec = await opencode.launchSpec(profile, TEST_POLICY, t.dir);
      expect(spec).toMatchObject({ cmd: 'opencode', args: ['acp'] });
      expect(spec.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
      expect(spec.env.OPENCODE_PERMISSION).toBeTypeOf('string');
      expect(spec.env.XDG_DATA_HOME?.startsWith(profile.dir)).toBe(true);
      expect(spec.env.XDG_STATE_HOME?.startsWith(profile.dir)).toBe(true);
      expect(spec.env.XDG_CACHE_HOME).toBeUndefined();

      const wide = parseConfig(
        `${OPEN}clients:\n  opencode:\n    isolation: [data, config, state, cache]\n    project_config: enabled\n    command: { cmd: /opt/opencode }\n`,
      );
      const other = byId(
        productionClients(wide, { env: ENV, findExecutable: NOTHING, adapters: OFFLINE })(t.parts),
        'opencode',
      );
      const wideSpec = await other.launchSpec(t.profile('opencode'), TEST_POLICY, t.dir);
      expect(wideSpec).toMatchObject({ cmd: '/opt/opencode', args: ['acp'] });
      expect(wideSpec.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
      expect(wideSpec.env.XDG_CACHE_HOME?.startsWith(profile.dir)).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it('passes pool.opencode.process_model to OpenCode (N56)', async () => {
    const t = await setup();
    try {
      const model = (text: string): string =>
        byId(
          productionClients(parseConfig(text), {
            env: ENV,
            findExecutable: ALL_FOUND,
            adapters: OFFLINE,
          })(t.parts),
          'opencode',
        ).processModel;
      expect(model('')).toBe('multi-session');
      expect(model('pool:\n  opencode:\n    process_model: per_profile\n')).toBe('multi-session');
      expect(model('pool:\n  opencode:\n    process_model: per_session\n')).toBe(
        'process-per-session',
      );
    } finally {
      await t.dispose();
    }
  });

  it('gives the OpenCode catalog the profile directory under <data>/profiles', async () => {
    const t = await setup();
    try {
      const opencode = byId(
        productionClients(parseConfig(''), {
          env: ENV,
          findExecutable: ALL_FOUND,
          adapters: OFFLINE,
        })(t.parts),
        'opencode',
      );
      await mkdir(dataPaths(t.dir).profiles, { recursive: true });
      const listing = opencode.models.list({ client: 'opencode', profile: 'work' }).catch(() => []);
      await until(() => t.launcher.launched.length > 0);
      const launched = t.launcher.launched[0];
      expect(launched?.options.cmd).toBe('opencode');
      expect(launched?.options.env.XDG_DATA_HOME?.startsWith(t.profile('opencode').dir)).toBe(true);
      launched?.exit(0);
      await listing;
    } finally {
      await t.dispose();
    }
  });

  it('refuses a profile name that would leave the profiles directory', async () => {
    const t = await setup();
    try {
      const opencode = byId(
        productionClients(parseConfig(''), {
          env: ENV,
          findExecutable: ALL_FOUND,
          adapters: OFFLINE,
        })(t.parts),
        'opencode',
      );
      await expect(opencode.models.list({ client: 'opencode', profile: '../x' })).rejects.toThrow(
        /profile/,
      );
      expect(t.launcher.launched).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it('applies security.* to every adapter: a field short of layers is refused by default', async () => {
    const t = await setup();
    try {
      const adapters = productionClients(parseConfig(''), {
        env: ENV,
        findExecutable: ALL_FOUND,
        adapters: OFFLINE,
      })(t.parts);
      for (const adapter of adapters) {
        await expect(adapter.launchSpec(t.profile(adapter.id), TEST_POLICY, t.dir)).rejects.toThrow(
          /writeScope|network/,
        );
      }
      const lax = productionClients(parseConfig('security:\n  unenforced: warn\n'), {
        env: ENV,
        findExecutable: ALL_FOUND,
        adapters: OFFLINE,
      })(t.parts);
      for (const adapter of lax) {
        await adapter.launchSpec(t.profile(adapter.id), TEST_POLICY, t.dir);
      }
      expect(t.lines.filter((l) => l.msg === 'client adapter warning')).not.toHaveLength(0);
    } finally {
      await t.dispose();
    }
  });
});

describe('the default catalog readers', () => {
  const MODELS = ['fake-model', 'fake-model-2'];
  const open = (extra = '') => parseConfig(`${OPEN}${extra}`);

  it('with security.unenforced: refuse and catalog_probe: refuse the session is not opened', async () => {
    // A session without a prompt goes through the guarantee check of `openSession` like any other,
    // and the policy of a reader is short of layers while there is no sandbox (architecture 5.8).
    const t = await setup();
    try {
      const adapters = productionClients(parseConfig('security:\n  catalog_probe: refuse\n'), {
        env: ENV,
        findExecutable: ALL_FOUND,
        adapters: OFFLINE,
      })(t.parts);
      const claude = byId(adapters, 'claude-code');
      const models = await claude.models.list({ client: 'claude-code', profile: 'work' });
      expect(models.map((m) => m.id)).toContain('sonnet');
      await expect(
        byId(adapters, 'codex').models.list({ client: 'codex', profile: 'work' }),
      ).rejects.toThrow(/security\.unenforced is refuse/);
      expect(t.transport.opened).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it('with the default catalog_probe: allow, the catalogs read the fake options although unenforced is refuse', async () => {
    const t = await setup();
    try {
      const adapters = productionClients(parseConfig(''), {
        env: ENV,
        findExecutable: ALL_FOUND,
        adapters: OFFLINE,
      })(t.parts);
      // The same adapters still refuse a work session.
      await expect(
        byId(adapters, 'codex').launchSpec(t.profile('codex'), TEST_POLICY, t.dir),
      ).rejects.toThrow(/security\.unenforced is refuse/);
      const claude = await byId(adapters, 'claude-code').models.list({
        client: 'claude-code',
        profile: 'work',
      });
      const codex = await byId(adapters, 'codex').models.list({ client: 'codex', profile: 'work' });
      expect(claude.map((m) => m.id)).toEqual(MODELS);
      expect(codex.map((m) => m.id)).toEqual(MODELS);
      expect(t.transport.opened).toHaveLength(2);
      // The daemon hears of each exemption, and nothing is left running.
      const warned = t.lines.filter(
        (l) => (l.fields.warning as { kind?: string } | undefined)?.kind === 'catalog_probe_exempt',
      );
      expect(warned).toHaveLength(2);
      expect(t.launcher.launched.every((p) => !p.alive)).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it.each([
    ['once', 2],
    ['every', 4],
    ['off', 0],
  ] as const)(
    'with catalog_probe_log: %s two clients read the catalog twice each and the log gets %i warnings',
    async (mode, expected) => {
      const t = await setup();
      try {
        const adapters = productionClients(
          parseConfig(`security:\n  catalog_probe_log: ${mode}\n`),
          { env: ENV, findExecutable: ALL_FOUND, adapters: OFFLINE },
        )(t.parts);
        for (const id of ['claude-code', 'codex']) {
          const adapter = byId(adapters, id);
          for (let i = 0; i < 2; i += 1) {
            const session = await adapter.openSession(
              t.profile(id),
              TEST_POLICY,
              t.dir,
              t.transport,
              { purpose: 'catalog-probe' },
            );
            await session.close();
          }
        }
        const warned = t.lines.filter(
          (l) =>
            (l.fields.warning as { kind?: string } | undefined)?.kind === 'catalog_probe_exempt',
        );
        expect(warned).toHaveLength(expected);
        expect(t.transport.opened).toHaveLength(4);
      } finally {
        await t.dispose();
      }
    },
  );

  it('lists the Claude models from a session opened without a prompt, read-only, in <data>/catalog-probe', async () => {
    const t = await setup();
    try {
      const claude = byId(
        productionClients(open(), { env: ENV, findExecutable: ALL_FOUND, adapters: OFFLINE })(
          t.parts,
        ),
        'claude-code',
      );
      const models = await claude.models.list({ client: 'claude-code', profile: 'work' });
      expect(models.map((m) => m.id)).toEqual(MODELS);
      expect(models[0]?.efforts).toEqual(['low', 'medium', 'high']);
      expect(t.transport.opened).toHaveLength(1);
      const [opened] = t.transport.opened;
      expect(opened?.cwd).toBe(join(dataPaths(t.dir).dataDir, 'catalog-probe'));
      // Nothing was asked of the client and nothing is left running.
      expect(t.transport.configApplied).toEqual([]);
      expect(t.launcher.launched.every((p) => !p.alive)).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it('lists the Codex models and efforts the same way', async () => {
    const t = await setup();
    try {
      const codexAdapter = byId(
        productionClients(open(), { env: ENV, findExecutable: ALL_FOUND, adapters: OFFLINE })(
          t.parts,
        ),
        'codex',
      );
      const models = await codexAdapter.models.list({ client: 'codex', profile: 'work' });
      expect(models.map((m) => m.id)).toEqual(MODELS);
      expect(t.transport.opened).toHaveLength(1);
    } finally {
      await t.dispose();
    }
  });

  it('keeps Claude on the reserve list with clients.claude-code.model_catalog: reserve, opening nothing', async () => {
    const t = await setup();
    try {
      const claude = byId(
        productionClients(open('clients:\n  claude-code:\n    model_catalog: reserve\n'), {
          env: ENV,
          findExecutable: ALL_FOUND,
          adapters: OFFLINE,
        })(t.parts),
        'claude-code',
      );
      const models = await claude.models.list({ client: 'claude-code', profile: 'work' });
      expect(models.map((m) => m.id)).toContain('sonnet');
      expect(t.transport.opened).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it('turns the Codex reader off with clients.codex.model_catalog: none', async () => {
    const t = await setup();
    try {
      const codexAdapter = byId(
        productionClients(open('clients:\n  codex:\n    model_catalog: none\n'), {
          env: ENV,
          findExecutable: ALL_FOUND,
          adapters: OFFLINE,
        })(t.parts),
        'codex',
      );
      await expect(
        codexAdapter.models.list({ client: 'codex', profile: 'work' }),
      ).rejects.toThrow();
      expect(t.transport.opened).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it('prefers a reader the caller injected', async () => {
    const t = await setup();
    try {
      const claude = byId(
        productionClients(open(), {
          env: ENV,
          findExecutable: ALL_FOUND,
          adapters: OFFLINE,
          claudeConfigOptions: () =>
            Promise.resolve([
              { id: 'model', type: 'select', options: [{ value: 'injected', name: 'Injected' }] },
            ]),
        })(t.parts),
        'claude-code',
      );
      const models = await claude.models.list({ client: 'claude-code', profile: 'work' });
      expect(models.map((m) => m.id)).toEqual(['injected']);
      expect(t.transport.opened).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it('refuses a profile name that would leave the profiles directory, opening nothing', async () => {
    const t = await setup();
    try {
      const claude = byId(
        productionClients(open(), { env: ENV, findExecutable: ALL_FOUND, adapters: OFFLINE })(
          t.parts,
        ),
        'claude-code',
      );
      // `session_or_reserve` falls back to the reserve; the catalog of Codex has none and rejects.
      const codexAdapter = byId(
        productionClients(open(), { env: ENV, findExecutable: ALL_FOUND, adapters: OFFLINE })(
          t.parts,
        ),
        'codex',
      );
      await expect(codexAdapter.models.list({ client: 'codex', profile: '../x' })).rejects.toThrow(
        /profile/,
      );
      await claude.models.list({ client: 'claude-code', profile: '../x' });
      expect(t.transport.opened).toEqual([]);
    } finally {
      await t.dispose();
    }
  });
});

describe('the veto of modes of the production clients', () => {
  it('refuses the bypass modes of Claude Code and Codex on the session, and lets the rest through', async () => {
    const t = await setup();
    try {
      const adapters = productionClients(parseConfig(OPEN), {
        env: ENV,
        findExecutable: ALL_FOUND,
        adapters: OFFLINE,
      })(t.parts);
      const vetoed: Record<string, string[]> = {
        'claude-code': ['bypassPermissions', 'dontAsk', 'auto'],
        codex: ['agent', 'agent-full-access'],
        opencode: [],
      };
      const allowed: Record<string, string> = {
        'claude-code': 'plan',
        codex: 'read-only',
        opencode: 'plan',
      };
      for (const [id, modes] of Object.entries(vetoed)) {
        const adapter = byId(adapters, id);
        const session = await adapter.openSession(t.profile(id), TEST_POLICY, t.dir, t.transport);
        for (const mode of modes) {
          await expect(session.setConfig('mode', mode)).rejects.toMatchObject({
            code: 'PERMISSION_DENIED',
          });
          expect(() => adapter.configOptionsFor({ model: 'm', mode })).toThrow(/is refused/);
        }
        await session.close();
        expect(adapter.configOptionsFor({ model: 'm', mode: allowed[id] ?? '' }).mode).toBe(
          allowed[id],
        );
      }
      const applied = t.transport.configApplied.map((entry) => entry.value);
      for (const mode of Object.values(vetoed).flat()) expect(applied).not.toContain(mode);
    } finally {
      await t.dispose();
    }
  });
});

describe('clients.codex.inner_sandbox (N129)', () => {
  /** Layer 3 as the daemon hands it to the factory: capabilities and a wrapper that confines nothing. */
  const layer3: NonNullable<ClientFactoryParts['sandbox']> = {
    capabilities: { fields: ['nativeTools', 'nativeShell', 'writeScope', 'network'] },
    launchWrapper: ({ spec }) => Promise.resolve(spec),
  };

  async function pinned(
    yaml: string,
    withLayer3: boolean,
  ): Promise<{ mode: string | undefined; sandboxMode: string }> {
    const t = await setup();
    try {
      const config = parseConfig(`${OPEN}${yaml}`);
      const parts = withLayer3 ? { ...t.parts, sandbox: layer3 } : t.parts;
      const codex = byId(
        productionClients(config, { env: ENV, findExecutable: ALL_FOUND, adapters: OFFLINE })(
          parts,
        ),
        'codex',
      );
      const profile = t.profile('codex');
      await codex.openSession(profile, TEST_POLICY, t.dir, t.transport);
      const toml = await readFile(join(profile.dir, 'config.toml'), 'utf8');
      const setup0 = t.transport.opened.at(-1)?.setup;
      return {
        mode: setup0?.via === 'acp' ? setup0.configOptions.mode : undefined,
        sandboxMode: /sandbox_mode = "([^"]+)"/.exec(toml)?.[1] ?? '',
      };
    } finally {
      await t.dispose();
    }
  }

  it('keeps workspace-write by default, with or without layer 3', async () => {
    expect(await pinned('', true)).toEqual({
      mode: 'workspace-write',
      sandboxMode: 'workspace-write',
    });
    expect(await pinned('', false)).toEqual({
      mode: 'workspace-write',
      sandboxMode: 'workspace-write',
    });
  });

  it('full_access_when_wrapped opens with no sandbox of the client only when layer 3 is on', async () => {
    const yaml = 'clients:\n  codex:\n    inner_sandbox: full_access_when_wrapped\n';
    expect(await pinned(yaml, true)).toEqual({
      mode: 'agent-full-access',
      sandboxMode: 'danger-full-access',
    });
    expect(await pinned(yaml, false)).toEqual({
      mode: 'workspace-write',
      sandboxMode: 'workspace-write',
    });
  });

  it('nested keeps workspace-write: layer 3 is what changes, not the client', async () => {
    const yaml = 'clients:\n  codex:\n    inner_sandbox: nested\n';
    expect(await pinned(yaml, true)).toEqual({
      mode: 'workspace-write',
      sandboxMode: 'workspace-write',
    });
  });
});

/** A fake install under `dir`: `bin/<command>` links to a file inside `<name>` with this version. */
async function fakeInstall(
  dir: string,
  name: string,
  version: string,
  command: string,
): Promise<FindExecutable> {
  const pkg = join(dir, 'lib', 'node_modules', ...name.split('/'));
  const bin = join(dir, 'bin');
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version }));
  await writeFile(join(pkg, 'dist', 'cli.js'), '#!/bin/sh\n');
  await symlink(join(pkg, 'dist', 'cli.js'), join(bin, command));
  return pathFinder({ PATH: bin }, { isExecutable: () => true });
}

describe('the client version (N63)', () => {
  const NAMES = {
    'claude-code': ['@agentclientprotocol/claude-agent-acp', 'claude-agent-acp'],
    codex: ['@agentclientprotocol/codex-acp', 'codex-acp'],
    opencode: ['opencode-ai', 'opencode'],
  } as const;

  it('reads the package.json of each client, logs where it came from and keys the cache by it', async () => {
    const t = await setup();
    try {
      for (const [id, [name, command]] of Object.entries(NAMES)) {
        const find = await fakeInstall(join(t.dir, id), name, '4.5.6', command);
        const adapter = byId(
          productionClients(parseConfig(OPEN), {
            env: ENV,
            findExecutable: find,
            adapters: OFFLINE,
          })(t.parts),
          id,
        );
        expect(adapter.clientVersion).toEqual({ version: '4.5.6', source: 'package_json' });
        expect(adapter.adapterVersion).toContain('4.5.6');
      }
      const logged = t.lines.filter((l) => l.msg === 'client version');
      expect(logged.map((l) => l.fields)).toEqual(
        expect.arrayContaining([{ client: 'codex', version: '4.5.6', source: 'package_json' }]),
      );
    } finally {
      await t.dispose();
    }
  });

  it('is unknown when the package is not found, with no error', async () => {
    const t = await setup();
    try {
      const adapters = productionClients(parseConfig(OPEN), {
        env: ENV,
        findExecutable: ALL_FOUND,
        adapters: OFFLINE,
      })(t.parts);
      for (const adapter of adapters) {
        expect(adapter.clientVersion).toEqual({ version: 'unknown', source: 'unknown' });
      }
      expect(t.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it('follows version_source: package_json reads, initialize and config do not', async () => {
    const t = await setup();
    try {
      const find = await fakeInstall(t.dir, '@agentclientprotocol/codex-acp', '2.6.0', 'codex-acp');
      const versionIn = (mode: string): string =>
        byId(
          productionClients(
            parseConfig(`${OPEN}clients:\n  codex:\n    version_source: ${mode}\n`),
            { env: ENV, findExecutable: find, adapters: OFFLINE },
          )(t.parts),
          'codex',
        ).clientVersion.version;
      expect(versionIn('auto')).toBe('2.6.0');
      expect(versionIn('package_json')).toBe('2.6.0');
      expect(versionIn('initialize')).toBe('unknown');
      expect(versionIn('config')).toBe('unknown');
    } finally {
      await t.dispose();
    }
  });

  it('a written client_version wins in every mode', async () => {
    const t = await setup();
    try {
      const find = await fakeInstall(t.dir, '@agentclientprotocol/codex-acp', '2.6.0', 'codex-acp');
      for (const mode of ['auto', 'package_json', 'initialize', 'config']) {
        const config = parseConfig(
          `${OPEN}clients:\n  codex:\n    version_source: ${mode}\n    client_version: '7.7.7'\n`,
        );
        const codex = byId(
          productionClients(config, { env: ENV, findExecutable: find, adapters: OFFLINE })(t.parts),
          'codex',
        );
        expect(codex.clientVersion).toEqual({ version: '7.7.7', source: 'config' });
        expect(codex.adapterVersion).toContain('7.7.7');
        // Nothing that the client says in its initialize changes it.
        t.transport.agentInfo = { name: 'codex-acp', version: '8.8.8' };
        const session = await codex.openSession(
          t.profile('codex'),
          TEST_POLICY,
          t.dir,
          t.transport,
        );
        await session.close();
        expect(codex.clientVersion.version).toBe('7.7.7');
      }
    } finally {
      await t.dispose();
    }
  });

  it('version_packages names the package to look for', async () => {
    const t = await setup();
    try {
      const find = await fakeInstall(t.dir, 'my-fork-of-codex-acp', '5.0.0', 'codex-acp');
      const codexOf = (extra: string) =>
        byId(
          productionClients(parseConfig(`${OPEN}clients:\n  codex:\n${extra}`), {
            env: ENV,
            findExecutable: find,
            adapters: OFFLINE,
          })(t.parts),
          'codex',
        );
      expect(codexOf('    enabled: true\n').clientVersion.version).toBe('unknown');
      expect(codexOf('    version_packages: [my-fork-of-codex-acp]\n').clientVersion.version).toBe(
        '5.0.0',
      );
    } finally {
      await t.dispose();
    }
  });

  it('the initialize corrects the version read, the probes key changes and one info line says so', async () => {
    const t = await setup();
    try {
      const find = await fakeInstall(t.dir, '@agentclientprotocol/codex-acp', '2.6.0', 'codex-acp');
      const codex = byId(
        productionClients(parseConfig(OPEN), { env: ENV, findExecutable: find, adapters: OFFLINE })(
          t.parts,
        ),
        'codex',
      );
      const before = codex.adapterVersion;
      t.transport.agentInfo = { name: '@agentclientprotocol/codex-acp', version: '2.7.0' };
      const session = await codex.openSession(t.profile('codex'), TEST_POLICY, t.dir, t.transport);
      await session.close();
      expect(codex.clientVersion).toEqual({ version: '2.7.0', source: 'initialize' });
      expect(codex.adapterVersion).not.toBe(before);
      expect(codex.adapterVersion).toContain('2.7.0');
      const corrected = t.lines.filter(
        (l) => l.msg === 'client version corrected by the initialize',
      );
      expect(corrected).toHaveLength(1);
      expect(corrected[0]?.level).toBe('info');
      expect(corrected[0]?.fields).toMatchObject({
        client: 'codex',
        from: { version: '2.6.0', source: 'package_json' },
        to: { version: '2.7.0', source: 'initialize' },
      });
      // A second session with the same answer says nothing more.
      const again = await codex.openSession(t.profile('codex'), TEST_POLICY, t.dir, t.transport);
      await again.close();
      expect(
        t.lines.filter((l) => l.msg === 'client version corrected by the initialize'),
      ).toHaveLength(1);
    } finally {
      await t.dispose();
    }
  });

  it('with package_json only, the initialize is not listened to', async () => {
    const t = await setup();
    try {
      const find = await fakeInstall(t.dir, '@agentclientprotocol/codex-acp', '2.6.0', 'codex-acp');
      const codex = byId(
        productionClients(
          parseConfig(`${OPEN}clients:\n  codex:\n    version_source: package_json\n`),
          { env: ENV, findExecutable: find, adapters: OFFLINE },
        )(t.parts),
        'codex',
      );
      t.transport.agentInfo = { name: 'codex-acp', version: '2.7.0' };
      const session = await codex.openSession(t.profile('codex'), TEST_POLICY, t.dir, t.transport);
      await session.close();
      expect(codex.clientVersion).toEqual({ version: '2.6.0', source: 'package_json' });
    } finally {
      await t.dispose();
    }
  });
});

describe('the managed ACP adapters (P13, N254 revised)', () => {
  const NODE = '/opt/node/bin/node';
  const only =
    (...names: string[]): FindExecutable =>
    (command) =>
      names.includes(command) ? `/bin/${command}` : undefined;
  const LINUX = { os: 'linux', cpu: 'x64', libc: 'glibc' } as const;

  it("installs the missing adapter in the background and then runs it with the daemon's Node", async () => {
    const t = await setup();
    const fixture = fixtureAdapter();
    const registry = await startFakeRegistry(fixture);
    try {
      const situations = new RecordingSituations();
      const config = parseConfig(`${OPEN}clients:\n  adapters:\n    registry: ${registry.url}\n`);
      const adapters = productionClients(config, {
        env: ENV,
        findExecutable: only('claude'),
        adapters: {
          lockOf: (id) => ({ ...fixture.lock, id }),
          platform: LINUX,
          self: { sea: false, execPath: NODE },
          installOptions: { retryDelayMs: 0, retries: 0 },
        },
      })({ ...t.parts, situations });
      // On while it installs: the official client is in PATH and the adapter is on its way.
      expect(adapters.map((a) => a.id)).toEqual(['claude-code']);
      const claude = byId(adapters, 'claude-code');
      await expect(claude.launchSpec(t.profile('claude-code'), TEST_POLICY, t.dir)).rejects.toThrow(
        /being installed/,
      );
      const entry = join(
        dataPaths(t.dir).adapters,
        'claude-agent-acp',
        '1.2.3',
        'node_modules',
        'fake-acp',
        'dist',
        'index.js',
      );
      await until(() => situations.of('daemon.notice').length >= 2);
      const spec = await claude.launchSpec(t.profile('claude-code'), TEST_POLICY, t.dir);
      expect(spec).toMatchObject({ cmd: NODE, args: [entry] });
      // The adapter drives the user's own client, never a bundled one.
      expect(spec.env.CLAUDE_CODE_EXECUTABLE).toBe('/bin/claude');
      expect(situations.of('daemon.notice')).toMatchObject([
        { kind: 'adapter_installing' },
        { kind: 'adapter_installed' },
      ]);
    } finally {
      await registry.close();
      await t.dispose();
    }
  });

  it.each(['ask', 'command', 'off'])(
    'with install: %s downloads nothing, leaves the client off and says what is missing',
    async (install) => {
      const t = await setup();
      try {
        const situations = new RecordingSituations();
        const adapters = productionClients(
          parseConfig(`clients:\n  adapters:\n    install: ${install}\n`),
          { env: ENV, findExecutable: only('codex'), adapters: OFFLINE },
        )({ ...t.parts, situations });
        expect(adapters).toEqual([]);
        expect(situations.of('daemon.notice')).toMatchObject([
          { kind: 'adapter_missing', subject: 'codex-acp' },
        ]);
      } finally {
        await t.dispose();
      }
    },
  );

  it('falls back to the adapter in PATH, with a warning and an event, when install is off', async () => {
    const t = await setup();
    try {
      const situations = new RecordingSituations();
      const adapters = productionClients(
        parseConfig(`${OPEN}clients:\n  adapters:\n    install: off\n`),
        { env: ENV, findExecutable: only('claude', 'claude-agent-acp'), adapters: OFFLINE },
      )({ ...t.parts, situations });
      const claude = byId(adapters, 'claude-code');
      const spec = await claude.launchSpec(t.profile('claude-code'), TEST_POLICY, t.dir);
      expect(spec).toMatchObject({ cmd: 'claude-agent-acp', args: [] });
      expect(situations.of('daemon.notice')).toMatchObject([{ kind: 'adapter_fallback' }]);
    } finally {
      await t.dispose();
    }
  });

  it('adapter: path and an absolute adapter start what they name', async () => {
    const t = await setup();
    try {
      const config = parseConfig(
        `${OPEN}clients:\n  claude-code:\n    adapter: path\n  codex:\n    adapter: /opt/acp/codex-acp\n`,
      );
      const adapters = productionClients(config, {
        env: ENV,
        findExecutable: only('claude-agent-acp', 'codex'),
        adapters: OFFLINE,
      })(t.parts);
      const claude = byId(adapters, 'claude-code');
      const codex = byId(adapters, 'codex');
      expect(await claude.launchSpec(t.profile('claude-code'), TEST_POLICY, t.dir)).toMatchObject({
        cmd: 'claude-agent-acp',
      });
      expect(await codex.launchSpec(t.profile('codex'), TEST_POLICY, t.dir)).toMatchObject({
        cmd: '/opt/acp/codex-acp',
      });
    } finally {
      await t.dispose();
    }
  });

  it('a configured command still wins over every adapter source', async () => {
    const t = await setup();
    try {
      const config = parseConfig(
        `${OPEN}clients:\n  codex:\n    adapter: /opt/acp/other\n    command: { cmd: /opt/codex-acp }\n`,
      );
      const codex = byId(
        productionClients(config, { env: ENV, findExecutable: NOTHING, adapters: OFFLINE })(
          t.parts,
        ),
        'codex',
      );
      expect(await codex.launchSpec(t.profile('codex'), TEST_POLICY, t.dir)).toMatchObject({
        cmd: '/opt/codex-acp',
      });
    } finally {
      await t.dispose();
    }
  });
});

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(condition()).toBe(true);
}
