// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import { defaultLayout } from '@otheater/protocol';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { describeWithLauncher } from '../launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  withPlayDaemon,
  type PlayHarness,
  type PlayHarnessOptions,
} from '../orchestration/e2e-fixture.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths, ensureDataDir } from '../paths.js';
import { RecoveryGate } from '../recovery/gate.js';
import { attachmentRootsPolicy, userFolder } from '../scenarios/attachment-roots.js';
import { AttachmentService } from '../scenarios/attachments.js';
import { makeTempDataDir, NO_CLIENTS, RecordingSituations } from '../test-helpers.js';
import { redactPaths, redactDetails } from './error-paths.js';
import { generateApiToken, loadOrCreateApiToken, readApiToken, writePrivateFile } from './files.js';
import { jsonDepthExceeds } from './json-depth.js';
import { ApiServer } from './server.js';

/**
 * The review of the local API (P8b of docs/23): one case per finding. The daemon here is the light
 * one (fake clock, in-memory store, no client): nothing real runs. A case that reads the user's
 * folders (Documents, Downloads) is given a fake HOME and fake XDG_* inside a temporary folder.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const POSIX = process.platform !== 'win32';

let tmp: Awaited<ReturnType<typeof makeTempDataDir>>;

beforeEach(async () => {
  tmp = await makeTempDataDir();
});

afterEach(async () => {
  await tmp.dispose();
});

// ---------------------------------------------------------------------------------------------
// The attachment by path (N287)
// ---------------------------------------------------------------------------------------------

describe('the attachment by path stays inside the roots (N287)', () => {
  let home: string;
  let project: string;
  let outside: string;
  let service: AttachmentService;
  let config: ReturnType<typeof parseConfig>['security']['attachment_roots'];
  let store: InMemoryStore;
  // The user folders of the platform: on macOS and Windows they are fixed (`~/Documents`, `~/Downloads`,
  // under `%USERPROFILE%` on Windows); only the other Unixes take them from the XDG variables.
  const FIXED = process.platform === 'win32' || process.platform === 'darwin';
  const DOCS = FIXED ? 'Documents' : 'Docs';
  const DOWN = FIXED ? 'Downloads' : 'Down';
  const env = (): Record<string, string> => ({
    HOME: home,
    USERPROFILE: home,
    XDG_DOCUMENTS_DIR: join(home, DOCS),
    XDG_DOWNLOAD_DIR: join(home, DOWN),
    XDG_CONFIG_HOME: join(home, '.config'),
  });

  async function put(path: string, text = 'content'): Promise<string> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
    return path;
  }

  beforeEach(async () => {
    home = join(tmp.dir, 'home');
    project = join(tmp.dir, 'project');
    outside = join(tmp.dir, 'elsewhere');
    await mkdir(join(home, DOCS), { recursive: true });
    await mkdir(join(home, DOWN), { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(outside, { recursive: true });
    const clock = new FakeClock();
    store = new InMemoryStore({ clock });
    await store.scenarios.create({
      id: 's1',
      kind: 'project',
      flowId: 'software',
      name: 's1',
      folder: project,
    });
    await store.scenarioRepos.put({ scenarioId: 's1', path: project, mainBranch: 'main' });
    config = parseConfig('').security.attachment_roots;
    service = new AttachmentService({
      store,
      clock,
      scenariosDir: join(tmp.dir, 'scenarios'),
      limits: () => ({ maxSize: 0, readMax: 1024 }),
      roots: attachmentRootsPolicy({
        config: () => config,
        store,
        worktrees: join(tmp.dir, 'worktrees'),
        env: env(),
        platform: process.platform,
        homedir: home,
      }),
    });
  });

  it('takes a file from the project, the Documents and the Downloads folders', async () => {
    for (const path of [
      await put(join(project, 'src', 'a.txt')),
      await put(join(home, DOCS, 'b.txt')),
      await put(join(home, DOWN, 'c.txt')),
    ]) {
      await expect(service.addFile('s1', { path })).resolves.toMatchObject({ scenarioId: 's1' });
    }
  });

  it('takes a file from the worktree of a play of the scenario', async () => {
    await store.plays.create({
      id: 'p1',
      scenarioId: 's1',
      need: 'x',
      flowId: 'software',
      flowVersion: 1,
      state: 'PLANNING',
    });
    const path = await put(join(tmp.dir, 'worktrees', 'p1', 'notes.md'));
    await expect(service.addFile('s1', { path })).resolves.toBeDefined();
  });

  it('refuses a file outside the roots with a 403-class error that does not name the path', async () => {
    const path = await put(join(outside, 'secret.txt'), 'hunter2');
    await expect(service.addFile('s1', { path })).rejects.toMatchObject({
      name: 'PermissionDenied',
      message: expect.stringContaining('security.attachment_roots') as string,
    });
    await expect(service.addFile('s1', { path })).rejects.not.toThrow(outside);
    expect(await store.attachments.list('s1')).toHaveLength(0);
  });

  it('refuses a `..` that leaves a root', async () => {
    await put(join(outside, 'secret.txt'));
    const path = join(project, '..', 'elsewhere', 'secret.txt');
    await expect(service.addFile('s1', { path })).rejects.toMatchObject({
      name: 'PermissionDenied',
    });
  });

  it.skipIf(!POSIX)('refuses a symlink inside a root that points out of it', async () => {
    const target = await put(join(outside, 'secret.txt'));
    const link = join(home, DOCS, 'innocent.txt');
    await symlink(target, link);
    await expect(service.addFile('s1', { path: link })).rejects.toMatchObject({
      name: 'PermissionDenied',
    });
    // A link to a folder outside is the same.
    await symlink(outside, join(project, 'dir-link'));
    await expect(
      service.addFile('s1', { path: join(project, 'dir-link', 'secret.txt') }),
    ).rejects.toMatchObject({ name: 'PermissionDenied' });
  });

  it('takes the folders the user adds, with `~` expanded, and any file in `any` mode', async () => {
    const path = await put(join(outside, 'listed.txt'));
    await expect(service.addFile('s1', { path })).rejects.toMatchObject({
      name: 'PermissionDenied',
    });
    config = { ...config, add: [outside] };
    await expect(service.addFile('s1', { path })).resolves.toBeDefined();
    const inHome = await put(join(home, 'extra', 'x.txt'));
    await expect(service.addFile('s1', { path: inHome })).rejects.toMatchObject({
      name: 'PermissionDenied',
    });
    config = { ...config, add: ['~/extra'] };
    await expect(service.addFile('s1', { path: inHome })).resolves.toBeDefined();
    config = { ...config, add: [], mode: 'any' };
    await expect(
      service.addFile('s1', { path: await put(join(tmp.dir, 'anywhere.txt')) }),
    ).resolves.toBeDefined();
  });

  it('drops a default the user took out of `defaults`', async () => {
    const path = await put(join(home, DOCS, 'b.txt'));
    config = { ...config, defaults: ['project'] };
    await expect(service.addFile('s1', { path })).rejects.toMatchObject({
      name: 'PermissionDenied',
    });
  });

  it('reads a reference again under the roots: a record that points out of them is not served', async () => {
    const path = await put(join(project, 'a.txt'), 'inside');
    const record = await service.addFile('s1', { path, mode: 'reference' });
    expect(await service.read(record)).toMatchObject({ content: 'inside' });
    config = { ...config, defaults: [] };
    await expect(service.read(record)).rejects.toMatchObject({ name: 'PermissionDenied' });
  });

  // The `linux` platform reads POSIX paths (`$HOME`, `/`): the host paths of Windows are not that.
  it.skipIf(!POSIX)(
    'resolves the user folders of Linux from the environment, the user-dirs file, then the home',
    async () => {
      const base = { homedir: home, platform: 'linux' as const };
      expect(await userFolder('documents', { ...base, env: env() })).toBe(join(home, DOCS));
      // Without the variables: `user-dirs.dirs` ...
      await put(
        join(home, '.config', 'user-dirs.dirs'),
        'XDG_DOCUMENTS_DIR="$HOME/Papers"\nXDG_DOWNLOAD_DIR="$HOME/Grabs"\n',
      );
      const bare = { HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
      expect(await userFolder('documents', { ...base, env: bare })).toBe(join(home, 'Papers'));
      expect(await userFolder('downloads', { ...base, env: bare })).toBe(join(home, 'Grabs'));
      // ... then ~/Documents and ~/Downloads.
      expect(
        await userFolder('documents', { ...base, env: { HOME: home, XDG_CONFIG_HOME: outside } }),
      ).toBe(join(home, 'Documents'));
      // A folder that is the home itself (what `xdg-user-dirs` writes for one that does not exist) or the
      // root of the disk is not a folder of its own: it would make the whole home a root.
      await put(
        join(home, '.config', 'user-dirs.dirs'),
        'XDG_DOCUMENTS_DIR="$HOME/"\nXDG_DOWNLOAD_DIR="/"\n',
      );
      expect(await userFolder('documents', { ...base, env: bare })).toBe(join(home, 'Documents'));
      expect(await userFolder('downloads', { ...base, env: bare })).toBe(join(home, 'Downloads'));
      expect(
        await userFolder('documents', { ...base, env: { ...bare, XDG_DOCUMENTS_DIR: home } }),
      ).toBe(join(home, 'Documents'));
    },
  );

  // Pure on every host: the paths are literals of the platform asked for.
  it('resolves the user folders of macOS and of Windows from the home', async () => {
    expect(
      await userFolder('downloads', { homedir: '/Users/x', platform: 'darwin', env: {} }),
    ).toBe('/Users/x/Downloads');
    expect(
      await userFolder('documents', {
        homedir: 'C:\\Users\\x',
        platform: 'win32',
        env: { USERPROFILE: 'C:\\Users\\x' },
      }),
    ).toBe('C:\\Users\\x\\Documents');
  });
});

describeWithLauncher('the attachment by path through the API', { timeout: 120_000 }, () => {
  it('answers 403 for a file outside the roots and does not put the path in the answer', async () => {
    await withHarness({ attachmentRoots: 'list' }, async ({ harness, call }) => {
      const scenarioId = await harness.openGenericChat('talk');
      const path = join(tmp.dir, 'private.txt');
      await writeFile(path, 'hunter2');
      const answer = await call('POST', `/v1/scenarios/${scenarioId}/attachments`, { path });
      expect(answer.status, answer.text).toBe(403);
      expect(answer.text).toContain('forbidden');
      expect(answer.text).not.toContain(tmp.dir);
      expect(await harness.daemon.store.attachments.list(scenarioId)).toHaveLength(0);
    });
  });

  it('takes the same file when security.attachment_roots.mode is any', async () => {
    await withHarness({ attachmentRoots: 'any' }, async ({ harness, call }) => {
      const scenarioId = await harness.openGenericChat('talk');
      const path = join(tmp.dir, 'private.txt');
      await writeFile(path, 'hunter2');
      const answer = await call('POST', `/v1/scenarios/${scenarioId}/attachments`, { path });
      expect(answer.status, answer.text).toBe(200);
    });
  });

  it('says a path that is not a file without the path (no absolute path in an error answer)', async () => {
    await withHarness({ attachmentRoots: 'any' }, async ({ harness, call }) => {
      const scenarioId = await harness.openGenericChat('talk');
      const missing = join(tmp.dir, 'does-not-exist.txt');
      const answer = await call('POST', `/v1/scenarios/${scenarioId}/attachments`, {
        path: missing,
      });
      expect(answer.status).toBe(400);
      expect(answer.text).not.toContain(tmp.dir);
      expect(answer.text).toContain('<path>');
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The depth of the JSON (api.max_json_depth)
// ---------------------------------------------------------------------------------------------

describe('a JSON nested too deep is a 400, not a 500', () => {
  it('counts the depth of arrays and objects in one pass, and ignores brackets in strings', () => {
    expect(jsonDepthExceeds('[[[[1]]]]', 4)).toBe(false);
    expect(jsonDepthExceeds('[[[[1]]]]', 3)).toBe(true);
    expect(jsonDepthExceeds('{"a":{"b":[{"c":1}]}}', 4)).toBe(false);
    expect(jsonDepthExceeds('{"a":{"b":[{"c":1}]}}', 3)).toBe(true);
    expect(jsonDepthExceeds('{"a":"[[[[[[[[[[","b":"\\"[[[[[["}', 1)).toBe(false);
    expect(jsonDepthExceeds('[1,2]'.repeat(100_000), 64)).toBe(false);
    expect(jsonDepthExceeds('['.repeat(1_000_000), 64)).toBe(true);
  });

  it('answers 400 invalid_input with a typed reason, and a flat body is not taken for a deep one', async () => {
    await withDaemon('api:\n  max_json_depth: 8\n', async ({ call }) => {
      const deep = await call(
        'POST',
        '/v1/scenarios',
        undefined,
        `{"text":${'['.repeat(9)}${']'.repeat(9)}}`,
      );
      expect(deep.status).toBe(400);
      expect(deep.json()).toMatchObject({
        error: { code: 'invalid_input', details: { reason: 'json_too_deep', maxDepth: 8 } },
      });
      // A million brackets: refused before anything parses them (that is a 500 or a hang without the limit).
      const huge = await call('POST', '/v1/scenarios', undefined, '['.repeat(900_000));
      expect([400, 413]).toContain(huge.status);
      const flat = await call('POST', '/v1/scenarios', undefined, '{"text":[[1]]}');
      expect(flat.text).not.toContain('json_too_deep');
      // At the limit (8 levels) the depth check lets it through to the schema.
      const edge = await call(
        'POST',
        '/v1/scenarios',
        undefined,
        `{"x":${'['.repeat(7)}${']'.repeat(7)}}`,
      );
      expect(edge.text).not.toContain('json_too_deep');
    });
  });

  it('keeps the default of 64 when the key is not set', () => {
    expect(parseConfig('').api.max_json_depth).toBe(64);
  });
});

// ---------------------------------------------------------------------------------------------
// The chat socket: tickets, sockets and the queue
// ---------------------------------------------------------------------------------------------

describeWithLauncher(
  'the chat tickets, sockets and queue have a ceiling',
  { timeout: 120_000 },
  () => {
    const CHAT =
      'api:\n  chat:\n    max_tickets: 2\n    max_sockets: 1\n    max_queued_messages: 2\n';

    it('answers 503 unavailable for a ticket past api.chat.max_tickets, with a Retry-After', async () => {
      await withHarness({ extra: CHAT }, async ({ harness, call }) => {
        const scenarioId = await harness.openGenericChat('talk');
        expect((await call('POST', '/v1/chat-tickets', { scenarioId })).status).toBe(200);
        expect((await call('POST', '/v1/chat-tickets', { scenarioId })).status).toBe(200);
        const third = await call('POST', '/v1/chat-tickets', { scenarioId });
        expect(third.status).toBe(503);
        expect(third.json()).toMatchObject({
          error: { code: 'unavailable', details: { maxTickets: 2 } },
        });
        expect(third.headers.get('retry-after')).toMatch(/^\d+$/);
      });
    });

    it('refuses a socket past api.chat.max_sockets and takes one again when it closes', async () => {
      await withHarness({ extra: CHAT }, async ({ harness, call, url }) => {
        const scenarioId = await harness.openGenericChat('talk');
        const first = await openSocket(call, url, scenarioId);
        expect(await handshakeStatus(await ticketUrl(call, url, scenarioId))).toBe(503);
        first.close();
        await closed(first);
        await until(async () =>
          (await handshakeStatus(await ticketUrl(call, url, scenarioId))) === 101
            ? true
            : undefined,
        );
      });
    });

    it('closes a socket whose client floods it past api.chat.max_queued_messages', async () => {
      await withHarness({ extra: CHAT }, async ({ harness, call, url }) => {
        const scenarioId = await harness.openGenericChat('talk');
        const socket = await openSocket(call, url, scenarioId);
        const code = closed(socket);
        // Every frame is a message the daemon has to handle (an answer to a decision that is not there).
        const frame = JSON.stringify({ type: 'answer', decisionId: 'nope', answer: {} });
        for (let i = 0; i < 400; i += 1) socket.send(frame);
        expect(await code).toBe(1008);
      });
    });

    it('refuses a JSON nested too deep in a message with an error frame, and keeps the socket', async () => {
      await withHarness(
        { extra: 'api:\n  max_json_depth: 8\n' },
        async ({ harness, call, url }) => {
          const scenarioId = await harness.openGenericChat('talk');
          const socket = await openSocket(call, url, scenarioId);
          const frames: string[] = [];
          socket.addEventListener('message', (event) => {
            frames.push(String(event.data));
          });
          socket.send(`{"type":"message","text":"x","deep":${'['.repeat(500)}${']'.repeat(500)}}`);
          await until(() =>
            Promise.resolve(frames.some((f) => f.includes('json_too_deep')) ? true : undefined),
          );
          expect(socket.readyState).toBe(WebSocket.OPEN);
          socket.close();
        },
      );
    });

    it('closes an open socket when the token is rotated, and refuses a ticket bought before', async () => {
      await withHarness({}, async ({ harness, call, url }) => {
        const scenarioId = await harness.openGenericChat('talk');
        const socket = await openSocket(call, url, scenarioId);
        const code = closed(socket);
        const stale = await ticketUrl(call, url, scenarioId);
        await harness.daemon.api.rotateToken();
        expect(await code).toBe(1008);
        expect(await handshakeStatus(stale)).toBe(401);
      });
    });
  },
);

// ---------------------------------------------------------------------------------------------
// The rotation of the token against a request in flight
// ---------------------------------------------------------------------------------------------

describe('a rotation of the token never lets a request that was checked with the old one run', () => {
  it('answers 401 to a command that waited on the gate while the token was rotated', async () => {
    const gate = new RecoveryGate();
    const token = generateApiToken();
    const api = await ApiServer.start({
      port: 'auto',
      token,
      tokenMode: 'persistent',
      tokenFile: join(tmp.dir, 'api-token'),
      discoveryFile: join(tmp.dir, 'api.json'),
      daemonId: '3f2b8a52-6a9a-4a0e-9c7e-7d3e0f6a1b11',
      maxBodyBytes: 1024,
      rejectionWindowMs: 10_000,
      now: () => 1_000_000,
      logger: createSilentLogger(),
      situations: new RecordingSituations(),
      gate,
    });
    try {
      let ran = 0;
      api.handlers.register('putLayout', (info) => {
        ran += 1;
        return info.body;
      });
      const pending = fetch(`${api.url}/v1/layout/tui`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(defaultLayout('tui')),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const epoch = api.tokenEpoch;
      await api.rotateToken();
      expect(api.tokenEpoch).toBe(epoch + 1);
      gate.open();
      const answer = await pending;
      expect(answer.status).toBe(401);
      expect(answer.headers.get('www-authenticate')).toContain('Bearer');
      expect(ran).toBe(0);
      // The new token, from the file, works on a fresh request.
      const fresh = await readApiToken(join(tmp.dir, 'api-token'));
      const again = await fetch(`${api.url}/v1/layout/tui`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${fresh ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify(defaultLayout('tui')),
      });
      expect(again.status).not.toBe(401);
    } finally {
      await api.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// No absolute path in an error
// ---------------------------------------------------------------------------------------------

describe('an error answer holds no absolute path', () => {
  it('redacts POSIX, Windows, UNC and file:// paths, and leaves routes, mime types and relative names', () => {
    expect(redactPaths('ENOENT: no such file /home/user/.ssh/id_ed25519 here')).toBe(
      'ENOENT: no such file <path> here',
    );
    expect(redactPaths('"/var/lib/x/y.txt" is not a file')).toBe('"<path>" is not a file');
    expect(redactPaths('C:\\Users\\x\\a.txt and D:/data/b')).toBe('<path> and <path>');
    expect(redactPaths('\\\\server\\share\\dir\\f')).toBe('<path>');
    expect(redactPaths('cwd=/home/u/x and error:/srv/data/y')).toBe('cwd=<path> and error:<path>');
    expect(redactPaths('see file:///home/u/a%20b.txt now')).toBe('see <path> now');
    expect(redactPaths('text/plain, a/b/c, https://host/x/y, ./rel, ~/home')).toBe(
      'text/plain, a/b/c, https://host/x/y, ./rel, ~/home',
    );
    expect(redactDetails({ file: '/etc/passwd', nested: ['/a/b', { c: 'C:\\x' }], n: 1 })).toEqual({
      file: '<path>',
      nested: ['<path>', { c: '<path>' }],
      n: 1,
    });
    expect(redactDetails(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The private files
// ---------------------------------------------------------------------------------------------

describe('the private files of the data folder', () => {
  it.skipIf(!POSIX)(
    'writes with mode 0600 through a temporary name nobody can guess, and leaves none',
    async () => {
      const path = join(tmp.dir, 'secret');
      await writeFile(path, 'old', { mode: 0o644 });
      await writePrivateFile(path, 'new');
      expect(await readFile(path, 'utf8')).toBe('new');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await readdir(tmp.dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    },
  );

  it.skipIf(!POSIX)(
    'does not write through a link planted where the old temporary name was',
    async () => {
      const path = join(tmp.dir, 'api-token');
      const victim = join(tmp.dir, 'victim');
      await writeFile(victim, 'untouched');
      // What the old code would have written to: `<path>.<pid>.tmp`.
      await symlink(victim, `${path}.${String(process.pid)}.tmp`);
      await writePrivateFile(path, 'token');
      expect(await readFile(victim, 'utf8')).toBe('untouched');
      expect(await readFile(path, 'utf8')).toBe('token');
    },
  );

  it.skipIf(!POSIX)('replaces a link at the target instead of following it', async () => {
    const path = join(tmp.dir, 'api-token');
    const victim = join(tmp.dir, 'victim');
    await writeFile(victim, 'untouched');
    await symlink(victim, path);
    await writePrivateFile(path, 'token');
    expect(await readFile(victim, 'utf8')).toBe('untouched');
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('token');
  });

  it.skipIf(!POSIX)(
    'does not reuse a token that others could read, or one behind a link',
    async () => {
      const path = join(tmp.dir, 'api-token');
      const loose = generateApiToken();
      await writeFile(path, `${loose}\n`, { mode: 0o644 });
      const fresh = await loadOrCreateApiToken(path, 'persistent');
      expect(fresh).not.toBe(loose);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      // Now it is private: it is reused.
      expect(await loadOrCreateApiToken(path, 'persistent')).toBe(fresh);

      const real = join(tmp.dir, 'real-token');
      const linked = generateApiToken();
      await writeFile(real, `${linked}\n`, { mode: 0o600 });
      const link = join(tmp.dir, 'linked-token');
      await symlink(real, link);
      const other = await loadOrCreateApiToken(link, 'persistent');
      expect(other).not.toBe(linked);
      expect(await readFile(real, 'utf8')).toBe(`${linked}\n`);
    },
  );

  it.skipIf(!POSIX)(
    'closes an existing data folder to group and others, and leaves the owner bits',
    async () => {
      const dir = join(tmp.dir, 'data');
      await mkdir(dir, { mode: 0o755 });
      await ensureDataDir(dir);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      await ensureDataDir(join(tmp.dir, 'fresh', 'deeper'));
      expect((await stat(join(tmp.dir, 'fresh', 'deeper'))).mode & 0o777).toBe(0o700);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------------------------

interface Answer {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
  readonly json: () => unknown;
}

interface Running {
  readonly daemon: DaemonHandle;
  readonly url: string;
  /** `body` is JSON-encoded; `raw` is sent as it is (a body that is not worth building as a value). */
  readonly call: (method: string, path: string, body?: unknown, raw?: string) => Promise<Answer>;
}

function caller(url: string, token: () => Promise<string>): Running['call'] {
  return async (method, path, payload, raw) => {
    const text = raw ?? (payload === undefined ? undefined : JSON.stringify(payload));
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        ...(text === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(text === undefined ? {} : { body: text }),
    });
    const answer = await response.text();
    return {
      status: response.status,
      text: answer,
      headers: response.headers,
      json: () => JSON.parse(answer) as unknown,
    };
  };
}

/** The light daemon: the fake clock, the in-memory store and vault, no client. */
async function withDaemon(yaml: string, body: (running: Running) => Promise<void>): Promise<void> {
  const clock = new FakeClock();
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    clientSearch: NO_CLIENTS,
    config: parseConfig(`backup:\n  when: manual\n${yaml}`),
    overrides: { clock, vault: new InMemorySecretVault(), store: new InMemoryStore({ clock }) },
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  try {
    const token = async (): Promise<string> =>
      (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
    await body({ daemon, url: daemon.api.url, call: caller(daemon.api.url, token) });
  } finally {
    await daemon.stop();
  }
}

/** The daemon with the fake agent as every role (the compiled fake agent must be built). */
function withHarness(
  options: PlayHarnessOptions,
  body: (running: Running & { harness: PlayHarness }) => Promise<void>,
): Promise<void> {
  return withPlayDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    options,
    async (harness) => {
      const token = async (): Promise<string> =>
        (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
      const url = harness.daemon.api.url;
      await body({ harness, daemon: harness.daemon, url, call: caller(url, token) });
    },
  );
}

async function ticketUrl(call: Running['call'], url: string, scenarioId: string): Promise<string> {
  const answer = await call('POST', '/v1/chat-tickets', { scenarioId });
  expect(answer.status, answer.text).toBe(200);
  const { ticket } = answer.json() as { ticket: string };
  return `${url.replace('http', 'ws')}/v1/scenarios/${scenarioId}/chat?ticket=${ticket}`;
}

async function openSocket(
  call: Running['call'],
  url: string,
  scenarioId: string,
): Promise<WebSocket> {
  const socket = new WebSocket(await ticketUrl(call, url, scenarioId));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the chat socket did not open'));
    });
  });
  return socket;
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve(event.code);
    });
  });
}

/** The status of a WebSocket handshake (101 when it is taken), without keeping the socket. */
function handshakeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const attempt = httpRequest({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
      },
    });
    attempt.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    attempt.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    attempt.on('error', reject);
    attempt.end();
  });
}

/** Polls `check` until it gives a value (real time: the daemon's sockets run on it). */
async function until(check: () => Promise<true | undefined>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await check()) === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the condition did not come true in 5 s');
}
