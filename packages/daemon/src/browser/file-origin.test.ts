// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileOrigin, type FileRefusal } from './file-origin.js';

/**
 * No real secret path is read here: the "home" is a temporary folder, the secrets in it are made
 * up, and the list (`isSecret`) is a fake of this test, as `security.secret_paths` (P4) is injected.
 */
let home: string;
let work: string;
let origin: FileOrigin | undefined;
let refusals: FileRefusal[];

const fakeSecret =
  (root: string) =>
  (path: string): boolean =>
    path.startsWith(join(root, '.ssh')) || path.endsWith('.env');

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'otheater-fake-home-')));
  work = await realpath(await mkdtemp(join(tmpdir(), 'otheater-work-')));
  await mkdir(join(home, '.ssh'));
  await writeFile(join(home, '.ssh', 'id_fake'), 'FAKE-PRIVATE-KEY-DO-NOT-LEAK');
  await writeFile(join(home, 'notes.html'), '<h1>notes</h1>');
  await writeFile(join(work, 'page.html'), '<h1>page</h1><p>hi</p>');
  await writeFile(join(work, '.env'), 'TOKEN=fake');
  refusals = [];
  origin = undefined;
});

afterEach(async () => {
  await origin?.stop();
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

async function start(isSecret?: (path: string) => boolean): Promise<FileOrigin> {
  origin = await FileOrigin.start({
    isSecret,
    onRefused: (refusal) => refusals.push(refusal),
  });
  return origin;
}

async function get(url: string, init?: RequestInit): Promise<{ status: number; text: string }> {
  const response = await fetch(url, init);
  return { status: response.status, text: await response.text() };
}

describe('the file origin: what check allows', () => {
  it('opens a file of the worktree and any file with "any"', async () => {
    const files = await start(fakeSecret(home));
    files.grant('s1', { mode: 'except_secrets', roots: [] });
    await expect(files.check('s1', join(work, 'page.html'))).resolves.toMatchObject({ ok: true });
    await expect(files.check('s1', join(home, 'notes.html'))).resolves.toMatchObject({ ok: true });
    files.grant('s1', { mode: 'any', roots: [] });
    await expect(files.check('s1', join(home, '.ssh', 'id_fake'))).resolves.toMatchObject({
      ok: true,
    });
  });

  it('refuses a secret path with except_secrets, with the list of the fake', async () => {
    const files = await start(fakeSecret(home));
    files.grant('s1', { mode: 'except_secrets', roots: [] });
    const refused = await files.check('s1', join(home, '.ssh', 'id_fake'));
    expect(refused).toMatchObject({ ok: false, kind: 'refused', code: 'secret_path' });
    await expect(files.check('s1', join(work, '.env'))).resolves.toMatchObject({
      code: 'secret_path',
    });
    // a path that is not there says the same as one that is: the secret check comes first
    await expect(files.check('s1', join(home, '.ssh', 'nope'))).resolves.toMatchObject({
      code: 'secret_path',
    });
  });

  it('follows a link: a link in the worktree to a secret is refused by its real path', async () => {
    const files = await start(fakeSecret(home));
    files.grant('s1', { mode: 'except_secrets', roots: [] });
    await symlink(join(home, '.ssh', 'id_fake'), join(work, 'innocent.txt'));
    await expect(files.check('s1', join(work, 'innocent.txt'))).resolves.toMatchObject({
      ok: false,
      code: 'secret_path',
    });
  });

  it('fails closed: except_secrets without a list opens nothing, and a throwing list too', async () => {
    const without = await start();
    without.grant('s1', { mode: 'except_secrets', roots: [] });
    await expect(without.check('s1', join(work, 'page.html'))).resolves.toMatchObject({
      ok: false,
      code: 'secret_list_unavailable',
    });
    await without.stop();
    const broken = await start(() => {
      throw new Error('list broke');
    });
    broken.grant('s1', { mode: 'except_secrets', roots: [] });
    await expect(broken.check('s1', join(work, 'page.html'))).resolves.toMatchObject({
      ok: false,
      code: 'secret_check_failed',
    });
  });

  it('with "scenario" confines to the roots, links included', async () => {
    const files = await start();
    files.grant('s1', { mode: 'scenario', roots: [work] });
    await expect(files.check('s1', join(work, 'page.html'))).resolves.toMatchObject({ ok: true });
    await expect(files.check('s1', join(home, 'notes.html'))).resolves.toMatchObject({
      code: 'outside_scenario',
    });
    await symlink(join(home, 'notes.html'), join(work, 'out.html'));
    await expect(files.check('s1', join(work, 'out.html'))).resolves.toMatchObject({
      code: 'outside_scenario',
    });
  });

  it('with "deny" opens nothing; a scenario with no grant has no access', async () => {
    const files = await start(fakeSecret(home));
    files.grant('s1', { mode: 'deny', roots: [] });
    await expect(files.check('s1', join(work, 'page.html'))).resolves.toMatchObject({
      code: 'file_urls_denied',
    });
    await expect(files.check('other', join(work, 'page.html'))).resolves.toMatchObject({
      code: 'file_not_granted',
    });
  });

  it('answers not_found, not_a_file and invalid_path', async () => {
    const files = await start();
    files.grant('s1', { mode: 'any', roots: [] });
    await expect(files.check('s1', join(work, 'missing.html'))).resolves.toMatchObject({
      kind: 'not_found',
      code: 'file_not_found',
    });
    await expect(files.check('s1', work)).resolves.toMatchObject({ code: 'not_a_file' });
    await expect(files.check('s1', 'relative/x.html')).resolves.toMatchObject({
      code: 'invalid_path',
    });
  });
});

describe('the file origin: what it serves', () => {
  it('serves a granted file by the token of its scenario, and never lists a folder', async () => {
    const files = await start(fakeSecret(home));
    files.grant('s1', { mode: 'except_secrets', roots: [] });
    const url = files.urlFor('s1', join(work, 'page.html'));
    const got = await get(url);
    expect(got.status).toBe(200);
    expect(got.text).toContain('<h1>page</h1>');
    expect((await get(files.urlFor('s1', work))).status).toBe(403);
  });

  it('refuses a secret even when its URL is asked directly, and records the refusal', async () => {
    const files = await start(fakeSecret(home));
    files.grant('s1', { mode: 'except_secrets', roots: [] });
    const got = await get(files.urlFor('s1', join(home, '.ssh', 'id_fake')));
    expect(got.status).toBe(403);
    expect(got.text).not.toContain('FAKE-PRIVATE-KEY');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ scenarioId: 's1', code: 'secret_path' });
  });

  it('does not answer another token, a revoked one, a bad Host or a method that writes', async () => {
    const files = await start(fakeSecret(home));
    files.grant('s1', { mode: 'any', roots: [] });
    files.grant('s2', { mode: 'any', roots: [] });
    const url = files.urlFor('s1', join(work, 'page.html'));
    expect((await get(url)).status).toBe(200);
    expect((await get(url, { method: 'POST', body: 'x' })).status).toBe(405);
    expect((await get(url.replace(/\/files\/[^/]+\//, '/files/not-a-token/'))).status).toBe(404);
    expect((await get(`${files.origin}/files/`)).status).toBe(404);
    expect((await get(`${files.origin}/files/${'..%2f'.repeat(3)}etc`)).status).toBe(404);
    files.revoke('s1');
    expect((await get(url)).status).toBe(404);
    // the token of s2 does not open a file of s1's scope: each one has its own grant and token
    expect(files.judge('s2', new URL(url))).toBe('refused');
  });

  it('is on 127.0.0.1 only and answers a request with a foreign Host with 403', async () => {
    const files = await start();
    files.grant('s1', { mode: 'any', roots: [] });
    const url = new URL(files.urlFor('s1', join(work, 'page.html')));
    expect(url.hostname).toBe('127.0.0.1');
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: url.port,
          path: url.pathname,
          headers: { host: 'evil.example:80' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe('the file origin: the agent never sees the token', () => {
  it('writes a served URL back as file:/// and scrubs the text of a page', async () => {
    const files = await start();
    files.grant('s1', { mode: 'any', roots: [] });
    const served = files.urlFor('s1', '/tmp/x/a b.html', '?q=1#h');
    expect(files.presentUrl(served)).toBe('file:///tmp/x/a%20b.html?q=1#h');
    expect(files.presentUrl('https://example.com/files/abc/x')).toBe(
      'https://example.com/files/abc/x',
    );
    const token = served.split('/files/')[1]?.split('/')[0] ?? '';
    expect(token.length).toBeGreaterThan(20);
    const scrubbed = files.scrub(`see ${served} and ${files.urlFor('s1', '/tmp/y.html')}`);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toContain('file:///tmp/x/a%20b.html');
  });
});
