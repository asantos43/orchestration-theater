// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  InvalidInput,
  type ClientAdapterWarning,
  type ClientOtel,
  type Profile,
  type RolePolicy,
} from '@otheater/core';
import { FakeProcessLauncher, FakeSessionTransport } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter, type CodexAdapterOptions } from './codex-adapter.js';
import {
  CODEX_OTEL_WRAPPER,
  codexOtelSettings,
  codexOtelTitle,
  ensureCodexOtelWrapper,
  OTEL_REAL_ENV,
  OTEL_SETTINGS_ENV,
} from './otel.js';

const run = promisify(execFile);

const policy: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

const otel: ClientOtel = {
  endpoint: 'http://127.0.0.1:4318/',
  headers: { Authorization: 'Bearer tok-1' },
  resource: {
    'otheater.play_id': 'p1',
    'otheater.attempt_id': 'a1',
    'otheater.session_id': 'x1',
    'otheater.client': 'codex',
  },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ot-codex-otel-'));
  dirs.push(dir);
  return dir;
}

async function profileIn(): Promise<Profile> {
  return { client: 'codex', profile: 'work', id: 'codex/work', dir: await tmp() };
}

function build(options: Partial<CodexAdapterOptions> = {}): {
  adapter: CodexAdapter;
  launcher: FakeProcessLauncher;
  warnings: ClientAdapterWarning[];
} {
  const launcher = new FakeProcessLauncher();
  const warnings: ClientAdapterWarning[] = [];
  const adapter = new CodexAdapter({
    launcher,
    baseEnv: { PATH: '/usr/bin' },
    adapterVersion: '2.6.0',
    sandbox: { fields: ['nativeTools', 'nativeShell', 'network'] },
    onWarning: (warning) => warnings.push(warning),
    ...options,
    // The wrapper is POSIX only: these tests check what is generated, so they name a POSIX platform
    // even on a Windows runner; the win32 case passes its own.
    otel: { platform: 'linux', ...options.otel },
  });
  return { adapter, launcher, warnings };
}

describe('codexOtelSettings', () => {
  it('sends logs and metrics as OTLP/JSON to the receiver, each signal on its own path, with the token', () => {
    const settings = codexOtelSettings(otel);
    expect(settings).toEqual([
      'otel.environment="otheater"',
      'otel.exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/logs",protocol="json",headers={"Authorization"="Bearer tok-1"}}}',
      'otel.metrics_exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/metrics",protocol="json",headers={"Authorization"="Bearer tok-1"}}}',
    ]);
  });

  it('adds the trace exporter only with traces: true', () => {
    expect(codexOtelSettings(otel).some((s) => s.startsWith('otel.trace_exporter='))).toBe(false);
    const traced = codexOtelSettings({ ...otel, traces: true });
    expect(traced).toContain(
      'otel.trace_exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/traces",protocol="json",headers={"Authorization"="Bearer tok-1"}}}',
    );
  });

  it('leaves the headers table out when there is no header', () => {
    expect(codexOtelSettings({ ...otel, headers: {} }).join('\n')).not.toContain('headers=');
  });

  it('refuses what the TOML or the resource cannot carry, naming no value', () => {
    expect(() => codexOtelSettings({ ...otel, endpoint: 'ftp://x' })).toThrow(InvalidInput);
    expect(() => codexOtelSettings({ ...otel, headers: { Authorization: 'a\nb' } })).toThrow(
      InvalidInput,
    );
    expect(() => codexOtelSettings({ ...otel, resource: { 'otheater.play_id': 'a b' } })).toThrow(
      InvalidInput,
    );
  });

  it('titles the session with the attempt, else the session, else nothing', () => {
    expect(codexOtelTitle(otel)).toBe('OTheater a1');
    expect(codexOtelTitle({ ...otel, resource: { 'otheater.session_id': 'x1' } })).toBe(
      'OTheater x1',
    );
    expect(codexOtelTitle({ ...otel, resource: {} })).toBe('OTheater');
  });
});

describe('the wrapper', () => {
  it('is written in the profile directory, executable, once', async () => {
    const dir = await tmp();
    const file = await ensureCodexOtelWrapper(dir);
    expect(file.startsWith(dir)).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(CODEX_OTEL_WRAPPER);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o111).not.toBe(0);
    const before = (await stat(file)).mtimeMs;
    await ensureCodexOtelWrapper(dir);
    expect((await stat(file)).mtimeMs).toBe(before);
  });

  it('holds no secret: the token is only in the environment it is given', () => {
    expect(CODEX_OTEL_WRAPPER).not.toContain('tok-1');
    expect(CODEX_OTEL_WRAPPER).not.toContain('127.0.0.1');
  });

  it.skipIf(process.platform === 'win32')(
    'runs the real codex with one -c per setting, before the arguments of codex-acp',
    async () => {
      const dir = await tmp();
      const wrapper = await ensureCodexOtelWrapper(dir);
      const real = join(dir, 'fake-codex.sh');
      await writeFile(real, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
      await chmod(real, 0o755);
      const { stdout } = await run(wrapper, ['app-server', '--x'], {
        env: {
          PATH: '/usr/bin:/bin',
          [OTEL_REAL_ENV]: real,
          [OTEL_SETTINGS_ENV]: 'otel.a="1"\notel.b={x={y="*"}}',
        },
      });
      // The wrapper prepends each setting, so the last one comes first; all before the arguments.
      expect(stdout.split('\n').filter((l) => l !== '')).toEqual([
        '-c',
        'otel.b={x={y="*"}}',
        '-c',
        'otel.a="1"',
        'app-server',
        '--x',
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'without settings it only runs the real codex',
    async () => {
      const dir = await tmp();
      const wrapper = await ensureCodexOtelWrapper(dir);
      const real = join(dir, 'fake-codex.sh');
      await writeFile(real, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
      await chmod(real, 0o755);
      const { stdout } = await run(wrapper, ['app-server'], {
        env: { PATH: '/usr/bin:/bin', [OTEL_REAL_ENV]: real },
      });
      expect(stdout).toBe('app-server\n');
    },
  );
});

describe('CodexAdapter with otel', () => {
  it('without otel nothing changes: no wrapper, no OTEL variable, no title', async () => {
    const { adapter, launcher } = build();
    const via = new FakeSessionTransport({ id: 'acp' });
    const profile = await profileIn();
    await adapter.openSession(profile, policy, '/work', via);
    const env = launcher.launched[0]?.options.env ?? {};
    expect(Object.keys(env).filter((k) => /OTEL|OTHEATER|CODEX_PATH/u.test(k))).toEqual([]);
    expect(via.opened[0]?.setup).not.toHaveProperty('title');
    await expect(stat(join(profile.dir, '.otheater'))).rejects.toThrow();
  });

  it('points CODEX_PATH at the wrapper and hands over the settings and the resource in the environment', async () => {
    const { adapter, launcher } = build({ otel: { codexPath: '/opt/codex/bin/codex' } });
    const via = new FakeSessionTransport({ id: 'acp' });
    const profile = await profileIn();
    await adapter.openSession(profile, policy, '/work', via, { otel: { ...otel, traces: true } });
    const launched = launcher.launched[0]?.options;
    expect(launched?.cmd).toBe('codex-acp');
    expect(launched?.args).toEqual([]);
    const env = launched?.env ?? {};
    expect(env.CODEX_PATH).toBe(join(profile.dir, '.otheater', 'codex-otel.sh'));
    expect(env[OTEL_REAL_ENV]).toBe('/opt/codex/bin/codex');
    expect(env[OTEL_SETTINGS_ENV]?.split('\n')).toEqual(
      codexOtelSettings({ ...otel, traces: true }),
    );
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'otheater.attempt_id=a1,otheater.client=codex,otheater.play_id=p1,otheater.session_id=x1',
    );
    expect(env.CODEX_HOME).toBe(profile.dir);
  });

  it('keeps the CODEX_PATH of the environment as the real codex', async () => {
    const { adapter, launcher } = build({ baseEnv: { PATH: '/usr/bin', CODEX_PATH: '/x/codex' } });
    const profile = await profileIn();
    await adapter.openSession(profile, policy, '/work', new FakeSessionTransport({ id: 'acp' }), {
      otel,
    });
    expect(launcher.launched[0]?.options.env[OTEL_REAL_ENV]).toBe('/x/codex');
  });

  it('falls back to codex on PATH when nothing names the real one', async () => {
    const { adapter, launcher } = build();
    const profile = await profileIn();
    await adapter.openSession(profile, policy, '/work', new FakeSessionTransport({ id: 'acp' }), {
      otel,
    });
    expect(launcher.launched[0]?.options.env[OTEL_REAL_ENV]).toBe('codex');
  });

  it('does not touch config.toml of the profile with the otel table', async () => {
    const { adapter } = build();
    const profile = await profileIn();
    await adapter.openSession(profile, policy, '/work', new FakeSessionTransport({ id: 'acp' }), {
      otel,
    });
    const config = await readFile(join(profile.dir, 'config.toml'), 'utf8');
    expect(config).not.toMatch(/otel|tok-1|4318/u);
  });

  it('sets the title of the session before the first prompt, next to the mode', async () => {
    const { adapter } = build();
    const via = new FakeSessionTransport({ id: 'acp' });
    await adapter.openSession(await profileIn(), policy, '/work', via, { otel });
    expect(via.opened[0]?.setup).toMatchObject({
      via: 'acp',
      title: 'OTheater a1',
      configOptions: { mode: adapter.initialMode },
    });
  });

  it('launchSpec gives the same process-level settings to a pool that owns the process', async () => {
    const { adapter } = build();
    const profile = await profileIn();
    const spec = await adapter.launchSpec(profile, policy, '/work', 'acp', 'work', otel);
    expect(spec.env.CODEX_PATH).toBe(join(profile.dir, '.otheater', 'codex-otel.sh'));
    expect(spec.env[OTEL_SETTINGS_ENV]).toContain('otel.exporter=');
    const plain = await adapter.launchSpec(profile, policy, '/work');
    expect(Object.keys(plain.env).filter((k) => /OTEL|OTHEATER/u.test(k))).toEqual([]);
  });

  it('a session with another resource gets its own process: the key follows the environment', async () => {
    const { adapter, launcher } = build();
    const profile = await profileIn();
    const via = new FakeSessionTransport({ id: 'acp' });
    await adapter.openSession(profile, policy, '/work', via, { otel });
    await adapter.openSession(profile, policy, '/work', via, { otel });
    await adapter.openSession(profile, policy, '/work', via, {
      otel: { ...otel, resource: { ...otel.resource, 'otheater.session_id': 'x2' } },
    });
    expect(launcher.launched).toHaveLength(2);
  });

  it('on Windows it starts without telemetry and says so', async () => {
    const { adapter, launcher, warnings } = build({ otel: { platform: 'win32' } });
    const via = new FakeSessionTransport({ id: 'acp' });
    const profile = await profileIn();
    await adapter.openSession(profile, policy, '/work', via, { otel });
    const env = launcher.launched[0]?.options.env ?? {};
    expect(Object.keys(env).filter((k) => /OTEL|OTHEATER|CODEX_PATH/u.test(k))).toEqual([]);
    expect(via.opened[0]?.setup).not.toHaveProperty('title');
    expect(warnings).toMatchObject([{ kind: 'otel_unavailable', clientId: 'codex' }]);
    expect(JSON.stringify(warnings)).not.toContain('tok-1');
  });

  it('on the headless transport it starts without telemetry and says so', async () => {
    const { adapter, launcher, warnings } = build();
    const headless = new FakeSessionTransport({ id: 'headless' });
    await adapter.openSession(await profileIn(), policy, '/work', headless, { otel });
    const env = launcher.launched[0]?.options.env ?? {};
    expect(Object.keys(env).filter((k) => /OTEL|OTHEATER|CODEX_PATH/u.test(k))).toEqual([]);
    expect(warnings.map((w) => w.kind)).toEqual(['otel_unavailable']);
  });

  it('a bad id is refused before anything is written', async () => {
    const { adapter, launcher } = build();
    const profile = await profileIn();
    await expect(
      adapter.openSession(profile, policy, '/work', new FakeSessionTransport({ id: 'acp' }), {
        otel: { ...otel, resource: { 'otheater.play_id': 'a=b' } },
      }),
    ).rejects.toBeInstanceOf(InvalidInput);
    expect(launcher.launched).toHaveLength(0);
  });
});
