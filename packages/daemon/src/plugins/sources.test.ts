// SPDX-License-Identifier: MPL-2.0
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidInput } from '@otheater/core';
import { assertGitUrl, childEnv, parseOrigin, resolveNpmCommand } from './sources.js';

describe('parseOrigin', () => {
  it('reads a folder, with or without "path:", against the working folder', () => {
    expect(parseOrigin('/opt/p', '/work')).toEqual({ source: 'path', path: resolve('/opt/p') });
    expect(parseOrigin('path:../p', '/work/x')).toEqual({
      source: 'path',
      path: resolve('/work/x', '../p'),
    });
    expect(parseOrigin('./p', '/work')).toEqual({ source: 'path', path: resolve('/work', 'p') });
  });

  it('reads npm:<package>@<exact version>, scoped or not', () => {
    expect(parseOrigin('npm:demo-db@1.2.3', '/')).toEqual({
      source: 'npm',
      name: 'demo-db',
      version: '1.2.3',
    });
    expect(parseOrigin('npm:@acme/demo@2.0.0-rc.1', '/')).toEqual({
      source: 'npm',
      name: '@acme/demo',
      version: '2.0.0-rc.1',
    });
  });

  it('refuses ranges, tags, missing versions and odd package names', () => {
    for (const text of [
      'npm:demo-db',
      'npm:demo-db@latest',
      'npm:demo-db@^1.0.0',
      'npm:demo-db@1.2',
      'npm:demo-db@v1.2.3',
      'npm:Demo@1.0.0',
      'npm:../x@1.0.0',
      'npm:-x@1.0.0',
      'npm:https://example.com/x.tgz@1.0.0',
    ]) {
      expect(() => parseOrigin(text, '/'), text).toThrow(InvalidInput);
    }
  });

  it('reads git:<url>#<ref>, the ref being optional', () => {
    expect(parseOrigin('git:https://example.com/a/b.git#v1.0.0', '/')).toEqual({
      source: 'git',
      url: 'https://example.com/a/b.git',
      ref: 'v1.0.0',
    });
    expect(parseOrigin('git:file:///srv/repo', '/')).toEqual({
      source: 'git',
      url: 'file:///srv/repo',
      ref: undefined,
    });
  });

  it('refuses a ref that git could take as an option or a path trick', () => {
    for (const ref of ['-x', '--upload-pack=sh', 'a..b', 'a b', 'main.lock', '']) {
      expect(() => parseOrigin(`git:https://example.com/a.git#${ref}`, '/'), ref).toThrow(
        InvalidInput,
      );
    }
  });

  it('refuses an empty origin', () => {
    expect(() => parseOrigin('', '/')).toThrow(InvalidInput);
    expect(() => parseOrigin('path:', '/')).toThrow(InvalidInput);
  });
});

describe('assertGitUrl', () => {
  it('accepts https, ssh, scp style and file', () => {
    for (const url of [
      'https://example.com/a/b.git',
      'ssh://git@example.com/a/b.git',
      'git@example.com:a/b.git',
      'file:///srv/repo',
    ]) {
      expect(() => {
        assertGitUrl(url);
      }, url).not.toThrow();
    }
  });

  it('refuses what runs a command, has no encryption, or is an option', () => {
    for (const url of [
      'ext::sh -c "touch /tmp/x"',
      'http://example.com/a.git',
      'git://example.com/a.git',
      '--upload-pack=touch /tmp/x',
      '-oProxyCommand=x',
      'https://user:secret@example.com/a.git',
      'https://example.com/a b.git',
      'fd::17/foo',
      '',
      '/plain/path',
    ]) {
      expect(() => {
        assertGitUrl(url);
      }, url).toThrow(InvalidInput);
    }
  });
});

describe('childEnv', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    OPENAI_API_KEY: 'sk-secret',
    ANTHROPIC_API_KEY: 'sk-secret',
    GITHUB_TOKEN: 'ghp_secret',
    NODE_OPTIONS: '--require ./evil.js',
    GIT_SSH_COMMAND: 'sh -c evil',
    GIT_TEMPLATE_DIR: '/evil',
    npm_config_registry: 'http://127.0.0.1:1/',
    npm_config__authToken: 'secret',
    UNDEFINED: undefined,
  };

  it('keeps the short list and, for npm only, its own settings', () => {
    const npm = childEnv(base, 'npm');
    expect(npm.PATH).toBe('/usr/bin');
    expect(npm.HOME).toBe('/home/x');
    expect(npm.npm_config_registry).toBe('http://127.0.0.1:1/');
    expect(Object.keys(npm).some((key) => /KEY|TOKEN|NODE_OPTIONS|GIT_/.test(key))).toBe(false);

    const git = childEnv(base, 'git', { GIT_TERMINAL_PROMPT: '0' });
    expect(Object.keys(git).sort()).toEqual(['GIT_TERMINAL_PROMPT', 'HOME', 'PATH']);
  });

  it('on Windows compares the names with no regard to case and writes them as in the list', () => {
    const windows = {
      Path: 'C:\\Windows',
      PathExt: '.EXE;.CMD',
      systemroot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\cmd.exe',
      Temp: 'C:\\t',
      UserProfile: 'C:\\Users\\x',
      openai_api_key: 'sk-secret',
      OPENAI_API_KEY: 'sk-secret',
      github_token: 'ghp_secret',
      Node_Options: '--require ./evil.js',
      NPM_CONFIG_REGISTRY: 'http://127.0.0.1:1/',
    };
    const npm = childEnv(windows, 'npm', {}, 'win32');
    expect(npm).toEqual({
      PATH: 'C:\\Windows',
      PATHEXT: '.EXE;.CMD',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\cmd.exe',
      TEMP: 'C:\\t',
      USERPROFILE: 'C:\\Users\\x',
      NPM_CONFIG_REGISTRY: 'http://127.0.0.1:1/',
    });
    expect(
      Object.keys(childEnv(windows, 'git', {}, 'win32')).some((k) => /npm_config/i.test(k)),
    ).toBe(false);
    // The same variable in two spellings is written once.
    expect(childEnv({ Path: 'a', PATH: 'b' }, 'git', {}, 'win32')).toEqual({ PATH: 'a' });
  });

  it('elsewhere keeps the names exact: a different case is another variable, and out', () => {
    expect(childEnv({ Path: 'a', PATH: 'b', systemroot: 'c' }, 'npm', {}, 'linux')).toEqual({
      PATH: 'b',
    });
  });
});

describe('resolveNpmCommand', () => {
  const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
  const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

  it('is plain npm outside Windows, with no lookup of files', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(
        resolveNpmCommand({
          platform,
          execPath: '/usr/bin/node',
          exists: () => {
            throw new Error('no file lookup');
          },
        }),
      ).toEqual({ file: 'npm', prefix: [] });
    }
  });

  it('on Windows runs node on the npm-cli.js next to it, with no shell and no npm.cmd', () => {
    const looked: string[] = [];
    const found = resolveNpmCommand({
      platform: 'win32',
      execPath: nodeExe,
      exists: (path) => {
        looked.push(path);
        return path === cli;
      },
    });
    expect(found).toEqual({ file: nodeExe, prefix: [cli] });
    expect(looked).toEqual([cli]);
  });

  it('on Windows says where it looked when npm is not next to node', () => {
    expect(() =>
      resolveNpmCommand({ platform: 'win32', execPath: nodeExe, exists: () => false }),
    ).toThrow(/npm was not found next to node \(.*npm-cli\.js\).*plugins\.install\.npm/);
  });

  it('takes the configured npm: a .js runs on node, a program is started as it is', () => {
    const exists = (): boolean => true;
    expect(
      resolveNpmCommand({
        configured: '/opt/npm/bin/npm-cli.js',
        platform: 'linux',
        execPath: '/usr/bin/node',
        exists,
      }),
    ).toEqual({ file: '/usr/bin/node', prefix: ['/opt/npm/bin/npm-cli.js'] });
    expect(
      resolveNpmCommand({ configured: '/opt/bin/pnpm-npm', platform: 'linux', exists }),
    ).toEqual({ file: '/opt/bin/pnpm-npm', prefix: [] });
    // A bare name is left to PATH.
    expect(
      resolveNpmCommand({ configured: 'npm10', platform: 'win32', exists: () => false }),
    ).toEqual({ file: 'npm10', prefix: [] });
    expect(resolveNpmCommand({ configured: 'auto', platform: 'linux' })).toEqual({
      file: 'npm',
      prefix: [],
    });
  });

  it('refuses a configured path that does not exist', () => {
    expect(() =>
      resolveNpmCommand({ configured: '/nope/npm-cli.js', platform: 'linux', exists: () => false }),
    ).toThrow(/does not exist/);
  });
});
