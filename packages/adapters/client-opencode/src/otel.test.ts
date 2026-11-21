// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidInput,
  ROLE_POLICY_FIELDS,
  type ClientAdapterWarning,
  type ClientOtel,
  type Profile,
  type RolePolicy,
} from '@otheater/core';
import { FakeProcessLauncher, FakeSessionTransport } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeAdapter, opencodeAdapterVersion } from './opencode-adapter.js';
import { OPENCODE_CONFIG_CONTENT_ENV, opencodeOtelEnv } from './otel.js';

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
    'otheater.client': 'opencode',
  },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function profileIn(): Promise<Profile> {
  const dir = await mkdtemp(join(tmpdir(), 'ot-opencode-otel-'));
  dirs.push(dir);
  return { client: 'opencode', profile: 'work', id: 'opencode/work', dir };
}

function build(baseEnv: Record<string, string> = { PATH: '/usr/bin' }): {
  adapter: OpenCodeAdapter;
  launcher: FakeProcessLauncher;
  warnings: ClientAdapterWarning[];
} {
  const launcher = new FakeProcessLauncher();
  const warnings: ClientAdapterWarning[] = [];
  const adapter = new OpenCodeAdapter({
    launcher,
    baseEnv,
    adapterVersion: opencodeAdapterVersion(),
    processModel: 'per_session',
    sandbox: { fields: ROLE_POLICY_FIELDS },
    onWarning: (warning) => warnings.push(warning),
  });
  return { adapter, launcher, warnings };
}

const otelKeys = (env: Record<string, string> | undefined): string[] =>
  Object.keys(env ?? {}).filter((key) => key.startsWith('OTEL_'));

describe('opencodeOtelEnv', () => {
  it('carries the endpoint, the token and the correlation, and nothing else by default', () => {
    expect(opencodeOtelEnv(otel, undefined)).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer tok-1',
      OTEL_RESOURCE_ATTRIBUTES:
        'otheater.attempt_id=a1,otheater.client=opencode,otheater.play_id=p1,otheater.session_id=x1',
    });
  });

  it('turns experimental.openTelemetry on only with experimental: true', () => {
    expect(opencodeOtelEnv({ ...otel, experimental: false }, undefined)).not.toHaveProperty(
      OPENCODE_CONFIG_CONTENT_ENV,
    );
    const env = opencodeOtelEnv({ ...otel, experimental: true }, undefined);
    expect(JSON.parse(env?.[OPENCODE_CONFIG_CONTENT_ENV] ?? '')).toEqual({
      experimental: { openTelemetry: true },
    });
  });

  it('merges into a config the environment already has, keeping what is there', () => {
    const existing = JSON.stringify({ theme: 'x', experimental: { other: 1 } });
    const env = opencodeOtelEnv({ ...otel, experimental: true }, existing);
    expect(JSON.parse(env?.[OPENCODE_CONFIG_CONTENT_ENV] ?? '')).toEqual({
      theme: 'x',
      experimental: { other: 1, openTelemetry: true },
    });
  });

  it('gives up (null) on a config it cannot merge into, rather than overwrite it', () => {
    for (const bad of ['{not json', '[1]', '"text"', 'null']) {
      expect(opencodeOtelEnv({ ...otel, experimental: true }, bad)).toBeNull();
    }
  });
});

describe('OpenCodeAdapter with otel', () => {
  it('without otel no OTEL variable and no config content reach the client', async () => {
    const { adapter, launcher } = build();
    await adapter.openSession(
      await profileIn(),
      policy,
      '/work',
      new FakeSessionTransport({ id: 'acp' }),
    );
    const env = launcher.launched[0]?.options.env;
    expect(otelKeys(env)).toEqual([]);
    expect(env).not.toHaveProperty(OPENCODE_CONFIG_CONTENT_ENV);
  });

  it('hands over the endpoint, the token and the resource, next to the isolation', async () => {
    const { adapter, launcher } = build();
    const profile = await profileIn();
    await adapter.openSession(profile, policy, '/work', new FakeSessionTransport({ id: 'acp' }), {
      otel,
    });
    const env = launcher.launched[0]?.options.env;
    expect(env).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer tok-1',
      XDG_DATA_HOME: join(profile.dir, 'data'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    });
    expect(env?.OTEL_RESOURCE_ATTRIBUTES).toContain('otheater.attempt_id=a1');
    expect(env).not.toHaveProperty(OPENCODE_CONFIG_CONTENT_ENV);
    expect(launcher.launched[0]?.options.args).toEqual(['acp']);
  });

  it('the AI SDK spans are off by default and on with experimental', async () => {
    const { adapter, launcher } = build();
    await adapter.openSession(
      await profileIn(),
      policy,
      '/work',
      new FakeSessionTransport({ id: 'acp' }),
      { otel: { ...otel, experimental: true } },
    );
    const text = launcher.launched[0]?.options.env[OPENCODE_CONFIG_CONTENT_ENV];
    expect(JSON.parse(text ?? '')).toEqual({ experimental: { openTelemetry: true } });
  });

  it('merges the spans setting into the OPENCODE_CONFIG_CONTENT of the environment', async () => {
    const { adapter, launcher } = build({
      PATH: '/usr/bin',
      [OPENCODE_CONFIG_CONTENT_ENV]: '{"theme":"x"}',
    });
    await adapter.openSession(
      await profileIn(),
      policy,
      '/work',
      new FakeSessionTransport({ id: 'acp' }),
      { otel: { ...otel, experimental: true } },
    );
    const text = launcher.launched[0]?.options.env[OPENCODE_CONFIG_CONTENT_ENV];
    expect(JSON.parse(text ?? '')).toEqual({ theme: 'x', experimental: { openTelemetry: true } });
  });

  it('a config it cannot merge into starts the client without telemetry and says so', async () => {
    const { adapter, launcher, warnings } = build({
      PATH: '/usr/bin',
      [OPENCODE_CONFIG_CONTENT_ENV]: '{broken',
    });
    await adapter.openSession(
      await profileIn(),
      policy,
      '/work',
      new FakeSessionTransport({ id: 'acp' }),
      { otel: { ...otel, experimental: true } },
    );
    const env = launcher.launched[0]?.options.env;
    expect(otelKeys(env)).toEqual([]);
    expect(env?.[OPENCODE_CONFIG_CONTENT_ENV]).toBe('{broken');
    expect(warnings).toMatchObject([{ kind: 'otel_unavailable', clientId: 'opencode' }]);
    expect(JSON.stringify(warnings)).not.toContain('tok-1');
  });

  it('the headless transport gets the same environment', async () => {
    const { adapter, launcher } = build();
    await adapter.openSession(
      await profileIn(),
      policy,
      '/work',
      new FakeSessionTransport({ id: 'headless' }),
      { otel },
    );
    expect(launcher.launched[0]?.options.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      'http://127.0.0.1:4318',
    );
  });

  it('launchSpec gives the pool the same environment, and none without otel', async () => {
    const { adapter } = build();
    const profile = await profileIn();
    const spec = await adapter.launchSpec(profile, policy, '/work', 'acp', 'work', otel);
    expect(spec.env.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=Bearer tok-1');
    const plain = await adapter.launchSpec(profile, policy, '/work');
    expect(otelKeys(plain.env)).toEqual([]);
  });

  it('a bad id is refused before the client starts, without printing the token', async () => {
    const { adapter, launcher } = build();
    const error = await adapter
      .openSession(await profileIn(), policy, '/work', new FakeSessionTransport({ id: 'acp' }), {
        otel: { ...otel, resource: { 'otheater.play_id': 'a=b' } },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidInput);
    expect((error as Error).message).not.toContain('tok-1');
    expect(launcher.launched).toHaveLength(0);
  });
});
