// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtureAdapter,
  makeTarball,
  startFakeRegistry,
  tarballPath,
  type FakeRegistry,
  type FixtureAdapter,
} from './adapter-fixture.js';
import {
  AdapterInstallError,
  adapterDir,
  adapterEntry,
  installAdapter,
  isInstalled,
  tarballUrl,
  type InstallEvent,
  type InstallOptions,
} from './install.js';

const LINUX = { os: 'linux', cpu: 'x64', libc: 'glibc' } as const;

let dir: string;
let registry: FakeRegistry | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ot-adapters-'));
});

afterEach(async () => {
  await registry?.close();
  registry = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function setup(
  adapter: FixtureAdapter,
): Promise<{ options: InstallOptions; events: InstallEvent[] }> {
  registry = await startFakeRegistry(adapter);
  const events: InstallEvent[] = [];
  return {
    events,
    options: {
      lock: adapter.lock,
      adaptersDir: dir,
      registry: registry.url,
      platform: LINUX,
      retryDelayMs: 0,
      onEvent: (event) => events.push(event),
    },
  };
}

describe('installAdapter', () => {
  it('installs the tree of the lock, checks sha512 and swaps it in', async () => {
    const adapter = fixtureAdapter([
      {
        path: 'node_modules/dep',
        name: 'dep',
        version: '2.0.0',
        files: [{ path: 'package.json', content: '{"name":"dep"}' }],
      },
      {
        path: 'node_modules/@scope/pkg',
        name: '@scope/pkg',
        version: '3.1.0',
        files: [{ path: 'index.js', content: 'module.exports=1' }],
      },
    ]);
    const { options, events } = await setup(adapter);
    const result = await installAdapter(options);
    expect(result.status).toBe('installed');
    expect(result.dir).toBe(adapterDir(dir, adapter.lock));
    expect(await readFile(adapterEntry(result.dir, adapter.lock), 'utf8')).toBe(
      'console.log("fake-acp");\n',
    );
    expect(await readFile(path.join(result.dir, 'node_modules/@scope/pkg/index.js'), 'utf8')).toBe(
      'module.exports=1',
    );
    expect(await isInstalled(result.dir, adapter.lock)).toBe(true);
    expect(events.map((e) => e.phase)).toEqual(['start', 'done']);
    expect(registry?.requests).toContain('/@scope/pkg/-/pkg-3.1.0.tgz');
    // Nothing stays beside the installation but the version folder.
    expect((await readdir(path.dirname(result.dir))).sort()).toEqual([adapter.lock.version]);
    if (process.platform !== 'win32') {
      expect((await stat(result.entry)).mode & 0o111).not.toBe(0);
    }
  });

  it('is idempotent: a second install downloads nothing', async () => {
    const { options } = await setup(fixtureAdapter());
    await installAdapter(options);
    const before = registry?.requests.length;
    const again = await installAdapter(options);
    expect(again.status).toBe('already_installed');
    expect(registry?.requests.length).toBe(before);
  });

  it('refuses a tarball that does not match the sha512 of the lock, and leaves nothing', async () => {
    const adapter = fixtureAdapter();
    const { options, events } = await setup(adapter);
    registry?.serve(
      tarballPath('fake-acp', '1.2.3'),
      makeTarball([{ path: 'dist/index.js', content: 'evil' }]),
    );
    await expect(installAdapter(options)).rejects.toMatchObject({ code: 'integrity' });
    expect(events.at(-1)).toMatchObject({ phase: 'failed', code: 'integrity' });
    expect(await isInstalled(adapterDir(dir, adapter.lock), adapter.lock)).toBe(false);
    expect(await readdir(path.dirname(adapterDir(dir, adapter.lock)))).toEqual([]);
  });

  it('filters the optional packages by os and cpu', async () => {
    const adapter = fixtureAdapter([
      {
        path: 'node_modules/native-linux',
        name: 'native-linux',
        version: '1.0.0',
        os: ['linux'],
        cpu: ['x64'],
        optional: true,
        files: [{ path: 'a.node', content: 'l' }],
      },
      {
        path: 'node_modules/native-win',
        name: 'native-win',
        version: '1.0.0',
        os: ['win32'],
        cpu: ['x64'],
        optional: true,
        files: [{ path: 'a.node', content: 'w' }],
      },
    ]);
    const { options } = await setup(adapter);
    const result = await installAdapter(options);
    expect(await stat(path.join(result.dir, 'node_modules/native-linux/a.node'))).toBeTruthy();
    await expect(stat(path.join(result.dir, 'node_modules/native-win'))).rejects.toThrow();
    expect(registry?.requests.some((r) => r.includes('native-win'))).toBe(false);
  });

  it('retries a 503 and gives up on a 404 with the status in the message', async () => {
    const adapter = fixtureAdapter();
    const { options } = await setup(adapter);
    registry?.failNext(503, 1);
    expect((await installAdapter(options)).status).toBe('installed');
    await rm(path.dirname(adapterDir(dir, adapter.lock)), { recursive: true, force: true });
    registry?.failNext(503, 5);
    await expect(installAdapter({ ...options, retries: 1 })).rejects.toThrow(/503/u);
    registry?.serve(tarballPath('fake-acp', '1.2.3'), Buffer.alloc(0));
    const missing = await setup(fixtureAdapter());
    await registry?.close();
    registry = await startFakeRegistry({ lock: missing.options.lock, tarballs: new Map() });
    await expect(
      installAdapter({ ...missing.options, registry: registry.url }),
    ).rejects.toMatchObject({
      code: 'registry_status',
    });
  });

  it('reports a registry that cannot be reached as a network failure', async () => {
    const { options } = await setup(fixtureAdapter());
    await registry?.close();
    await expect(installAdapter({ ...options, retries: 0 })).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('accepts only https, or http on this machine', async () => {
    const { options } = await setup(fixtureAdapter());
    await expect(
      installAdapter({ ...options, registry: 'http://registry.example.com' }),
    ).rejects.toMatchObject({
      code: 'registry_insecure',
    });
    await expect(installAdapter({ ...options, registry: 'not a url' })).rejects.toBeInstanceOf(
      AdapterInstallError,
    );
  });

  it('two installs at once download once', async () => {
    const adapter = fixtureAdapter();
    const { options } = await setup(adapter);
    const release = registry?.hold();
    const first = installAdapter(options);
    const second = installAdapter(options);
    setTimeout(() => release?.(), 150);
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status).sort()).toEqual(['already_installed', 'installed']);
    expect(registry?.requests.filter((r) => r.endsWith('.tgz'))).toHaveLength(1);
  });

  it('waits for a lock that is held, takes over a stale one and gives up when it is not stale', async () => {
    const adapter = fixtureAdapter();
    const { options } = await setup(adapter);
    const parent = path.dirname(adapterDir(dir, adapter.lock));
    await mkdir(parent, { recursive: true });
    await writeFile(path.join(parent, '.install.lock'), 'someone');
    await expect(installAdapter({ ...options, lockWaitMs: 250 })).rejects.toMatchObject({
      code: 'locked',
    });
    expect((await installAdapter({ ...options, lockStaleMs: 0 })).status).toBe('installed');
    await expect(stat(path.join(parent, '.install.lock'))).rejects.toThrow();
  });

  it('replaces the leftovers of an installation that died', async () => {
    const adapter = fixtureAdapter();
    const { options } = await setup(adapter);
    const target = adapterDir(dir, adapter.lock);
    await mkdir(path.join(path.dirname(target), '.tmp-1.2.3-1-1'), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'half.txt'), 'x');
    expect((await installAdapter(options)).status).toBe('installed');
    expect((await readdir(path.dirname(target))).sort()).toEqual(['1.2.3']);
    await expect(stat(path.join(target, 'half.txt'))).rejects.toThrow();
  });

  it('a lock with another digest is not the installed one', async () => {
    const adapter = fixtureAdapter();
    const { options } = await setup(adapter);
    const result = await installAdapter(options);
    const other = { ...adapter.lock, entries: [...adapter.lock.entries].reverse().slice(0, 1) };
    expect(await isInstalled(result.dir, { ...other, entry: 'dist/other.js' })).toBe(false);
  });
});

describe('installAdapter: redirects and archives of a hostile registry', () => {
  const REGISTRY = 'https://registry.test';
  const ARCHIVE = tarballPath('fake-acp', '1.2.3');

  /** A `fetch` that never touches the network: `routes` maps a URL to its answer. */
  function fakeFetch(routes: Record<string, () => Response>): {
    fetch: typeof fetch;
    calls: string[];
  } {
    const calls: string[] = [];
    const fake = ((input: URL | string, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      expect(init?.redirect).toBe('manual');
      const route = routes[url];
      return Promise.resolve(route === undefined ? new Response(null, { status: 404 }) : route());
    }) as typeof fetch;
    return { fetch: fake, calls };
  }

  const redirect =
    (to: string, status = 302) =>
    (): Response =>
      new Response(null, { status, headers: { location: to } });

  function served(adapter: FixtureAdapter): () => Response {
    const tarball = adapter.tarballs.get(ARCHIVE);
    if (tarball === undefined) throw new Error(`the fixture has no tarball for ${ARCHIVE}`);
    return () => new Response(new Uint8Array(tarball), { status: 200 });
  }

  function base(adapter: FixtureAdapter, fetchFn: typeof fetch): InstallOptions {
    return {
      lock: adapter.lock,
      adaptersDir: dir,
      registry: REGISTRY,
      platform: LINUX,
      retryDelayMs: 0,
      fetch: fetchFn,
    };
  }

  const FIRST = `${REGISTRY}${ARCHIVE}`;

  it('follows a redirect to a host of clients.adapters.redirect_hosts and checks the sha512 at the end', async () => {
    const adapter = fixtureAdapter();
    const { fetch: fake, calls } = fakeFetch({
      [FIRST]: redirect('https://cdn.test/a.tgz'),
      'https://cdn.test/a.tgz': served(adapter),
    });
    const result = await installAdapter({ ...base(adapter, fake), redirectHosts: ['cdn.test'] });
    expect(result.status).toBe('installed');
    expect(calls).toEqual([FIRST, 'https://cdn.test/a.tgz']);
  });

  it('follows a redirect inside the registry host (relative Location) with no list', async () => {
    const adapter = fixtureAdapter();
    const { fetch: fake } = fakeFetch({
      [FIRST]: redirect('/moved/a.tgz', 301),
      [`${REGISTRY}/moved/a.tgz`]: served(adapter),
    });
    expect((await installAdapter(base(adapter, fake))).status).toBe('installed');
  });

  it('refuses a redirect to a host that is not allowed, and never asks that host', async () => {
    const adapter = fixtureAdapter();
    const { fetch: fake, calls } = fakeFetch({ [FIRST]: redirect('https://evil.test/a.tgz') });
    await expect(installAdapter(base(adapter, fake))).rejects.toMatchObject({
      code: 'redirect',
      message: expect.stringContaining('clients.adapters.redirect_hosts') as unknown,
    });
    expect(calls).toEqual([FIRST]);
  });

  it('refuses a redirect to plain http, even to a listed host, and one with credentials', async () => {
    const adapter = fixtureAdapter();
    for (const to of ['http://cdn.test/a.tgz', 'https://user:pw@cdn.test/a.tgz']) {
      const { fetch: fake } = fakeFetch({ [FIRST]: redirect(to) });
      await expect(
        installAdapter({ ...base(adapter, fake), redirectHosts: ['cdn.test'] }),
      ).rejects.toMatchObject({ code: 'redirect' });
    }
  });

  it('stops after clients.adapters.redirect_max hops, and 0 refuses every redirect', async () => {
    const adapter = fixtureAdapter();
    const { fetch: loop, calls } = fakeFetch({ [FIRST]: redirect(FIRST) });
    await expect(installAdapter({ ...base(adapter, loop), redirectMax: 2 })).rejects.toMatchObject({
      code: 'redirect',
    });
    expect(calls).toHaveLength(3);
    const { fetch: once } = fakeFetch({ [FIRST]: redirect(`${REGISTRY}/b.tgz`) });
    await expect(installAdapter({ ...base(adapter, once), redirectMax: 0 })).rejects.toMatchObject({
      code: 'redirect',
    });
  });

  it('refuses a redirect with no Location', async () => {
    const adapter = fixtureAdapter();
    const { fetch: fake } = fakeFetch({ [FIRST]: () => new Response(null, { status: 302 }) });
    await expect(installAdapter(base(adapter, fake))).rejects.toMatchObject({ code: 'redirect' });
  });

  it.each(['a.js', 'A.JS'])(
    'refuses a tarball that repeats a path (%s), even in another case, and leaves nothing',
    async (second) => {
      const adapter = fixtureAdapter([
        {
          path: 'node_modules/dup',
          name: 'dup',
          version: '1.0.0',
          files: [
            { path: 'a.js', content: '1' },
            { path: second, content: '2' },
          ],
        },
      ]);
      const { options } = await setup(adapter);
      await expect(installAdapter(options)).rejects.toMatchObject({
        code: 'archive',
        message: expect.stringContaining('twice') as unknown,
      });
      expect(await isInstalled(adapterDir(dir, adapter.lock), adapter.lock)).toBe(false);
    },
  );

  it('refuses a tarball with more entries than clients.adapters.tar_max_entries', async () => {
    const adapter = fixtureAdapter([
      {
        path: 'node_modules/many',
        name: 'many',
        version: '1.0.0',
        files: Array.from({ length: 6 }, (_, i) => ({ path: `f${String(i)}.js`, content: 'x' })),
      },
    ]);
    const { options } = await setup(adapter);
    await expect(installAdapter({ ...options, tarMaxEntries: 4 })).rejects.toMatchObject({
      code: 'archive',
      message: expect.stringContaining('entries') as unknown,
    });
    expect((await installAdapter({ ...options, tarMaxEntries: 100 })).status).toBe('installed');
  });
});

describe('tarballUrl', () => {
  it('builds the registry layout, scoped or not, whatever host the lock names', () => {
    const entry = {
      path: 'node_modules/@a/b',
      name: '@a/b',
      version: '1.0.0-linux-x64',
      integrity: 'sha512-AA',
    };
    expect(tarballUrl('https://r.example/', entry)).toBe(
      'https://r.example/@a/b/-/b-1.0.0-linux-x64.tgz',
    );
    expect(tarballUrl('https://r.example', { ...entry, name: 'plain' })).toBe(
      'https://r.example/plain/-/plain-1.0.0-linux-x64.tgz',
    );
  });
});
