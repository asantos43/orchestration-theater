// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { SandboxRequest } from '@otheater/core';
import {
  allowedDomains,
  commandIdFor,
  filesystemRules,
  readDenies,
  shellLine,
  shellQuote,
} from './policy.js';

function request(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    launch: { cmd: 'client', args: ['--acp'], cwd: '/work/wt', env: { PATH: '/bin' } },
    policy: { writeScope: 'worktree', network: { allow: ['api.example.com'] } },
    worktree: '/work/wt',
    profileDirs: ['/data/profiles/claude/a'],
    extraWritePaths: ['/work/cache'],
    secretPaths: ['/home/u/.ssh', '/data', '.env', '.env.*'],
    domains: ['api.provider.com', 'api.example.com'],
    ...overrides,
  };
}

describe('filesystemRules', () => {
  it('writes only in the worktree, the profile folders, the extra folders and the own temp folder', () => {
    const rules = filesystemRules(request(), '/tmp/ot');
    expect(rules.allowWrite).toEqual([
      '/work/wt',
      '/data/profiles/claude/a',
      '/work/cache',
      '/tmp/ot',
    ]);
    expect(rules.denyWrite).toEqual([]);
  });

  it('denies the secret paths and anchors the bare names under the worktree and the extra folders', () => {
    const rules = filesystemRules(request(), '/tmp/ot');
    expect(rules.denyRead).toEqual([
      '/home/u/.ssh',
      '/data',
      '/work/wt/**/.env',
      '/work/cache/**/.env',
      '/work/wt/**/.env.*',
      '/work/cache/**/.env.*',
    ]);
  });

  it('reads again the profile folder that lies inside a secret path, and the worktree only if it does', () => {
    expect(filesystemRules(request(), '/tmp/ot').allowRead).toEqual(['/data/profiles/claude/a']);
    expect(
      filesystemRules(request({ worktree: '/data/worktrees/w1' }), '/tmp/ot').allowRead,
    ).toEqual(['/data/worktrees/w1', '/data/profiles/claude/a']);
  });

  it('does not repeat a path that is listed twice', () => {
    const rules = filesystemRules(request({ extraWritePaths: ['/work/wt', '/tmp/ot'] }), '/tmp/ot');
    expect(rules.allowWrite).toEqual(['/work/wt', '/data/profiles/claude/a', '/tmp/ot']);
  });
});

describe('readDenies', () => {
  it('tolerates a trailing slash and no roots', () => {
    expect(readDenies(['/a/b/', '.env'], [])).toEqual(['/a/b']);
    expect(readDenies(['.env'], ['/w/'])).toEqual(['/w/**/.env']);
  });
});

describe('allowedDomains', () => {
  it('joins the role policy and the daemon, once each', () => {
    expect(allowedDomains(request())).toEqual(['api.example.com', 'api.provider.com']);
    expect(
      allowedDomains(
        request({ policy: { writeScope: 'worktree', network: { allow: [] } }, domains: [] }),
      ),
    ).toEqual([]);
  });
});

describe('shell quoting', () => {
  it('quotes every word so nothing is read by the shell', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellLine('node', ['-e', 'a b; rm -rf /', '$(x)'])).toBe(
      `'node' '-e' 'a b; rm -rf /' '$(x)'`,
    );
  });
});

describe('commandIdFor', () => {
  const secret = Buffer.alloc(32, 7);

  it('is the same for the same request and long enough for the library (22 characters)', () => {
    const one = commandIdFor(secret, request(), '/tmp/ot');
    expect(commandIdFor(secret, request(), '/tmp/ot')).toBe(one);
    expect(one.length).toBeGreaterThanOrEqual(22);
    expect(one).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not depend on the order of the lists, but on the content', () => {
    const base = commandIdFor(secret, request(), '/tmp/ot');
    expect(
      commandIdFor(
        secret,
        request({ domains: ['api.example.com', 'api.provider.com'] }),
        '/tmp/ot',
      ),
    ).toBe(base);
    expect(commandIdFor(secret, request({ domains: [] }), '/tmp/ot')).not.toBe(base);
    expect(commandIdFor(secret, request({ worktree: '/work/other' }), '/tmp/ot')).not.toBe(base);
    expect(commandIdFor(secret, request({ secretPaths: [] }), '/tmp/ot')).not.toBe(base);
    expect(commandIdFor(Buffer.alloc(32, 8), request(), '/tmp/ot')).not.toBe(base);
  });

  it('ignores the command itself: the id is per worktree and policy, not per process', () => {
    const base = commandIdFor(secret, request(), '/tmp/ot');
    expect(
      commandIdFor(
        secret,
        request({ launch: { cmd: 'other', args: [], cwd: '/work/wt', env: {} } }),
        '/tmp/ot',
      ),
    ).toBe(base);
  });
});
