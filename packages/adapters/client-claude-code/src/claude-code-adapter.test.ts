// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidInput,
  PermissionDenied,
  type ClientOtel,
  type PermissionRequest,
  type Profile,
  type RolePolicy,
} from '@otheater/core';
import { FakeProcessLauncher, FakeSessionTransport } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_ADAPTER_VERSION,
  CLAUDE_CODE_CLIENT_ID,
  ClaudeCodeAdapter,
  DEFAULT_COMMAND,
  type ClaudeCodeAdapterOptions,
} from './claude-code-adapter.js';
import { deniedTools } from './policy.js';
import { SH_C_REJECT_PROBE_ID } from './probes.js';

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

const writingPolicy: RolePolicy = {
  ...policy,
  nativeTools: ['read', 'search', 'edit', 'write'],
  editInWorktree: 'allow',
};

let root: string;
let profile: Profile;
let launcher: FakeProcessLauncher;
let via: FakeSessionTransport;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ot-claude-adapter-'));
  profile = { client: 'claude-code', profile: 'p', id: 'claude-code/p', dir: join(root, 'p') };
  launcher = new FakeProcessLauncher();
  via = new FakeSessionTransport({ id: 'acp' });
});

afterEach(async () => {
  await Promise.all(launcher.running.map((process) => process.killTree()));
  await rm(root, { recursive: true, force: true });
});

function build(options: Partial<ClaudeCodeAdapterOptions> = {}): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    launcher,
    baseEnv: {},
    sandbox: { fields: ['writeScope', 'network'] },
    ...options,
  });
}

describe('identity', () => {
  it('is the claude-code client, one process per session, with the ClientAdapter port', () => {
    const adapter = build();
    expect(adapter.id).toBe(CLAUDE_CODE_CLIENT_ID);
    expect(adapter.id).toBe('claude-code');
    expect(adapter.processModel).toBe('process-per-session');
    expect(adapter.implements.port).toBe('ClientAdapter');
    expect(adapter.capabilities).toEqual({
      loadSession: true,
      mcpHttp: true,
      configOptions: ['mode', 'model', 'thought_level'],
      headless: true,
      extensions: [],
      inputTypes: ['image'],
    });
  });

  it('exposes the quota probe and the model catalog of the client', () => {
    const adapter = build();
    expect(adapter.quota.id).toBe('claude-code');
    expect(adapter.models.discovery).toBe('automatic');
  });

  it('has no ACP extension', () => {
    expect(build().capabilities.extensions).toEqual([]);
  });
});

describe('the process it launches', () => {
  it('uses the default command, and the one the options give', async () => {
    await build().openSession(profile, policy, '/work', via);
    expect(launcher.launched[0]?.options).toMatchObject({
      cmd: DEFAULT_COMMAND.cmd,
      args: [...DEFAULT_COMMAND.args],
      cwd: '/work',
    });
    await build({ command: { cmd: '/opt/acp', args: ['--x'] } }).openSession(
      profile,
      policy,
      '/work',
      via,
    );
    expect(launcher.launched[1]?.options).toMatchObject({ cmd: '/opt/acp', args: ['--x'] });
  });

  it('points CLAUDE_CONFIG_DIR at the profile directory', async () => {
    await build({ baseEnv: { PATH: '/usr/bin' } }).openSession(profile, policy, '/work', via);
    expect(launcher.launched[0]?.options.env).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: profile.dir,
    });
  });

  it('strips the account variables from the base environment by default', async () => {
    await build({
      baseEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'placeholder', CLAUDE_CODE_OAUTH_TOKEN: 'x' },
    }).openSession(profile, policy, '/work', via);
    const env = launcher.launched[0]?.options.env ?? {};
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('keeps them when accountEnv is keep', async () => {
    await build({ baseEnv: { ANTHROPIC_API_KEY: 'placeholder' }, accountEnv: 'keep' }).openSession(
      profile,
      policy,
      '/work',
      via,
    );
    expect(launcher.launched[0]?.options.env).toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('writes the profile settings before it launches', async () => {
    await build().openSession(profile, policy, '/work', via);
    const settings = JSON.parse(await readFile(join(profile.dir, 'settings.json'), 'utf8')) as {
      permissions: { defaultMode: string; deny: string[]; disableBypassPermissionsMode: string };
    };
    expect(settings.permissions.defaultMode).toBe('default');
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
    expect(settings.permissions.deny).toEqual(deniedTools(policy));
  });
});

describe('the mode of the session (N180)', () => {
  const settingsOf = async (): Promise<{ permissions: { defaultMode: string } }> =>
    JSON.parse(await readFile(join(profile.dir, 'settings.json'), 'utf8')) as {
      permissions: { defaultMode: string };
    };

  it('starts a role that writes in acceptEdits: the ACP setup, the headless flags and the profile file', async () => {
    await build().openSession(profile, writingPolicy, '/work', via);
    expect(via.opened[0]?.setup).toMatchObject({
      via: 'acp',
      configOptions: { mode: 'acceptEdits' },
    });
    expect((await settingsOf()).permissions.defaultMode).toBe('acceptEdits');
    const headless = new FakeSessionTransport({ id: 'headless' });
    await build().openSession(profile, writingPolicy, '/work', headless);
    const setup = headless.opened[0]?.setup;
    if (setup?.via !== 'headless') throw new Error('expected a headless setup');
    expect(setup.args[setup.args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  it('starts a role that writes with edit_in_worktree: ask in default, so the edit reaches layer 2 (N182)', async () => {
    const asking: RolePolicy = { ...writingPolicy, editInWorktree: 'ask' };
    await build().openSession(profile, asking, '/work', via);
    expect(via.opened[0]?.setup).toMatchObject({ via: 'acp', configOptions: { mode: 'default' } });
    expect((await settingsOf()).permissions.defaultMode).toBe('default');
    const headless = new FakeSessionTransport({ id: 'headless' });
    await build().openSession(profile, asking, '/work', headless);
    const setup = headless.opened[0]?.setup;
    if (setup?.via !== 'headless') throw new Error('expected a headless setup');
    expect(setup.args[setup.args.indexOf('--permission-mode') + 1]).toBe('default');
  });

  it('starts a role that only reads in default, on the same three paths', async () => {
    await build().openSession(profile, policy, '/work', via);
    expect(via.opened[0]?.setup).toMatchObject({ via: 'acp', configOptions: { mode: 'default' } });
    expect((await settingsOf()).permissions.defaultMode).toBe('default');
    const headless = new FakeSessionTransport({ id: 'headless' });
    await build().openSession(profile, policy, '/work', headless);
    const setup = headless.opened[0]?.setup;
    if (setup?.via !== 'headless') throw new Error('expected a headless setup');
    expect(setup.args[setup.args.indexOf('--permission-mode') + 1]).toBe('default');
  });

  it('lets the mode of the executor win: it is applied by setConfig after the setup', async () => {
    const adapter = build();
    const session = await adapter.openSession(profile, writingPolicy, '/work', via);
    expect(via.opened[0]?.setup).toMatchObject({ configOptions: { mode: 'acceptEdits' } });
    // The setup is applied at the opening of the session; the executor config only afterwards.
    expect(via.configApplied).toEqual([]);
    for (const [id, value] of Object.entries(
      adapter.configOptionsFor({ model: 'sonnet', mode: 'plan' }),
    )) {
      if (id === 'mode') await session.setConfig(id, value);
    }
    expect(via.configApplied.at(-1)).toEqual({ id: 'mode', value: 'plan' });
    // An executor with no `mode` asks for no mode at all: the mode of the role stays.
    expect(adapter.configOptionsFor({ model: 'sonnet' })).not.toHaveProperty('mode');
  });

  it('still refuses bypassPermissions on a role that writes', () => {
    expect(() => build().configOptionsFor({ model: 'sonnet', mode: 'bypassPermissions' })).toThrow(
      PermissionDenied,
    );
  });
});

describe('sessionSetup', () => {
  it('on ACP, sends the options under _meta.claudeCode and starts in the default mode', async () => {
    await build().openSession(profile, policy, '/work', via);
    const setup = via.opened[0]?.setup;
    expect(setup).toMatchObject({
      via: 'acp',
      configOptions: { mode: 'default' },
      meta: {
        claudeCode: {
          options: {
            tools: ['Read', 'Glob', 'Grep'],
            strictMcpConfig: true,
            allowDangerouslySkipPermissions: false,
            settingSources: [],
          },
        },
      },
    });
  });

  it('on ACP, allows the MCP tools of the policy in the options and in the settings of _meta', async () => {
    await build().openSession(
      profile,
      { ...policy, mcpServers: ['otheater'], mcpTools: { otheater: ['submit'] } },
      '/work',
      via,
      { mcpServers: [{ name: 'otheater', url: 'http://127.0.0.1:1/mcp' }] },
    );
    expect(via.opened[0]?.setup).toMatchObject({
      via: 'acp',
      meta: {
        claudeCode: {
          options: {
            allowedTools: ['mcp__otheater__submit'],
            settings: { permissions: { allow: ['mcp__otheater__submit'] } },
          },
        },
      },
    });
  });

  it('follows the setting_sources mode', async () => {
    await build({ settingSources: 'user' }).openSession(profile, policy, '/work', via);
    expect(JSON.stringify(via.opened[0]?.setup)).toContain(
      '"settingSources":["user","project","local"]',
    );
  });

  it('on the headless transport, hands over the flags and no extra environment', async () => {
    const headless = new FakeSessionTransport({ id: 'headless' });
    await build().openSession(profile, policy, '/work', headless);
    const setup = headless.opened[0]?.setup;
    expect(setup?.via).toBe('headless');
    if (setup?.via !== 'headless') throw new Error('expected a headless setup');
    expect(setup.args).toContain('--strict-mcp-config');
    expect(setup.args.join(' ')).not.toMatch(/bypass/iu);
    expect(setup.env).toEqual({});
  });
});

describe('layer 2: the answer to a permission request', () => {
  const request = (kinds: PermissionRequest['options'][number]['kind'][]): PermissionRequest =>
    ({
      sessionId: 's',
      toolCall: { toolCallId: 't', title: 'Bash' },
      options: kinds.map((kind, index) => ({ optionId: `o${String(index)}`, name: kind, kind })),
    }) as unknown as PermissionRequest;

  it('rejects once, never allows, and cancels when nothing refuses', async () => {
    await build().openSession(profile, policy, '/work', via);
    const answer = via.opened[0]?.onPermission;
    expect(answer?.(request(['allow_once', 'reject_once']))).toEqual({
      outcome: 'selected',
      optionId: 'o1',
    });
    expect(answer?.(request(['allow_always', 'reject_always']))).toEqual({
      outcome: 'selected',
      optionId: 'o1',
    });
    expect(answer?.(request(['allow_once', 'allow_always']))).toEqual({ outcome: 'cancelled' });
  });
});

describe('guarantee', () => {
  it('counts the client for tools, shell, MCP and bypass, the daemon for onAsk', () => {
    const report = build().guarantee(policy, { fields: [] });
    expect(report.fields.nativeTools.layers).toEqual(['client']);
    expect(report.fields.nativeShell.layers).toEqual(['client']);
    expect(report.fields.mcpServers.layers).toEqual(['client']);
    expect(report.fields.onAsk.layers).toEqual(['client', 'daemon']);
    expect(report.fields.bypass.layers).toEqual(['client']);
  });

  it('has no layer for writeScope and network without a sandbox', () => {
    const report = build().guarantee(policy, { fields: [] });
    expect(report.fields.writeScope.layers).toEqual([]);
    expect(report.fields.network.layers).toEqual([]);
    expect(report.short).toEqual(['writeScope', 'network']);
    expect(report.ok).toBe(false);
  });

  it('is complete when the sandbox covers writeScope and network', () => {
    const report = build().guarantee(policy, { fields: ['writeScope', 'network'] });
    expect(report.ok).toBe(true);
    expect(report.fields.writeScope.layers).toEqual(['os']);
  });

  it('refuses to open a session without a sandbox, unless unenforced is allow', async () => {
    await expect(
      build({ sandbox: { fields: [] } }).openSession(profile, policy, '/w', via),
    ).rejects.toBeInstanceOf(PermissionDenied);
    expect(launcher.launched).toHaveLength(0);
    await build({ sandbox: { fields: [] }, unenforced: 'allow' }).openSession(
      profile,
      policy,
      '/w',
      via,
    );
    expect(launcher.launched).toHaveLength(1);
  });
});

describe('configOptionsFor', () => {
  it('maps model, effort and mode to the ids of the config options', () => {
    const adapter = build();
    expect(adapter.configOptionsFor({ model: 'sonnet' })).toEqual({ model: 'sonnet' });
    expect(adapter.configOptionsFor({ model: 'opus', effort: 'high', mode: 'plan' })).toEqual({
      model: 'opus',
      effort: 'high',
      mode: 'plan',
    });
    expect(adapter.configOptionsFor({ model: 'haiku', mode: 'acceptEdits' }).mode).toBe(
      'acceptEdits',
    );
  });

  it('refuses the modes that would skip layer 2 or are not in the catalog', () => {
    const adapter = build();
    for (const mode of ['bypassPermissions', 'dontAsk', 'auto']) {
      expect(() => adapter.configOptionsFor({ model: 'sonnet', mode })).toThrow(PermissionDenied);
    }
  });

  it('does not take Object.prototype names for refused modes', () => {
    expect(build().configOptionsFor({ model: 'sonnet', mode: 'constructor' }).mode).toBe(
      'constructor',
    );
  });
});

describe('conformance probes', () => {
  it('adds the sh -c probe to the conformance run only when it is configured', async () => {
    const without = await build().checkConformance(profile);
    expect(without.probes).toEqual([]);
    const probe = {
      transport: via,
      policy,
      prompt: 'ignored',
      timeoutMs: 10,
      scratchRoot: root,
    };
    const adapter = build({ probe, adapterVersion: 'probe-test' });
    const report = await adapter.checkConformance(profile);
    expect(report.probes.map((entry) => entry.id)).toEqual([SH_C_REJECT_PROBE_ID]);
  });

  it('versions the translation for the conformance cache', () => {
    expect(CLAUDE_CODE_ADAPTER_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
  });
});

describe('telemetry for the daemon (Phase 8, P3)', () => {
  const otel: ClientOtel = {
    endpoint: 'http://127.0.0.1:4318/',
    headers: { Authorization: 'Bearer tok-1' },
    resource: {
      'otheater.play_id': 'p1',
      'otheater.stage_id': 's1',
      'otheater.attempt_id': 'a1',
      'otheater.session_id': 'x1',
      'otheater.profile': 'claude-code/p',
      'otheater.client': 'claude-code',
    },
  };

  /** `_meta.claudeCode.options.env` of the one session opened. */
  function metaEnv(): Record<string, string> | undefined {
    const setup = via.opened[0]?.setup;
    if (setup?.via !== 'acp') throw new Error('expected an acp setup');
    const meta = setup.meta as { claudeCode: { options: { env?: Record<string, string> } } };
    return meta.claudeCode.options.env;
  }

  it('without otel, no variable is passed, in the session or in the process', async () => {
    await build().openSession(profile, policy, '/work', via);
    expect(metaEnv()).toBeUndefined();
    expect(JSON.stringify(via.opened[0]?.setup)).not.toContain('OTEL_');
    expect(
      Object.keys(launcher.launched[0]?.options.env ?? {}).some((k) => /OTEL|TELEMETRY/u.test(k)),
    ).toBe(false);
  });

  it('sends metrics and logs over OTLP/JSON to the receiver, with the token and the correlation', async () => {
    await build().openSession(profile, policy, '/work', via, { otel });
    expect(metaEnv()).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer tok-1',
      OTEL_RESOURCE_ATTRIBUTES:
        'otheater.attempt_id=a1,otheater.client=claude-code,otheater.play_id=p1,otheater.profile=claude-code/p,otheater.session_id=x1,otheater.stage_id=s1',
    });
  });

  it('sets the export interval of the metrics only when the daemon says one', async () => {
    await build().openSession(profile, policy, '/work', via, { otel });
    expect(metaEnv()).not.toHaveProperty('OTEL_METRIC_EXPORT_INTERVAL');
    via = new FakeSessionTransport({ id: 'acp' });
    await build().openSession(profile, policy, '/work', via, {
      otel: { ...otel, metricsIntervalMs: 5000 },
    });
    expect(metaEnv()).toMatchObject({ OTEL_METRIC_EXPORT_INTERVAL: '5000' });
  });

  it('puts nothing in the process environment: the variables belong to the session', async () => {
    await build().openSession(profile, policy, '/work', via, { otel });
    const env = launcher.launched[0]?.options.env ?? {};
    expect(Object.keys(env).filter((k) => /OTEL|TELEMETRY/u.test(k))).toEqual([]);
  });

  it('keeps the policy options of the session', async () => {
    await build().openSession(profile, policy, '/work', via, { otel });
    expect(via.opened[0]?.setup).toMatchObject({
      via: 'acp',
      configOptions: { mode: 'default' },
      meta: { claudeCode: { options: { tools: ['Read', 'Glob', 'Grep'], strictMcpConfig: true } } },
    });
  });

  it('never turns on the flags that put prompts or tool content in the logs', async () => {
    await build().openSession(profile, policy, '/work', via, { otel: { ...otel, traces: true } });
    expect(Object.keys(metaEnv() ?? {}).filter((k) => k.startsWith('OTEL_LOG_'))).toEqual([]);
  });

  it('traces are off by default and on with traces: true (the enhanced telemetry beta)', async () => {
    await build().openSession(profile, policy, '/work', via, { otel });
    expect(metaEnv()).not.toHaveProperty('OTEL_TRACES_EXPORTER');
    expect(metaEnv()).not.toHaveProperty('CLAUDE_CODE_ENHANCED_TELEMETRY_BETA');
    via = new FakeSessionTransport({ id: 'acp' });
    await build().openSession(profile, policy, '/work', via, { otel: { ...otel, traces: true } });
    expect(metaEnv()).toMatchObject({
      OTEL_TRACES_EXPORTER: 'otlp',
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    });
  });

  it('refuses an id that the resource format cannot carry, and never prints the token', async () => {
    const bad = { ...otel, resource: { 'otheater.play_id': 'a,b' } };
    const error = await build()
      .openSession(profile, policy, '/work', via, { otel: bad })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidInput);
    expect(String(error)).not.toContain('tok-1');
    expect(via.opened).toHaveLength(0);
  });

  it('on the headless transport the variables go in the environment of the process', async () => {
    const headless = new FakeSessionTransport({ id: 'headless' });
    await build().openSession(profile, policy, '/work', headless, { otel });
    const setup = headless.opened[0]?.setup;
    if (setup?.via !== 'headless') throw new Error('expected a headless setup');
    expect(setup.env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    });
  });
});
