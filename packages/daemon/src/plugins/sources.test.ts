// SPDX-License-Identifier: MPL-2.0
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidInput } from '@otheater/core';
import { assertGitUrl, childEnv, parseOrigin } from './sources.js';

describe('parseOrigin', () => {
  it('reads a folder, with or without "path:", against the working folder', () => {
    expect(parseOrigin('/opt/p', '/work')).toEqual({ source: 'path', path: '/opt/p' });
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
});
