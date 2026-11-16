// SPDX-License-Identifier: MPL-2.0
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type ClientAdapter, type Profile } from '@otheater/core';
import {
  FakeClock,
  FakeClientAdapter,
  FakeProcessLauncher,
  FakeSessionTransport,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import type { ClientFactoryParts, FindExecutable } from './clients.js';
import { DEFAULT_CLIENT_EXECUTABLES, productionClients, transportFor } from './compose.js';
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

describe('transportFor', () => {
  it('wraps the transport of Codex once per adapter and leaves the others alone', async () => {
    const t = await setup();
    try {
      const adapters = productionClients(parseConfig(''), { env: ENV, findExecutable: ALL_FOUND })(
        t.parts,
      );
      const base = t.transport;
      expect(transportFor(byId(adapters, 'claude-code'), base)).toBe(base);
      expect(transportFor(byId(adapters, 'opencode'), base)).toBe(base);
      const codex = byId(adapters, 'codex');
      const guarded = transportFor(codex, base);
      expect(guarded).not.toBe(base);
      expect(transportFor(codex, base)).toBe(guarded);
      const fake = new FakeClientAdapter({
        launcher: t.launcher,
        baseEnv: {},
        adapterVersion: '1.0.0',
        command: { cmd: 'fake-client', args: [] },
      });
      expect(transportFor(fake, base)).toBe(base);
    } finally {
      await t.dispose();
    }
  });
});

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(condition()).toBe(true);
}
