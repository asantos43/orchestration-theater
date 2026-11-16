// SPDX-License-Identifier: MPL-2.0
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type ClientAdapter, type Profile } from '@otheater/core';
import { FakeClock, FakeProcessLauncher, FakeSessionTransport } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import type { ClientFactoryParts, FindExecutable } from './clients.js';
import { DEFAULT_CLIENT_EXECUTABLES, productionClients } from './compose.js';
import { parseConfig } from './config.js';
import { dataPaths } from './paths.js';
import { captureLogger, makeTempDataDir, TEST_POLICY } from './test-helpers.js';

const ALL_FOUND: FindExecutable = (command) => `/bin/${command}`;
const NOTHING: FindExecutable = () => undefined;
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
      const adapters = productionClients(parseConfig(''), { env: ENV, findExecutable: ALL_FOUND })(
        t.parts,
      );
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
      const adapters = productionClients(config, { env: ENV, findExecutable: find })(t.parts);
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
        productionClients(parseConfig(''), { env: ENV, findExecutable: NOTHING })(t.parts),
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
      const adapters = productionClients(config, { env: ENV, findExecutable: NOTHING })(t.parts);
      expect(adapters.map((a) => a.id)).toEqual(['codex', 'opencode']);
      expect(t.lines.some((l) => l.level === 'warn' && l.fields.client === 'opencode')).toBe(true);
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
        productionClients(all, { env: ENV, findExecutable: ALL_FOUND })(t.parts),
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
        productionClients(keep, { env: ENV, findExecutable: ALL_FOUND })(t.parts),
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
        productionClients(config, { env: ENV, findExecutable: NOTHING })(t.parts),
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
        productionClients(config, { env: ENV, findExecutable: ALL_FOUND })(t.parts),
        'codex',
      );
      expect(codex.processModel).toBe('process-per-session');
    } finally {
      await t.dispose();
    }
  });

  it('starts OpenCode with `opencode acp`, the isolated homes of its profile and project config off', async () => {
    const t = await setup();
    try {
      const opencode = byId(
        productionClients(parseConfig(OPEN), { env: ENV, findExecutable: ALL_FOUND })(t.parts),
        'opencode',
      );
      const profile = t.profile('opencode');
      const spec = await opencode.launchSpec(profile, TEST_POLICY, t.dir);
      expect(spec).toMatchObject({ cmd: 'opencode', args: ['acp'] });
      expect(spec.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
      expect(spec.env.OPENCODE_PERMISSION).toBeTypeOf('string');
      expect(spec.env.XDG_DATA_HOME?.startsWith(profile.dir)).toBe(true);
      expect(spec.env.XDG_STATE_HOME).toBeUndefined();

      const wide = parseConfig(
        `${OPEN}clients:\n  opencode:\n    isolation: [data, config, state]\n    project_config: enabled\n    command: { cmd: /opt/opencode }\n`,
      );
      const other = byId(
        productionClients(wide, { env: ENV, findExecutable: NOTHING })(t.parts),
        'opencode',
      );
      const wideSpec = await other.launchSpec(t.profile('opencode'), TEST_POLICY, t.dir);
      expect(wideSpec).toMatchObject({ cmd: '/opt/opencode', args: ['acp'] });
      expect(wideSpec.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
      expect(wideSpec.env.XDG_STATE_HOME?.startsWith(profile.dir)).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it('passes pool.opencode.process_model to OpenCode (N56)', async () => {
    const t = await setup();
    try {
      const model = (text: string): string =>
        byId(
          productionClients(parseConfig(text), { env: ENV, findExecutable: ALL_FOUND })(t.parts),
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
        productionClients(parseConfig(''), { env: ENV, findExecutable: ALL_FOUND })(t.parts),
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
        productionClients(parseConfig(''), { env: ENV, findExecutable: ALL_FOUND })(t.parts),
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
      const adapters = productionClients(parseConfig(''), { env: ENV, findExecutable: ALL_FOUND })(
        t.parts,
      );
      for (const adapter of adapters) {
        await expect(adapter.launchSpec(t.profile(adapter.id), TEST_POLICY, t.dir)).rejects.toThrow(
          /writeScope|network/,
        );
      }
      const lax = productionClients(parseConfig('security:\n  unenforced: warn\n'), {
        env: ENV,
        findExecutable: ALL_FOUND,
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
      const adapters = productionClients(parseConfig(''), { env: ENV, findExecutable: ALL_FOUND })(
        t.parts,
      );
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
          { env: ENV, findExecutable: ALL_FOUND },
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
        productionClients(open(), { env: ENV, findExecutable: ALL_FOUND })(t.parts),
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
        productionClients(open(), { env: ENV, findExecutable: ALL_FOUND })(t.parts),
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
        productionClients(open(), { env: ENV, findExecutable: ALL_FOUND })(t.parts),
        'claude-code',
      );
      // `session_or_reserve` falls back to the reserve; the catalog of Codex has none and rejects.
      const codexAdapter = byId(
        productionClients(open(), { env: ENV, findExecutable: ALL_FOUND })(t.parts),
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

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(condition()).toBe(true);
}
