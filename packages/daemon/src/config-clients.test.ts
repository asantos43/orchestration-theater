// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

describe('clients.* and security.* of the config', () => {
  it('gives the defaults of every client when nothing is written', () => {
    const { clients, security } = parseConfig('');
    const common = {
      enabled: 'auto',
      client_version: 'unknown',
      version_source: 'auto',
      env_inherit: 'minimal',
      env_allow: [],
      env: {},
    };
    expect(clients['claude-code']).toEqual({
      ...common,
      setting_sources: 'none',
      utilization_unit: 'ignore',
      account_env: 'strip',
      model_catalog: 'session_or_reserve',
      model_catalog_cache: 300_000,
    });
    expect(clients.codex).toEqual({
      ...common,
      process_model: 'multi-session',
      initial_mode: 'workspace-write',
      modes: ['read-only', 'workspace-write'],
      credentials_store: 'file',
      approval_policy: 'on-request',
      suggested_effort: 'high',
      model_catalog: 'session',
    });
    expect(clients.opencode).toEqual({
      ...common,
      isolation: ['data', 'config', 'state'],
      shell_keys: ['bash'],
      internal_tools: ['todowrite', 'todoread'],
      project_config: 'disabled',
      read_only_mode: 'none',
      models_cache: 60_000,
      suggest: { effort_preference: ['medium', 'low', 'high'] },
      context_severity: 'warning',
      permission_probe: { timeout: 120_000 },
      slot_timeout: 30_000,
    });
    expect(security).toEqual({
      min_layers: { default: 1 },
      unenforced: 'refuse',
      conformance: 'on_version_change',
      catalog_probe: 'allow',
      catalog_probe_log: 'once',
      secret_paths: { add: [], remove: [] },
    });
  });

  it('reads version_source in its four modes and version_packages, and refuses the rest', () => {
    for (const mode of ['auto', 'package_json', 'initialize', 'config']) {
      const { clients } = parseConfig(`clients:\n  codex:\n    version_source: ${mode}\n`);
      expect(clients.codex.version_source).toBe(mode);
    }
    const { clients } = parseConfig(
      'clients:\n  opencode:\n    version_packages: [opencode-ai, other-pkg]\n',
    );
    expect(clients.opencode.version_packages).toEqual(['opencode-ai', 'other-pkg']);
    expect(parseConfig('').clients.opencode.version_packages).toBeUndefined();
    expect(() => parseConfig('clients:\n  codex:\n    version_source: guess\n')).toThrow(
      InvalidInput,
    );
    expect(() => parseConfig('clients:\n  codex:\n    version_packages: []\n')).toThrow(
      InvalidInput,
    );
  });

  it('keeps `command` unset by default and reads cmd with or without args', () => {
    const config = parseConfig(
      [
        'clients:',
        '  codex:',
        '    command: { cmd: /opt/bin/codex-acp }',
        '  opencode:',
        '    command: { cmd: opencode, args: [acp, --pure] }',
      ].join('\n'),
    );
    expect(config.clients['claude-code'].command).toBeUndefined();
    expect(config.clients.codex.command).toEqual({ cmd: '/opt/bin/codex-acp' });
    expect(config.clients.opencode.command).toEqual({ cmd: 'opencode', args: ['acp', '--pure'] });
  });

  it('reads the three values of enabled and the version, environment and per-client keys', () => {
    const config = parseConfig(
      [
        'clients:',
        '  claude-code:',
        '    enabled: false',
        '    setting_sources: project',
        '    model_catalog: reserve',
        '    model_catalog_cache: 0',
        '  codex:',
        '    enabled: true',
        '    client_version: 0.139.0',
        '    env_inherit: none',
        '    env_allow: [HTTPS_PROXY]',
        '    env: { RUST_LOG: warn }',
        '    process_model: process-per-session',
        '    credentials_store: keyring',
        '    modes: [read-only]',
        '    initial_mode: read-only',
        '  opencode:',
        '    enabled: auto',
        '    isolation: [data, config, state, cache]',
        '    profile_config: null',
        '    models_cache: 5m',
        '    min_context_window: 64000',
        '    context_severity: error',
        '    permission_probe: { model: provider/small, timeout: 30s }',
      ].join('\n'),
    );
    expect(config.clients['claude-code']).toMatchObject({
      enabled: false,
      setting_sources: 'project',
      model_catalog: 'reserve',
      model_catalog_cache: 0,
    });
    expect(config.clients.codex).toMatchObject({
      enabled: true,
      client_version: '0.139.0',
      env_inherit: 'none',
      env_allow: ['HTTPS_PROXY'],
      env: { RUST_LOG: 'warn' },
      process_model: 'process-per-session',
      credentials_store: 'keyring',
      modes: ['read-only'],
      initial_mode: 'read-only',
    });
    expect(config.clients.opencode).toMatchObject({
      isolation: ['data', 'config', 'state', 'cache'],
      profile_config: null,
      models_cache: 300_000,
      min_context_window: 64_000,
      context_severity: 'error',
      permission_probe: { model: 'provider/small', timeout: 30_000 },
    });
  });

  it('reads security with the per-field minimum layers', () => {
    const { security } = parseConfig(
      'security:\n  min_layers: { default: 2, writeScope: 0 }\n  unenforced: warn\n  conformance: every_start\n',
    );
    expect(security).toEqual({
      min_layers: { default: 2, writeScope: 0 },
      unenforced: 'warn',
      conformance: 'every_start',
      catalog_probe: 'allow',
      catalog_probe_log: 'once',
      secret_paths: { add: [], remove: [] },
    });
  });

  it('takes security.min_layers.mcpTools, the field the tool list added to the policy', () => {
    expect(parseConfig('security:\n  min_layers: { mcpTools: 2 }\n').security.min_layers).toEqual({
      default: 1,
      mcpTools: 2,
    });
    expect(() => parseConfig('security:\n  min_layers: { mcpTools: -1 }\n')).toThrow(
      /security\.min_layers\.mcpTools/,
    );
  });

  it('has an empty roles block by default and refuses an unknown role', () => {
    expect(parseConfig('').roles).toEqual({});
    expect(() => parseConfig('roles:\n  nobody:\n    policy: {}\n', 'config.yaml')).toThrow(
      InvalidInput,
    );
  });

  it('keeps pool.opencode.process_model next to the clients', () => {
    expect(parseConfig('').pool.opencode.process_model).toBe('per_profile');
    expect(
      parseConfig('pool:\n  opencode:\n    process_model: per_session\n').pool.opencode,
    ).toEqual({ sessions_per_process: 4, session_mb: 520, process_model: 'per_session' });
  });

  it('names the key of every mistake', () => {
    const cases: [string, RegExp][] = [
      ['clients:\n  gemini: {}\n', /clients/],
      ['clients:\n  codex:\n    commmand: x\n', /clients\.codex/],
      ['clients:\n  codex:\n    enabled: maybe\n', /clients\.codex\.enabled/],
      ['clients:\n  codex:\n    command: codex-acp\n', /clients\.codex\.command/],
      ['clients:\n  codex:\n    command: { cmd: "" }\n', /clients\.codex\.command\.cmd/],
      ['clients:\n  codex:\n    credentials_store: cloud\n', /clients\.codex\.credentials_store/],
      ['clients:\n  codex:\n    process_model: per_profile\n', /clients\.codex\.process_model/],
      ['clients:\n  codex:\n    modes: []\n', /clients\.codex\.modes/],
      ['clients:\n  codex:\n    env_inherit: some\n', /clients\.codex\.env_inherit/],
      ['clients:\n  codex:\n    env_allow: ["A B"]\n', /clients\.codex\.env_allow/],
      ['clients:\n  codex:\n    env: { "1X": a }\n', /clients\.codex\.env/],
      ['clients:\n  claude-code:\n    account_env: copy\n', /clients\.claude-code\.account_env/],
      ['clients:\n  claude-code:\n    model_catalog_cache: soon\n', /model_catalog_cache/],
      ['clients:\n  opencode:\n    isolation: [home]\n', /clients\.opencode\.isolation/],
      ['clients:\n  opencode:\n    models_cache: -1\n', /clients\.opencode\.models_cache/],
      ['clients:\n  opencode:\n    min_context_window: 0\n', /min_context_window/],
      ['security:\n  catalog_probe: maybe\n', /security\.catalog_probe/],
      ['security:\n  catalog_probe_log: sometimes\n', /security\.catalog_probe_log/],
      ['security:\n  unenforced: ignore\n', /security\.unenforced/],
      ['security:\n  conformance: sometimes\n', /security\.conformance/],
      ['security:\n  min_layers: { default: -1 }\n', /security\.min_layers\.default/],
      ['security:\n  min_layers: { filesystem: 1 }\n', /security\.min_layers/],
    ];
    for (const [text, pattern] of cases) {
      expect(() => parseConfig(text, 'config.yaml'), text).toThrow(InvalidInput);
      expect(() => parseConfig(text, 'config.yaml'), text).toThrow(pattern);
    }
  });
});
