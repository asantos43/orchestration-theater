// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import type { InspectFolderResult } from '@otheater/protocol';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { startDaemon, type DaemonHandle } from '../../daemon.js';
import { dataPaths } from '../../paths.js';
import { captureLogger, makeTempDataDir, NO_CLIENTS } from '../../test-helpers.js';

/**
 * `POST /v1/folders/inspect` (N332), against the daemon as it starts (fake clock, in-memory store
 * and vault, no client) and a real `git` in a temp folder. The open with `init` needs the plays and
 * is in `command-routes.e2e.test.ts`.
 */

afterAll(disposeTestGitIsolation);

let tmp: Awaited<ReturnType<typeof makeTempDataDir>>;
let work: string;
let daemon: DaemonHandle;
let token: string;

async function start(config: string): Promise<void> {
  const clock = new FakeClock();
  daemon = await startDaemon({
    dataDir: tmp.dir,
    clientSearch: NO_CLIENTS,
    config: parseConfig(`backup:\n  when: manual\nprocesses:\n  windows_launcher: off\n${config}`),
    overrides: {
      clock,
      vault: new InMemorySecretVault(),
      store: new InMemoryStore({ clock }),
      launcherDeps: { platform: 'win32' },
    },
    logger: captureLogger().logger,
    version: '0.0.0-test',
  });
  token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
}

async function inspect(
  path: unknown,
  auth = true,
): Promise<{ status: number; json: unknown; text: string }> {
  const response = await fetch(`${daemon.api.url}/v1/folders/inspect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ path }),
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as unknown };
}

beforeEach(async () => {
  tmp = await makeTempDataDir();
  work = await realpath(await mkdtemp(join(tmpdir(), 'otheater-folders-')));
});

afterEach(async () => {
  await daemon.stop();
  await tmp.dispose();
  await rm(work, { recursive: true, force: true });
});

describe('POST /v1/folders/inspect (N332)', () => {
  it('tells the five states of a folder, with the repository and the initMode', async () => {
    await start('');
    const files = join(work, 'files');
    await mkdir(files);
    await writeFile(join(files, 'a.txt'), 'a\n');
    const empty = join(work, 'empty');
    await mkdir(empty);
    const repo = join(work, 'repo');
    await mkdir(join(repo, 'sub'), { recursive: true });
    await testGit(repo, 'init', '--quiet', '--initial-branch=main');
    const missing = join(work, 'nothing');

    const answers = new Map<string, InspectFolderResult>();
    for (const [name, path] of [
      ['missing', missing],
      ['empty', empty],
      ['files', files],
      ['repo', repo],
      ['inside', join(repo, 'sub')],
    ] as const) {
      const answer = await inspect(path);
      expect(answer.status, answer.text).toBe(200);
      answers.set(name, answer.json as InspectFolderResult);
    }
    expect(answers.get('missing')).toEqual({
      path: missing,
      state: 'missing',
      git: null,
      initMode: 'ask',
    });
    expect(answers.get('empty')).toMatchObject({ path: empty, state: 'empty', git: null });
    expect(answers.get('files')).toMatchObject({ path: files, state: 'files', git: null });
    expect(answers.get('repo')).toEqual({
      path: repo,
      state: 'repo',
      git: { root: repo, branch: 'main' },
      initMode: 'ask',
    });
    expect(answers.get('inside')).toMatchObject({
      path: join(repo, 'sub'),
      state: 'inside_repo',
      git: { root: repo, branch: 'main' },
    });
  });

  it('shows the projects.init.mode in force', async () => {
    await start('projects:\n  init:\n    mode: commit_all\n');
    const answer = await inspect(work);
    expect(answer.status, answer.text).toBe(200);
    expect((answer.json as InspectFolderResult).initMode).toBe('commit_all');
  });

  it('answers 400 invalid_input to a path that is a file, and to a body without a path', async () => {
    await start('');
    const file = join(work, 'file.txt');
    await writeFile(file, 'x\n');
    const answer = await inspect(file);
    expect(answer.status, answer.text).toBe(400);
    expect((answer.json as { error: { code: string } }).error.code).toBe('invalid_input');
    const empty = await inspect('');
    expect(empty.status).toBe(400);
  });

  it('asks for the token', async () => {
    await start('');
    const answer = await inspect(work, false);
    expect(answer.status).toBe(401);
  });
});
