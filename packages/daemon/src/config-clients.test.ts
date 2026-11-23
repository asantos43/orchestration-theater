// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDIRECT_MAX,
  DEFAULT_REGISTRY,
  DEFAULT_TAR_MAX_ENTRIES,
} from './adapters/install.js';
import {
  DEFAULT_ADAPTER_REDIRECT_MAX,
  DEFAULT_ADAPTER_REGISTRY,
  DEFAULT_ADAPTER_TAR_MAX_ENTRIES,
  parseConfig,
} from './config.js';

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
      adapter: 'managed',
      setting_sources: 'none',
      utilization_unit: 'ignore',
      quota_statusline: 'file',
      account_env: 'strip',
      model_catalog: 'session_or_reserve',
      model_catalog_cache: 300_000,
    });
    expect(clients.codex).toEqual({
      ...common,
      adapter: 'managed',
      process_model: 'multi-session',
      initial_mode: 'workspace-write',
      modes: ['read-only', 'workspace-write'],
      credentials_store: 'file',
      approval_policy: 'on-request',
      inner_sandbox: 'keep',
      suggested_effort: 'high',
      model_catalog: 'session',
      quota: { timeout: 15_000, watch: 'off', windows: [] },
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
        '    inner_sandbox: nested',
        '    modes: [read-only]',
        '    initial_mode: read-only',
        '    quota: { command: { cmd: /opt/codex, args: [app-server] }, timeout: 5s, watch: resident, windows: [5h] }',
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
      inner_sandbox: 'nested',
      modes: ['read-only'],
      initial_mode: 'read-only',
      quota: {
        command: { cmd: '/opt/codex', args: ['app-server'] },
        timeout: 5_000,
        watch: 'resident',
        windows: ['5h'],
      },
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
      ['clients:\n  codex:\n    inner_sandbox: both\n', /clients\.codex\.inner_sandbox/],
      ['clients:\n  codex:\n    modes: []\n', /clients\.codex\.modes/],
      ['clients:\n  codex:\n    quota: { watch: always }\n', /clients\.codex\.quota\.watch/],
      ['clients:\n  codex:\n    quota: { timeout: soon }\n', /clients\.codex\.quota\.timeout/],
      ['clients:\n  codex:\n    quota: { windows: [""] }\n', /clients\.codex\.quota\.windows/],
      ['clients:\n  codex:\n    quota: { speed: 1 }\n', /clients\.codex\.quota/],
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

describe('clients.adapters.* and clients.<id>.adapter (P13, N254 revised)', () => {
  it('installs by itself, from the npm registry, when nothing is written', () => {
    expect(parseConfig('').clients.adapters).toEqual({
      install: 'auto',
      registry: 'https://registry.npmjs.org',
      redirect_hosts: [],
      redirect_max: 3,
      tar_max_entries: 20_000,
    });
  });

  it("keeps the redirect and archive defaults of the config equal to the installer's", () => {
    expect(DEFAULT_ADAPTER_REDIRECT_MAX).toBe(DEFAULT_REDIRECT_MAX);
    expect(DEFAULT_ADAPTER_TAR_MAX_ENTRIES).toBe(DEFAULT_TAR_MAX_ENTRIES);
  });

  it('takes redirect_hosts, redirect_max (0 refuses every redirect) and tar_max_entries', () => {
    const { adapters } = parseConfig(
      'clients:\n  adapters:\n    redirect_hosts: [cdn.example.test, files.example.test]\n    redirect_max: 0\n    tar_max_entries: 500\n',
    ).clients;
    expect(adapters.redirect_hosts).toEqual(['cdn.example.test', 'files.example.test']);
    expect(adapters.redirect_max).toBe(0);
    expect(adapters.tar_max_entries).toBe(500);
  });

  it('refuses a redirect host with a scheme, a port, a path, a wildcard or upper case, and limits out of range', () => {
    for (const text of [
      'clients:\n  adapters:\n    redirect_hosts: ["https://cdn.example.test"]\n',
      'clients:\n  adapters:\n    redirect_hosts: ["cdn.example.test:8443"]\n',
      'clients:\n  adapters:\n    redirect_hosts: ["cdn.example.test/x"]\n',
      'clients:\n  adapters:\n    redirect_hosts: ["*.example.test"]\n',
      'clients:\n  adapters:\n    redirect_hosts: ["CDN.example.test"]\n',
      'clients:\n  adapters:\n    redirect_max: -1\n',
      'clients:\n  adapters:\n    redirect_max: 11\n',
      'clients:\n  adapters:\n    redirect_max: 1.5\n',
      'clients:\n  adapters:\n    tar_max_entries: 0\n',
      'clients:\n  adapters:\n    tar_max_entries: 1000001\n',
    ]) {
      expect(() => parseConfig(text), text).toThrow(InvalidInput);
    }
  });

  it("keeps the registry default of the config equal to the installer's", () => {
    expect(DEFAULT_ADAPTER_REGISTRY).toBe(DEFAULT_REGISTRY);
  });

  it.each(['auto', 'ask', 'command', 'off'])('accepts install: %s', (install) => {
    expect(
      parseConfig(`clients:\n  adapters:\n    install: ${install}\n`).clients.adapters.install,
    ).toBe(install);
  });

  it('refuses an unknown install mode, a registry that is not a URL and an unknown key', () => {
    for (const text of [
      'clients:\n  adapters:\n    install: sometimes\n',
      'clients:\n  adapters:\n    registry: not a url\n',
      'clients:\n  adapters:\n    mirror: x\n',
    ]) {
      expect(() => parseConfig(text)).toThrow(InvalidInput);
    }
  });

  it('takes a mirror registry', () => {
    const { adapters } = parseConfig(
      'clients:\n  adapters:\n    registry: https://npm.example.test/\n',
    ).clients;
    expect(adapters.registry).toBe('https://npm.example.test/');
  });

  it('gives claude-code and codex adapter: managed, and takes path or an absolute path', () => {
    const { clients } = parseConfig('');
    expect(clients['claude-code'].adapter).toBe('managed');
    expect(clients.codex.adapter).toBe('managed');
    const written = parseConfig(
      'clients:\n  claude-code:\n    adapter: path\n  codex:\n    adapter: /opt/acp/codex-acp\n',
    ).clients;
    expect(written['claude-code'].adapter).toBe('path');
    expect(written.codex.adapter).toBe('/opt/acp/codex-acp');
  });

  it('refuses a relative adapter and an empty one; opencode has no adapter key', () => {
    for (const text of [
      'clients:\n  codex:\n    adapter: bin/codex-acp\n',
      "clients:\n  codex:\n    adapter: ''\n",
      'clients:\n  opencode:\n    adapter: managed\n',
    ]) {
      expect(() => parseConfig(text)).toThrow(InvalidInput);
    }
  });
});
