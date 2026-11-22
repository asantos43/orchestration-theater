// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UpdateStop } from './errors.js';
import { FakeOrigin, TEST_ORIGIN } from './release-fixture.js';
import { createUpdateSource, isAllowedUpdateUrl, type FetchFunction } from './source.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ot-source-'));
  dirs.push(dir);
  return dir;
}

function addressOf(input: Parameters<FetchFunction>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

async function stopOf(promise: Promise<unknown>): Promise<UpdateStop> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UpdateStop) return error;
    throw error;
  }
  throw new Error('it did not stop');
}

describe('the addresses', () => {
  it.each([
    ['https://example.com/a/', true],
    ['http://127.0.0.1:8080/a/', true],
    ['http://localhost/a/', true],
    ['http://[::1]:9/a/', true],
    ['http://example.com/a/', false],
    ['https://user:pass@example.com/', false],
    ['ftp://example.com/', false],
    ['file:///etc/passwd', false],
  ])('%s is allowed: %s', (address, allowed) => {
    expect(isAllowedUpdateUrl(new URL(address))).toBe(allowed);
  });
});

describe('the origin of kind url', () => {
  it('reads the manifest and the signature, and says where the files are', async () => {
    const origin = new FakeOrigin();
    origin.files.set(`${TEST_ORIGIN}manifest.json`, '{"a":1}');
    origin.files.set(`${TEST_ORIGIN}manifest.json.sig`, 'c2ln\n');
    const source = createUpdateSource(
      { kind: 'url', url: 'https://updates.test/releases' },
      { fetch: origin.fetch },
    );
    const files = await source.fetchRelease('stable');
    expect(Buffer.from(files?.manifest ?? []).toString()).toBe('{"a":1}');
    expect(files?.signature).toBe('c2ln\n');
    expect(files?.fileUrl('a b')).toBe(`${TEST_ORIGIN}a%20b`);
  });

  it('a missing file, a server error and a network that is down are told apart', async () => {
    const origin = new FakeOrigin();
    const source = createUpdateSource({ kind: 'url', url: TEST_ORIGIN }, { fetch: origin.fetch });
    expect((await stopOf(source.fetchRelease('stable'))).reason).toBe('bad_response');
    origin.files.set(`${TEST_ORIGIN}manifest.json`, 503);
    expect((await stopOf(source.fetchRelease('stable'))).reason).toBe('bad_response');
    origin.down = true;
    expect((await stopOf(source.fetchRelease('stable'))).reason).toBe('no_network');
  });

  it('sends no credential and no cookie, and only the headers it needs', async () => {
    const seen: RequestInit[] = [];
    const fetcher: FetchFunction = (_input, init) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response('x', { status: 404 }));
    };
    await createUpdateSource({ kind: 'url', url: TEST_ORIGIN }, { fetch: fetcher })
      .fetchRelease('stable')
      .catch(() => undefined);
    expect(seen[0]?.credentials).toBe('omit');
    expect(seen[0]?.redirect).toBe('manual');
    expect(Object.keys(seen[0]?.headers ?? {}).sort()).toEqual(['accept', 'user-agent']);
  });

  it('follows a redirect on https, and refuses one to http or to another scheme', async () => {
    const hop =
      (location: string): FetchFunction =>
      (input) =>
        Promise.resolve(
          addressOf(input).endsWith('manifest.json')
            ? new Response(null, { status: 302, headers: { location } })
            : new Response('x', { status: 404 }),
        );
    const refused = await stopOf(
      createUpdateSource(
        { kind: 'url', url: TEST_ORIGIN },
        { fetch: hop('http://updates.test/x') },
      ).fetchRelease('stable'),
    );
    expect(refused.reason).toBe('bad_response');
    const other = await stopOf(
      createUpdateSource(
        { kind: 'url', url: TEST_ORIGIN },
        { fetch: hop('file:///etc/passwd') },
      ).fetchRelease('stable'),
    );
    expect(other.reason).toBe('bad_response');
    const origin = new FakeOrigin();
    origin.files.set('https://cdn.test/m.json', 'm');
    origin.files.set(`${TEST_ORIGIN}manifest.json.sig`, 's');
    let first = true;
    const follows: FetchFunction = (input, init) => {
      if (first && addressOf(input).endsWith('/manifest.json')) {
        first = false;
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://cdn.test/m.json' } }),
        );
      }
      return origin.fetch(input, init);
    };
    const files = await createUpdateSource(
      { kind: 'url', url: TEST_ORIGIN },
      { fetch: follows },
    ).fetchRelease('stable');
    expect(Buffer.from(files?.manifest ?? []).toString()).toBe('m');
  });

  it('refuses a loop of redirects', async () => {
    const loop: FetchFunction = () =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://updates.test/again' } }),
      );
    const stop = await stopOf(
      createUpdateSource({ kind: 'url', url: TEST_ORIGIN }, { fetch: loop }).fetchRelease('stable'),
    );
    expect(stop.reason).toBe('bad_response');
  });
});

describe('a download', () => {
  it('is written to the new file and its size and SHA-256 are told', async () => {
    const origin = new FakeOrigin();
    origin.files.set(`${TEST_ORIGIN}a`, Buffer.from('abc'));
    const source = createUpdateSource({ kind: 'url', url: TEST_ORIGIN }, { fetch: origin.fetch });
    const file = join(await tmp(), 'out');
    expect(await source.download(`${TEST_ORIGIN}a`, file, 10)).toEqual({
      size: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    expect(await readFile(file, 'utf8')).toBe('abc');
    // It never writes over a file that is there.
    expect((await stopOf(source.download(`${TEST_ORIGIN}a`, file, 10))).reason).toBe('storage');
  });

  it('stops at the size the manifest announced', async () => {
    const origin = new FakeOrigin();
    origin.files.set(`${TEST_ORIGIN}a`, Buffer.from('abcdef'));
    const source = createUpdateSource({ kind: 'url', url: TEST_ORIGIN }, { fetch: origin.fetch });
    expect(
      (await stopOf(source.download(`${TEST_ORIGIN}a`, join(await tmp(), 'out'), 4))).reason,
    ).toBe('size');
  });

  it('a file that is not there is bad_response', async () => {
    const source = createUpdateSource(
      { kind: 'url', url: TEST_ORIGIN },
      { fetch: new FakeOrigin().fetch },
    );
    expect(
      (await stopOf(source.download(`${TEST_ORIGIN}a`, join(await tmp(), 'out'), 4))).reason,
    ).toBe('bad_response');
  });
});

describe('the origin of kind github', () => {
  it('asks only github.com and api.github.com, with no token', async () => {
    const asked: { url: string; headers: unknown }[] = [];
    const fetcher: FetchFunction = (input, init) => {
      asked.push({ url: addressOf(input), headers: init?.headers });
      return Promise.resolve(new Response('[]', { status: 200 }));
    };
    const source = createUpdateSource({ kind: 'github' }, { fetch: fetcher });
    expect(await source.fetchRelease('beta')).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toMatch(
      /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\?per_page=30$/u,
    );
    expect(JSON.stringify(asked[0]?.headers).toLowerCase()).not.toContain('authorization');
  });

  it('a tag that is not a tag is refused', async () => {
    const fetcher: FetchFunction = () =>
      Promise.resolve(
        new Response(JSON.stringify([{ tag_name: '../../x', prerelease: true }]), { status: 200 }),
      );
    const stop = await stopOf(
      createUpdateSource({ kind: 'github' }, { fetch: fetcher }).fetchRelease('beta'),
    );
    expect(stop.reason).toBe('bad_response');
  });
});
