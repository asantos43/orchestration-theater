// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disposeTestGitIsolation } from './git-isolation.js';
import { testGit } from './vcs.js';

// The fixture helper of the Vcs suite: it must isolate git from the machine it runs on.
describe('testGit', () => {
  let dir: string;
  afterAll(disposeTestGitIsolation);
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'otheater-vcs-helper-')));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs git with a fixed identity, no signing, and returns stdout without the final newline', async () => {
    await testGit(dir, 'init', '--quiet', '--initial-branch=main');
    await writeFile(join(dir, 'a.txt'), 'a\n');
    await testGit(dir, 'add', '-A');
    await testGit(dir, 'commit', '--quiet', '-m', 'first');
    expect(await testGit(dir, 'log', '-1', '--format=%an <%ae>|%s')).toBe(
      'Conformance <conformance@localhost>|first',
    );
  });

  it('rejects with the stderr of a failing command', async () => {
    await expect(testGit(dir, 'rev-parse', 'HEAD')).rejects.toThrow(/not a git repository/);
  });
});
