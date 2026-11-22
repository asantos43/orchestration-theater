// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  adapterVersionOf,
  buildClientEnv,
  MINIMAL_ENV_NAMES,
  pathFinder,
  searchPath,
  selectClients,
  type FindExecutable,
  type ManagedProbeFn,
} from './clients.js';
import { parseConfig } from './config.js';

const DEFAULTS = { 'claude-code': 'claude-agent-acp', codex: 'codex-acp', opencode: 'opencode' };

/** A fake file system: only these paths are executable files. */
function installed(...paths: string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path) => set.has(path);
}

describe('searchPath (a which in code; nothing is executed)', () => {
  it('returns the first directory of PATH that holds an executable of that name', () => {
    const isExecutable = installed('/b/tool', '/c/tool');
    expect(searchPath('tool', { path: '/a:/b:/c', platform: 'linux', isExecutable })).toBe(
      '/b/tool',
    );
  });

  it('finds nothing for an unset PATH, empty entries or a missing name', () => {
    const isExecutable = installed('/a/tool');
    expect(
      searchPath('tool', { path: undefined, platform: 'linux', isExecutable }),
    ).toBeUndefined();
    expect(searchPath('tool', { path: ':::', platform: 'linux', isExecutable })).toBeUndefined();
    expect(searchPath('other', { path: '/a', platform: 'linux', isExecutable })).toBeUndefined();
  });

  it('checks a command that has a separator as it is, without PATH', () => {
    const isExecutable = installed('/opt/x/tool');
    expect(searchPath('/opt/x/tool', { path: '/nowhere', platform: 'linux', isExecutable })).toBe(
      '/opt/x/tool',
    );
    expect(searchPath('/opt/y/tool', { path: '/opt/x', platform: 'linux', isExecutable })).toBe(
      undefined,
    );
  });

  it('tries the PATHEXT extensions on Windows', () => {
    const isExecutable = installed('C:\\bin\\tool.CMD');
    expect(
      searchPath('tool', {
        path: 'C:\\other;C:\\bin',
        platform: 'win32',
        pathExt: '.EXE;.CMD',
        isExecutable,
      }),
    ).toBe('C:\\bin\\tool.CMD');
  });

  it('pathFinder reads the PATH of the environment it is given, not the real one', () => {
    const find = pathFinder(
      { PATH: '/x:/y' },
      { platform: 'linux', isExecutable: installed('/y/opencode') },
    );
    expect(find('opencode')).toBe('/y/opencode');
    expect(find('codex-acp')).toBeUndefined();
  });
});

describe('selectClients', () => {
  const none: FindExecutable = () => undefined;
  const only =
    (...names: string[]): FindExecutable =>
    (command) =>
      names.includes(command) ? `/bin/${command}` : undefined;

  it('with auto, turns on exactly the clients whose default executable is found', () => {
    const selection = selectClients(parseConfig(''), DEFAULTS, only('codex-acp'));
    expect(selection.map((s) => [s.id, s.enabled, s.reason])).toEqual([
      ['claude-code', false, 'not_found'],
      ['codex', true, 'found_in_path'],
      ['opencode', false, 'not_found'],
    ]);
    expect(selection[1]?.resolvedPath).toBe('/bin/codex-acp');
  });

  it('with auto, a configured command turns the client on without searching', () => {
    const [claude, codex] = selectClients(
      parseConfig('clients:\n  claude-code:\n    command: { cmd: /opt/claude-acp }\n'),
      DEFAULTS,
      none,
    );
    expect(claude).toMatchObject({
      enabled: true,
      reason: 'command_configured',
      executable: '/opt/claude-acp',
    });
    expect(codex?.enabled).toBe(false);
  });

  it('false wins over a command and over a found executable', () => {
    const config = parseConfig(
      'clients:\n  codex:\n    enabled: false\n    command: { cmd: codex-acp }\n  opencode:\n    enabled: false\n',
    );
    const selection = selectClients(config, DEFAULTS, only('codex-acp', 'opencode'));
    expect(selection.filter((s) => s.enabled)).toEqual([]);
    expect(selection.map((s) => s.reason)).toEqual(['not_found', 'disabled', 'disabled']);
  });

  it('true turns a client on even when nothing is found, and says so', () => {
    const [, , opencode] = selectClients(
      parseConfig('clients:\n  opencode:\n    enabled: true\n'),
      DEFAULTS,
      none,
    );
    expect(opencode).toMatchObject({ enabled: true, reason: 'forced_not_found' });
  });
});

describe('selectClients with the managed adapters (P13)', () => {
  const only =
    (...names: string[]): FindExecutable =>
    (command) =>
      names.includes(command) ? `/bin/${command}` : undefined;
  const probe =
    (state: { installed?: boolean; official?: string; byItself?: boolean }): ManagedProbeFn =>
    (id) =>
      id === 'opencode'
        ? undefined
        : {
            entry: `/data/adapters/${id}/index.js`,
            installed: state.installed ?? false,
            officialPath: state.official,
            installsByItself: state.byItself ?? true,
          };

  it('turns a client on when its managed adapter is installed, without the official client or PATH', () => {
    const [claude] = selectClients(parseConfig(''), DEFAULTS, only(), probe({ installed: true }));
    expect(claude).toMatchObject({
      enabled: true,
      reason: 'managed_installed',
      executable: '/data/adapters/claude-code/index.js',
    });
  });

  it('turns it on while the install is pending when the official client is in PATH and install is auto', () => {
    const [claude, codex] = selectClients(
      parseConfig(''),
      DEFAULTS,
      only(),
      probe({ official: '/bin/claude' }),
    );
    expect(claude).toMatchObject({ enabled: true, reason: 'managed_pending' });
    expect(codex).toMatchObject({ enabled: true, reason: 'managed_pending' });
  });

  it('leaves it off, with its own reason, when nothing installs by itself', () => {
    const [claude] = selectClients(
      parseConfig(''),
      DEFAULTS,
      only(),
      probe({ official: '/bin/claude', byItself: false }),
    );
    expect(claude).toMatchObject({ enabled: false, reason: 'adapter_missing' });
  });

  it('on a missing adapter, enabled: true still forces it on and says it will fail', () => {
    const [claude] = selectClients(
      parseConfig('clients:\n  claude-code:\n    enabled: true\n'),
      DEFAULTS,
      only(),
      probe({ official: '/bin/claude', byItself: false }),
    );
    expect(claude).toMatchObject({ enabled: true, reason: 'forced_not_found' });
  });

  it('without the official client and without the adapter nothing turns on', () => {
    const [claude] = selectClients(parseConfig(''), DEFAULTS, only(), probe({}));
    expect(claude).toMatchObject({ enabled: false, reason: 'not_found' });
  });

  it('an adapter in PATH still turns the client on (the fallback of "managed")', () => {
    const [claude] = selectClients(parseConfig(''), DEFAULTS, only('claude-agent-acp'), probe({}));
    expect(claude).toMatchObject({ enabled: true, reason: 'found_in_path' });
  });

  it('an absolute adapter turns the client on and is not probed', () => {
    const [claude, codex] = selectClients(
      parseConfig('clients:\n  claude-code:\n    adapter: /opt/acp/claude.js\n'),
      DEFAULTS,
      only(),
      probe({ installed: true }),
    );
    expect(claude).toMatchObject({
      enabled: true,
      reason: 'adapter_configured',
      executable: '/opt/acp/claude.js',
    });
    expect(codex?.reason).toBe('managed_installed');
  });

  it('adapter: path ignores the managed one', () => {
    const [claude] = selectClients(
      parseConfig('clients:\n  claude-code:\n    adapter: path\n'),
      DEFAULTS,
      only(),
      probe({ installed: true, official: '/bin/claude' }),
    );
    expect(claude).toMatchObject({ enabled: false, reason: 'not_found' });
  });

  it('enabled: false wins over everything', () => {
    const [claude] = selectClients(
      parseConfig('clients:\n  claude-code:\n    enabled: false\n'),
      DEFAULTS,
      only(),
      probe({ installed: true }),
    );
    expect(claude).toMatchObject({ enabled: false, reason: 'disabled' });
  });
});

describe('buildClientEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'C.UTF-8',
    HTTPS_PROXY: 'http://proxy:3128',
    ANTHROPIC_API_KEY: 'sk-not-real',
    OPENAI_API_KEY: 'sk-not-real-either',
    CUSTOM: 'x',
  };
  const base = { env_inherit: 'minimal', env_allow: [], env: {} } as const;

  it('minimal passes the run-time variables and no credential', () => {
    const env = buildClientEnv(base, source);
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
    });
    expect(Object.keys(env).every((name) => MINIMAL_ENV_NAMES.includes(name))).toBe(true);
  });

  it('none starts empty, and env_allow and env add on top (env last)', () => {
    expect(buildClientEnv({ ...base, env_inherit: 'none' }, source)).toEqual({});
    expect(
      buildClientEnv(
        {
          env_inherit: 'none',
          env_allow: ['CUSTOM', 'NOT_SET'],
          env: { HOME: '/elsewhere', EXTRA: '1' },
        },
        { ...source, HOME: '/home/u' },
      ),
    ).toEqual({ CUSTOM: 'x', HOME: '/elsewhere', EXTRA: '1' });
  });

  it('all passes every defined variable of the daemon', () => {
    const env = buildClientEnv({ ...base, env_inherit: 'all' }, { ...source, UNSET: undefined });
    expect(Object.keys(env).sort()).toEqual(Object.keys(source).sort());
  });
});

describe('adapterVersionOf', () => {
  it('joins the adapter version and the client version', () => {
    expect(adapterVersionOf('0.1.0', 'codex', '0.139.0')).toBe('0.1.0+codex.0.139.0');
    expect(adapterVersionOf('0.1.0', 'claude-code', 'unknown')).toBe('0.1.0+claude-code.unknown');
  });
});
