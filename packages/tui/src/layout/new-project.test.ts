// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiRequestError } from '@otheater/client';
import { afterEach, describe, expect, it } from 'vitest';
import { gitRootOf, initialRepo, openFailure, resolveRepo } from './new-project.js';

const made: string[] = [];
afterEach(async () => {
  for (const folder of made.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'otheater-p22-unit-')));
  made.push(folder);
  return folder;
}

describe('resolveRepo', () => {
  it('keeps an absolute path and starts a relative one at the folder of the TUI', () => {
    expect(resolveRepo('/work/app', '/else')).toBe(resolve('/work/app'));
    expect(resolveRepo('../app', '/work/tui')).toBe(resolve('/work/app'));
    expect(resolveRepo('  sub  ', '/work')).toBe(resolve('/work/sub'));
  });

  it('expands the home folder', () => {
    expect(resolveRepo('~', '/work', '/home/x')).toBe('/home/x');
    expect(resolveRepo('~/app', '/work', '/home/x')).toBe(resolve('/home/x/app'));
  });

  it('leaves empty text empty', () => {
    expect(resolveRepo('   ', '/work')).toBe('');
  });
});

describe('initialRepo (ui.newProject.repo)', () => {
  it('starts with the folder of the TUI, with its git root, or with nothing', async () => {
    const root = await temp();
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'deep', 'er'), { recursive: true });
    const inside = join(root, 'deep', 'er');
    expect(initialRepo('cwd', inside)).toBe(inside);
    expect(initialRepo('git_root', inside)).toBe(root);
    expect(initialRepo('empty', inside)).toBe('');
  });

  it('keeps the folder when it is in no repository', async () => {
    const plain = await temp();
    expect(gitRootOf(plain)).toBe(plain);
  });
});

describe('openFailure', () => {
  const t = (key: string, params?: Record<string, string>): string =>
    `${key}|${JSON.stringify(params ?? {})}`;

  it('says the repository is bad when the daemon refused it', () => {
    const error = new ApiRequestError({
      status: 400,
      body: { code: 'invalid_input', message: 'not a repo' },
    });
    expect(openFailure(error, '/x', t)).toBe('layout.newProject.badRepo|{"repo":"/x"}');
  });

  it('carries the message of any other failure', () => {
    expect(openFailure(new Error('boom'), '/x', t)).toBe(
      'layout.newProject.failed|{"message":"boom"}',
    );
    expect(openFailure('plain', '/x', t)).toBe('layout.newProject.failed|{"message":"plain"}');
  });
});
