// SPDX-License-Identifier: MPL-2.0
import { API_ROUTES, defaultLayout, type DaemonId } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DaemonDirectory,
  MemoryDaemonListStore,
  parseDaemonConnection,
  type LocalDaemon,
} from './directory.js';
import {
  ApiNetworkError,
  DaemonDirectoryError,
  DaemonIdMismatchError,
  ApiRequestError,
} from './errors.js';
import { parseScenarioRefKey, sameScenario, scenarioRefKey } from './refs.js';
import { startTestDaemon, type TestDaemon } from './test-daemon.test-support.js';

const ID_A = '11111111-1111-4111-8111-111111111111' as DaemonId;
const ID_B = '22222222-2222-4222-8222-222222222222' as DaemonId;

const open: TestDaemon[] = [];
async function daemon(options?: Parameters<typeof startTestDaemon>[0]): Promise<TestDaemon> {
  const started = await startTestDaemon(options);
  open.push(started);
  return started;
}
afterEach(async () => {
  for (const started of open.splice(0)) await started.close();
});

function entryOf(name: string, daemonId: DaemonId, url = 'http://127.0.0.1:9') {
  return { name, url, daemonId, token: `token-${name}` };
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DaemonDirectoryError);
  return (error as DaemonDirectoryError).code;
}

describe('parseDaemonConnection', () => {
  it('normalizes the URL and keeps the rest', () => {
    expect(parseDaemonConnection({ ...entryOf('x', ID_A, 'http://host:7000/base//') }).url).toBe(
      'http://host:7000/base',
    );
    expect(parseDaemonConnection({ ...entryOf('x', ID_A, 'https://Host.test') }).url).toBe(
      'https://host.test',
    );
  });

  it.each([
    ['a name that is blank', { ...entryOf(' ', ID_A) }],
    ['a URL that is not one', { ...entryOf('x', ID_A, 'nope') }],
    ['a URL of another scheme', { ...entryOf('x', ID_A, 'ftp://h') }],
    ['a URL with a query', { ...entryOf('x', ID_A, 'http://h/?a=1') }],
    ['a URL with credentials', { ...entryOf('x', ID_A, 'http://u:p@h') }],
    ['a token with a space', { ...entryOf('x', ID_A), token: 'a b' }],
    ['an empty token', { ...entryOf('x', ID_A), token: '' }],
    ['a daemon id that is not a UUID', { ...entryOf('x', 'abc') }],
    ['an unknown field', { ...entryOf('x', ID_A), extra: 1 }],
  ])('rejects %s', (_name, input) => {
    expect(() => parseDaemonConnection(input)).toThrow(DaemonDirectoryError);
  });

  it('does not put the token in the error message', () => {
    try {
      parseDaemonConnection({ ...entryOf('x', ID_A, 'nope'), token: 'super-secret' });
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret');
    }
  });
});

describe('the saved list', () => {
  it('adds, lists, gets and removes', async () => {
    const directory = new DaemonDirectory({ store: new MemoryDaemonListStore() });
    expect(await directory.list()).toEqual([]);
    const added = await directory.add(entryOf('casa', ID_A));
    expect(added.source).toBe('saved');
    await directory.add(entryOf('nuvem', ID_B));
    expect((await directory.list()).map((entry) => entry.name)).toEqual(['casa', 'nuvem']);
    expect((await directory.get('nuvem'))?.daemonId).toBe(ID_B);
    expect((await directory.getByDaemonId(ID_A))?.name).toBe('casa');
    await directory.remove('casa');
    expect((await directory.list()).map((entry) => entry.name)).toEqual(['nuvem']);
    expect(await directory.get('casa')).toBeUndefined();
  });

  it('refuses a repeated name, a repeated daemon and the reserved name', async () => {
    const directory = new DaemonDirectory({ store: new MemoryDaemonListStore() });
    await directory.add(entryOf('casa', ID_A));
    expect(await codeOf(directory.add(entryOf('casa', ID_B)))).toBe('duplicate_name');
    expect(await codeOf(directory.add(entryOf('outra', ID_A)))).toBe('duplicate_daemon');
    expect(await codeOf(directory.add(entryOf('local', ID_B)))).toBe('reserved_name');
    expect(await codeOf(directory.add(entryOf('', ID_B)))).toBe('invalid_entry');
    expect(await directory.list()).toHaveLength(1);
  });

  it('updates the URL and the token of an entry, and refuses an unknown or a local one', async () => {
    const directory = new DaemonDirectory({ store: new MemoryDaemonListStore() });
    await directory.add(entryOf('casa', ID_A));
    const updated = await directory.update('casa', { url: 'http://127.0.0.1:1/', token: 'novo' });
    expect(updated).toMatchObject({ url: 'http://127.0.0.1:1', token: 'novo', daemonId: ID_A });
    expect((await directory.get('casa'))?.token).toBe('novo');
    expect(await codeOf(directory.update('nada', { token: 'x' }))).toBe('not_found');
    expect(await codeOf(directory.update('local', { token: 'x' }))).toBe('read_only');
    expect(await codeOf(directory.update('casa', { url: 'nope' }))).toBe('invalid_entry');
    expect(await codeOf(directory.remove('nada'))).toBe('not_found');
    expect(await codeOf(directory.remove('local'))).toBe('read_only');
  });

  it('keeps every entry when many are added at once', async () => {
    const store = new MemoryDaemonListStore();
    const directory = new DaemonDirectory({ store });
    const ids = Array.from(
      { length: 10 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    await Promise.all(ids.map((id, index) => directory.add(entryOf(`d${String(index)}`, id))));
    expect((await directory.list()).map((entry) => entry.name).sort()).toEqual(
      ids.map((_, index) => `d${String(index)}`).sort(),
    );
  });

  it('a failed add does not stop the next one', async () => {
    const directory = new DaemonDirectory({ store: new MemoryDaemonListStore() });
    const results = await Promise.allSettled([
      directory.add(entryOf('a', ID_A)),
      directory.add(entryOf('a', ID_B)),
      directory.add(entryOf('b', ID_B)),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('the local daemon', () => {
  const local: LocalDaemon = {
    url: 'http://127.0.0.1:5000/',
    daemonId: ID_A,
    token: 'local-token',
  };

  it('comes first, by itself, and is not saved', async () => {
    const store = new MemoryDaemonListStore();
    const directory = new DaemonDirectory({
      store,
      local: { discover: () => Promise.resolve(local) },
    });
    await directory.add(entryOf('nuvem', ID_B));
    const list = await directory.list();
    expect(list.map((entry) => [entry.name, entry.source])).toEqual([
      ['local', 'local'],
      ['nuvem', 'saved'],
    ]);
    expect(list[0]?.url).toBe('http://127.0.0.1:5000');
    expect(await store.load()).toHaveLength(1);
  });

  it('is absent when discovery finds nothing', async () => {
    const directory = new DaemonDirectory({
      store: new MemoryDaemonListStore(),
      local: { discover: () => Promise.resolve(undefined) },
    });
    expect(await directory.list()).toEqual([]);
    expect(await codeOf(directory.connect('local'))).toBe('not_found');
  });

  it('hides a saved entry of the same daemon, which stays in the file', async () => {
    const store = new MemoryDaemonListStore([parseDaemonConnection(entryOf('copia', ID_A))]);
    const directory = new DaemonDirectory({
      store,
      local: { discover: () => Promise.resolve(local) },
    });
    expect((await directory.list()).map((entry) => entry.name)).toEqual(['local']);
    expect(await store.load()).toHaveLength(1);
  });
});

describe('connecting', () => {
  it('enroll learns the daemon id from the daemon and saves the entry', async () => {
    const started = await daemon();
    const directory = new DaemonDirectory({ store: new MemoryDaemonListStore() });
    const entry = await directory.enroll({ name: 'casa', url: started.url, token: started.token });
    expect(entry.daemonId).toBe(started.daemonId);
    const connected = await directory.connect('casa');
    expect(connected.status.daemonId).toBe(started.daemonId);
    expect(connected.client.daemonId).toBe(started.daemonId);
    expect(connected.entry.name).toBe('casa');
  });

  it('enroll saves nothing when the daemon does not answer or the token is wrong', async () => {
    const started = await daemon();
    const store = new MemoryDaemonListStore();
    const directory = new DaemonDirectory({ store });
    await expect(
      directory.enroll({ name: 'casa', url: started.url, token: 'wrong' }),
    ).rejects.toBeInstanceOf(ApiRequestError);
    await expect(
      directory.enroll({ name: 'casa', url: 'http://127.0.0.1:1', token: 'x' }, { timeoutMs: 500 }),
    ).rejects.toBeInstanceOf(ApiNetworkError);
    expect(await store.load()).toEqual([]);
  });

  it('a daemon that is not the one saved is a DaemonIdMismatchError', async () => {
    const started = await daemon();
    const directory = new DaemonDirectory({ store: new MemoryDaemonListStore() });
    await directory.add({ name: 'casa', url: started.url, token: started.token, daemonId: ID_B });
    const error = await directory.connect('casa').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DaemonIdMismatchError);
    expect(error).toMatchObject({ expected: ID_B, actual: started.daemonId });
  });

  it('an unknown name is not_found', async () => {
    const directory = new DaemonDirectory({ store: new MemoryDaemonListStore() });
    expect(await codeOf(directory.connect('nada'))).toBe('not_found');
  });

  it('connectAll reports each daemon: one down or wrong does not hide the others', async () => {
    const good = await daemon();
    const wrong = await daemon();
    const gone = await daemon();
    const goneUrl = gone.url;
    const goneId = gone.daemonId;
    await gone.close();
    open.splice(open.indexOf(gone), 1);
    const directory = new DaemonDirectory({
      store: new MemoryDaemonListStore(),
      timeoutMs: 2000,
    });
    await directory.add({ name: 'boa', url: good.url, token: good.token, daemonId: good.daemonId });
    await directory.add({ name: 'errada', url: wrong.url, token: wrong.token, daemonId: ID_B });
    await directory.add({ name: 'fora', url: goneUrl, token: 'x', daemonId: goneId });
    const outcomes = await directory.connectAll();
    const byName = new Map(outcomes.map((outcome) => [outcome.entry.name, outcome]));
    expect(byName.get('boa')?.ok).toBe(true);
    const errada = byName.get('errada');
    expect(errada?.ok === false && errada.error).toBeInstanceOf(DaemonIdMismatchError);
    const fora = byName.get('fora');
    expect(fora?.ok === false && fora.error).toBeInstanceOf(ApiNetworkError);
  });
});

describe('two daemons at once (N134, N168)', () => {
  it('each keeps its own state, and the scenario references tell them apart', async () => {
    const one = await daemon();
    const two = await daemon();
    expect(one.daemonId).not.toBe(two.daemonId);
    const directory = new DaemonDirectory({
      store: new MemoryDaemonListStore(),
      local: {
        discover: () => Promise.resolve({ url: one.url, daemonId: one.daemonId, token: one.token }),
      },
    });
    await directory.enroll({ name: 'nuvem', url: two.url, token: two.token });
    const outcomes = await directory.connectAll();
    expect(outcomes.map((outcome) => outcome.entry.name)).toEqual(['local', 'nuvem']);
    const clients = outcomes.map((outcome) => {
      if (!outcome.ok) throw outcome.error as Error;
      return outcome.connected.client;
    });
    const [first, second] = clients;
    await Promise.all([
      first?.call(API_ROUTES.putLayout, {
        params: { interface: 'tui' },
        body: { ...defaultLayout('tui'), chatWidth: 31 },
      }),
      second?.call(API_ROUTES.putLayout, {
        params: { interface: 'tui' },
        body: { ...defaultLayout('tui'), chatWidth: 62 },
      }),
    ]);
    const read = (client: typeof first) =>
      client?.call(API_ROUTES.getLayout, { params: { interface: 'tui' } });
    expect((await read(first))?.chatWidth).toBe(31);
    expect((await read(second))?.chatWidth).toBe(62);
    expect(one.layouts.get('tui')?.chatWidth).toBe(31);
    expect(two.layouts.get('tui')?.chatWidth).toBe(62);
    // Each daemon only ever saw its own token.
    expect(one.requests.every((r) => r.headers.authorization === `Bearer ${one.token}`)).toBe(true);
    expect(two.requests.every((r) => r.headers.authorization === `Bearer ${two.token}`)).toBe(true);

    const refOne = first?.scenarioRef('S1');
    const refTwo = second?.scenarioRef('S1');
    expect(refOne && refTwo && sameScenario(refOne, refTwo)).toBe(false);
    expect(refOne && scenarioRefKey(refOne)).not.toBe(refTwo && scenarioRefKey(refTwo));
  });
});

describe('scenario references', () => {
  it('the key round-trips, even for an odd scenario id', () => {
    const ref = { daemonId: ID_A, scenarioId: 'S1/x' };
    expect(parseScenarioRefKey(scenarioRefKey(ref))).toEqual(ref);
    expect(parseScenarioRefKey('sem-barra')).toBeUndefined();
    expect(parseScenarioRefKey('nao-uuid/S1')).toBeUndefined();
    expect(sameScenario(ref, { ...ref })).toBe(true);
    expect(sameScenario(ref, { ...ref, daemonId: ID_B })).toBe(false);
  });
});
