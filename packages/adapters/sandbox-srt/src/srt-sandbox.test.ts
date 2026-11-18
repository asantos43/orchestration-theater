// SPDX-License-Identifier: MPL-2.0
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdapterUnavailable,
  InvalidInput,
  resolveSecretPaths,
  type LaunchOptions,
  type SandboxRequest,
} from '@otheater/core';
import { SrtSandbox } from './srt-sandbox.js';

/**
 * The tests below run commands in the REAL sandbox (bubblewrap on Linux, Seatbelt on macOS) and
 * ask the operating system, not the code, whether a write, a connection or a read is refused.
 * They touch only a temporary folder, a fake HOME with a fake `.ssh`, and an HTTP server on
 * 127.0.0.1 that the test starts; nothing real is read and nothing leaves the machine. Where the
 * mechanism does not work (no bubblewrap, a kernel that forbids user namespaces) they are skipped,
 * unless OT_REQUIRE_SANDBOX=1 (the CI sets it), which makes the absence a failure.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), 'otheater-srt-')));
const sandbox = new SrtSandbox({ tempDir: join(root, 'sandbox-tmp') });
const availability = await sandbox.available();
const required = process.env.OT_REQUIRE_SANDBOX === '1';
const works = availability.ok;
const real = describe.skipIf(!works && !required);

interface Outcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function execute(launch: LaunchOptions): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.cmd, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const dirs = {
  wt: join(root, 'wt'),
  home: join(root, 'home'),
  outside: join(root, 'outside'),
  profile: join(root, 'data', 'profiles', 'fake', 'a'),
  otherProfile: join(root, 'data', 'profiles', 'fake', 'b'),
  extra: join(root, 'extra'),
};

let server: Server;
let port = 0;
let served = 0;

beforeAll(async () => {
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  mkdirSync(join(dirs.home, '.ssh'));
  writeFileSync(join(dirs.home, '.ssh', 'id_fake'), 'FAKE-PRIVATE-KEY\n');
  writeFileSync(join(dirs.home, 'notes.txt'), 'public notes\n');
  writeFileSync(join(dirs.wt, '.env'), 'FAKE_TOKEN=1\n');
  writeFileSync(join(dirs.wt, '.env.local'), 'FAKE_TOKEN=2\n');
  writeFileSync(join(dirs.wt, '.envrc'), 'not a secret\n');
  writeFileSync(join(dirs.wt, 'readme.md'), 'hello\n');
  writeFileSync(join(dirs.profile, 'own-login.json'), '{"fake":true}\n');
  writeFileSync(join(dirs.otherProfile, 'other-login.json'), '{"fake":true}\n');
  server = createServer((_request, response) => {
    served += 1;
    response.end('HELLO-FROM-HOST');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await sandbox.close();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  rmSync(root, { recursive: true, force: true });
});

function secrets(): readonly string[] {
  return resolveSecretPaths({ home: dirs.home, dataDir: join(root, 'data') });
}

function request(script: string, overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    launch: {
      cmd: 'sh',
      args: ['-c', script],
      cwd: dirs.wt,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dirs.home },
    },
    policy: { writeScope: 'worktree', network: { allow: [] } },
    worktree: dirs.wt,
    profileDirs: [dirs.profile],
    extraWritePaths: [],
    secretPaths: secrets(),
    domains: [],
    ...overrides,
  };
}

async function confined(script: string, overrides: Partial<SandboxRequest> = {}): Promise<Outcome> {
  return execute(await sandbox.wrap(request(script, overrides)));
}

describe('SrtSandbox without a mechanism', () => {
  it('says layer 3 is missing on Windows: no capabilities, not available, wrap refused', async () => {
    const windows = new SrtSandbox({ tempDir: join(root, 'win-tmp') }, { platform: 'win32' });
    expect(windows.capabilities()).toEqual({ fields: [] });
    const result = await windows.available();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/win32.*N94/);
    await expect(windows.wrap(request('true'))).rejects.toBeInstanceOf(AdapterUnavailable);
    await windows.close();
  });

  it('rejects a bad configuration and a relative path in the request', async () => {
    expect(() => new SrtSandbox({ mandatoryDenySearchDepth: 0 })).toThrow(InvalidInput);
    expect(() => new SrtSandbox({ nonsense: 1 } as never)).toThrow(InvalidInput);
    expect(() => new SrtSandbox({ tempDir: 'relative' })).toThrow(InvalidInput);
    await expect(sandbox.wrap(request('true', { worktree: 'relative/wt' }))).rejects.toBeInstanceOf(
      InvalidInput,
    );
  });

  it('declares the Sandbox port and the four fields it counts as the os layer where it works', () => {
    expect(sandbox.id).toBe('srt');
    expect(sandbox.implements).toEqual({ port: 'Sandbox', range: '^0.1.0' });
    if (process.platform === 'linux' || process.platform === 'darwin') {
      expect(sandbox.capabilities()).toEqual({
        fields: ['nativeTools', 'nativeShell', 'writeScope', 'network'],
      });
    }
  });
});

real('SrtSandbox in the operating system', () => {
  it('is available: a real confined command ran', () => {
    expect(availability).toEqual({ ok: true });
  });

  it('runs the command with its working directory and environment, and nothing from the daemon', async () => {
    const outcome = await confined('pwd; echo "home=$HOME"; echo "token=${OT_FAKE_TOKEN:-unset}"');
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain(dirs.wt);
    expect(outcome.stdout).toContain(`home=${dirs.home}`);
    expect(outcome.stdout).toContain('token=unset');
  });

  it('writes in the worktree, the own profile folder, the extra folder and the temp folder', async () => {
    const outcome = await confined(
      `echo a > "${dirs.wt}/new.txt" && echo b > "${dirs.profile}/new.txt" && echo c > "${dirs.extra}/new.txt" && echo d > "$TMPDIR/new.txt" && echo ok`,
      { extraWritePaths: [dirs.extra] },
    );
    expect(outcome.stdout).toContain('ok');
    expect(readFileSync(join(dirs.wt, 'new.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(dirs.extra, 'new.txt'), 'utf8')).toBe('c\n');
    expect(readFileSync(join(root, 'sandbox-tmp', 'new.txt'), 'utf8')).toBe('d\n');
  });

  it('a write outside the worktree fails in the operating system', async () => {
    const outcome = await confined(
      `echo x > "${dirs.outside}/stolen.txt"; echo "rc=$?"; echo x > "${dirs.otherProfile}/stolen.txt"; echo "rc=$?"; echo x > "${dirs.home}/stolen.txt"; echo "rc=$?"`,
    );
    expect(outcome.stdout.match(/rc=0/g)).toBeNull();
    expect(outcome.stdout.match(/rc=[1-9]/g)).toHaveLength(3);
    expect(outcome.stderr).toMatch(/Read-only file system|Permission denied|not permitted/i);
    expect(() => readFileSync(join(dirs.outside, 'stolen.txt'))).toThrow();
    expect(() => readFileSync(join(dirs.otherProfile, 'stolen.txt'))).toThrow();
    expect(() => readFileSync(join(dirs.home, 'stolen.txt'))).toThrow();
  });

  it('cannot delete or replace what lies outside the worktree either', async () => {
    const outcome = await confined(
      `rm -f "${dirs.home}/notes.txt"; echo "rm=$?"; mv "${dirs.home}/notes.txt" "${dirs.wt}/moved.txt"; echo "mv=$?"`,
    );
    expect(outcome.stdout).toMatch(/rm=[1-9]/);
    expect(outcome.stdout).toMatch(/mv=[1-9]/);
    expect(readFileSync(join(dirs.home, 'notes.txt'), 'utf8')).toBe('public notes\n');
  });

  it('a read of a secret path fails; its neighbour and the worktree can be read', async () => {
    const outcome = await confined(
      `cat "${dirs.home}/.ssh/id_fake"; echo "ssh=$?"; ls "${dirs.home}/.ssh"; echo "ls=$?"; cat "${dirs.home}/notes.txt"; echo "notes=$?"; cat "${dirs.wt}/readme.md"; echo "readme=$?"`,
    );
    expect(outcome.stdout).not.toContain('FAKE-PRIVATE-KEY');
    expect(outcome.stdout).not.toContain('id_fake');
    expect(outcome.stdout).toMatch(/ssh=[1-9]/);
    expect(outcome.stdout).toContain('public notes');
    expect(outcome.stdout).toContain('notes=0');
    expect(outcome.stdout).toContain('hello');
    expect(outcome.stdout).toContain('readme=0');
  });

  it('the data directory is secret, but the own profile folder of the client can be read and the others cannot', async () => {
    const outcome = await confined(
      `cat "${dirs.profile}/own-login.json"; echo "own=$?"; cat "${dirs.otherProfile}/other-login.json"; echo "other=$?"`,
    );
    expect(outcome.stdout).toContain('own=0');
    expect(outcome.stdout).toMatch(/other=[1-9]/);
    expect(outcome.stdout).not.toMatch(/"fake":true\}\s+other/);
  });

  it('.env files under the worktree cannot be read, .envrc and the rest can', async () => {
    const outcome = await confined(
      `cat "${dirs.wt}/.env"; echo "env=$?"; cat "${dirs.wt}/.env.local"; echo "local=$?"; cat "${dirs.wt}/.envrc"; echo "rc=$?"`,
    );
    expect(outcome.stdout).not.toContain('FAKE_TOKEN');
    expect(outcome.stdout).toMatch(/env=[1-9]/);
    expect(outcome.stdout).toMatch(/local=[1-9]/);
    expect(outcome.stdout).toContain('not a secret');
  });

  it('with no domain allowed, a direct connection to the host server fails in the operating system', async () => {
    const before = served;
    const outcome = await execute(
      await sandbox.wrap({
        ...request('true'),
        launch: {
          cmd: process.execPath,
          args: [
            '-e',
            `require('net').connect(${String(port)},'127.0.0.1').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',(e)=>{console.log('ERR',e.code);process.exit(3)})`,
          ],
          cwd: dirs.wt,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dirs.home },
        },
      }),
    );
    expect(outcome.stdout).not.toContain('CONNECTED');
    expect(outcome.stdout).toMatch(/ERR (ECONNREFUSED|ENETUNREACH|EACCES|EPERM)/);
    expect(served).toBe(before);
  });

  it('through the proxy, a domain outside the list is refused and one inside the list is served', async () => {
    const before = served;
    const url = (host: string) => `http://${host}:${String(port)}/`;
    const refused = await confined(`curl -sS -m 10 --noproxy '' ${url('127.0.0.1')}`, {
      domains: ['localhost'],
    });
    expect(refused.stdout).not.toContain('HELLO-FROM-HOST');
    expect(served).toBe(before);
    const none = await confined(`curl -sS -m 10 --noproxy '' ${url('localhost')}`);
    expect(none.stdout).not.toContain('HELLO-FROM-HOST');
    expect(served).toBe(before);
    const allowed = await confined(`curl -sS -m 10 --noproxy '' ${url('localhost')}`, {
      domains: ['localhost'],
    });
    expect(allowed.stdout).toContain('HELLO-FROM-HOST');
    expect(served).toBe(before + 1);
  });

  it('the allow list of the role policy counts as much as the one of the daemon', async () => {
    const outcome = await confined(
      `curl -sS -m 10 --noproxy '' http://localhost:${String(port)}/`,
      {
        policy: { writeScope: 'worktree', network: { allow: ['localhost'] } },
      },
    );
    expect(outcome.stdout).toContain('HELLO-FROM-HOST');
  });

  it('[V] a server the command starts inside has its own loopback: it is not reachable from outside', async () => {
    const inner = 47_000 + Math.floor(Math.random() * 1000);
    const launch = await sandbox.wrap(
      request(
        `node -e "require('http').createServer((q,s)=>s.end('INNER')).listen(${String(inner)},'127.0.0.1');setTimeout(()=>process.exit(0),4000)"`,
      ),
    );
    const running = execute(launch);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const probe = fetch(`http://127.0.0.1:${String(inner)}/`, {
      signal: AbortSignal.timeout(1500),
    }).then(
      async (response) => `reached ${await response.text()}`,
      (error: unknown) => `refused ${String((error as { cause?: { code?: string } }).cause?.code)}`,
    );
    expect(await probe).toMatch(/^refused (ECONNREFUSED|ETIMEDOUT|undefined)/);
    await running;
  });

  it('gives the same launch for the same request, so a shared process keeps its key', async () => {
    const one = await sandbox.wrap(request('true'));
    const two = await sandbox.wrap(request('true'));
    expect(two).toEqual(one);
    const other = await sandbox.wrap(request('true', { domains: ['localhost'] }));
    expect(other.args).not.toEqual(one.args);
  });

  it('refuses a malformed domain with InvalidInput', async () => {
    await expect(
      sandbox.wrap(request('true', { domains: ['https://not a domain/'] })),
    ).rejects.toBeInstanceOf(InvalidInput);
  });

  it('lets the exit code of the command through', async () => {
    const outcome = await confined('exit 7');
    expect(outcome.code).toBe(7);
  });
});

/**
 * N115: a server of the daemon on the loopback of the HOST, reached at `127.0.0.1:<port>` from a
 * command that has a network of its own. `curl` and the `fetch` of Node are the two clients that
 * matter: `NO_PROXY` sends both to the loopback of the sandbox, and `fetch` ignores the proxy.
 */
real('SrtSandbox bridge to a loopback server of the daemon (N115)', () => {
  let otherServer: Server;
  let otherPort = 0;
  let otherServed = 0;
  /** Linux only: bubblewrap is what gives the command a loopback of its own. */
  const onLinux = process.platform === 'linux';
  const linux = it.skipIf(!onLinux);

  beforeAll(async () => {
    otherServer = createServer((_request, response) => {
      otherServed += 1;
      response.end('OTHER-HOST-SERVER');
    });
    await new Promise<void>((resolve) => otherServer.listen(0, '127.0.0.1', resolve));
    otherPort = (otherServer.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) =>
      otherServer.close(() => {
        resolve();
      }),
    );
  });

  const fetchScript = (url: string): string =>
    `node -e "fetch('${url}').then(r=>r.text()).then(t=>console.log('GOT',t),e=>{console.log('ERR',e.cause&&e.cause.code);process.exit(3)})"`;

  linux(
    'without the bridge the same domain rule is not enough: curl and fetch are refused',
    async () => {
      const before = served;
      const domains = [`localhost:${String(port)}`];
      const curl = await confined(`curl -sS -m 10 http://127.0.0.1:${String(port)}/`, { domains });
      expect(curl.code).toBe(7);
      expect(curl.stdout).not.toContain('HELLO-FROM-HOST');
      const node = await confined(fetchScript(`http://127.0.0.1:${String(port)}/`), { domains });
      expect(node.stdout).toContain('ERR ECONNREFUSED');
      expect(served).toBe(before);
    },
  );

  linux(
    'with the bridge, curl and fetch reach the server at 127.0.0.1 and at localhost',
    async () => {
      const before = served;
      const loopbackPorts = [port];
      const url = (host: string) => `http://${host}:${String(port)}/x`;
      const curl = await confined(`curl -sS -m 10 ${url('127.0.0.1')}`, { loopbackPorts });
      expect(curl.code).toBe(0);
      expect(curl.stdout).toBe('HELLO-FROM-HOST');
      const node = await confined(fetchScript(url('127.0.0.1')), { loopbackPorts });
      expect(node.stdout).toContain('GOT HELLO-FROM-HOST');
      const name = await confined(`curl -sS -m 10 ${url('localhost')}`, { loopbackPorts });
      expect(name.stdout).toBe('HELLO-FROM-HOST');
      expect(served).toBe(before + 3);
    },
  );

  linux('the bridge opens the port it names and no other port of the host', async () => {
    const beforeOther = otherServed;
    const loopbackPorts = [port];
    const direct = await confined(`curl -sS -m 10 http://127.0.0.1:${String(otherPort)}/`, {
      loopbackPorts,
    });
    expect(direct.code).toBe(7);
    // Through the proxy (what a client that honours it does), the list of the command refuses it.
    const proxied = await confined(
      `curl -sS -m 10 --noproxy '' http://localhost:${String(otherPort)}/`,
      { loopbackPorts },
    );
    expect(proxied.stdout).not.toContain('OTHER-HOST-SERVER');
    expect(proxied.stdout + proxied.stderr).toMatch(
      /not on the allow list|blocked|403|Received HTTP code/i,
    );
    // A port bridged by hand inside the command is no better: the proxy decides, not the listener.
    const handmade = await confined(
      `socat TCP4-LISTEN:${String(otherPort)},bind=127.0.0.1,fork PROXY:localhost:localhost:${String(otherPort)},proxyport=3128,proxyauth="$CLOUDSDK_PROXY_USERNAME:$CLOUDSDK_PROXY_PASSWORD" >/dev/null 2>&1 & sleep 0.5; curl -sS -m 10 http://127.0.0.1:${String(otherPort)}/`,
      { loopbackPorts },
    );
    expect(handmade.stdout).not.toContain('OTHER-HOST-SERVER');
    expect(otherServed).toBe(beforeOther);
  });

  linux('bridges several ports at once', async () => {
    const before = served;
    const beforeOther = otherServed;
    const outcome = await confined(
      `curl -sS -m 10 http://127.0.0.1:${String(port)}/; echo; curl -sS -m 10 http://127.0.0.1:${String(otherPort)}/`,
      { loopbackPorts: [port, otherPort] },
    );
    expect(outcome.stdout).toContain('HELLO-FROM-HOST');
    expect(outcome.stdout).toContain('OTHER-HOST-SERVER');
    expect(served).toBe(before + 1);
    expect(otherServed).toBe(beforeOther + 1);
  });

  linux(
    'keeps the filter that blocks Unix sockets: the command cannot make one, bridge or not',
    async () => {
      const unix = join(root, 'host.sock');
      const host = await new Promise<import('node:net').Server>((resolve) => {
        const listener = createNetServer(() => undefined);
        listener.listen(unix, () => {
          resolve(listener);
        });
      });
      try {
        const outcome = await confined(
          `node -e "require('net').connect('${unix}').on('connect',()=>{console.log('UNIX-CONNECTED');process.exit(0)}).on('error',e=>{console.log('UNIX',e.code);process.exit(3)})"`,
          { loopbackPorts: [port] },
        );
        expect(outcome.stdout).not.toContain('UNIX-CONNECTED');
        expect(outcome.stdout).toMatch(/UNIX (EPERM|EACCES)/);
      } finally {
        await new Promise<void>((resolve) =>
          host.close(() => {
            resolve();
          }),
        );
      }
    },
  );

  linux(
    'does not change what the command is: arguments, exit status and the writes it may do',
    async () => {
      const loopbackPorts = [port];
      const exit = await confined('exit 7', { loopbackPorts });
      expect(exit.code).toBe(7);
      const args = await execute(
        await sandbox.wrap({
          ...request('true'),
          launch: {
            cmd: 'printf',
            args: ['%s|%s\\n', "it's", 'a b'],
            cwd: dirs.wt,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dirs.home },
          },
          loopbackPorts,
        }),
      );
      expect(args.stdout).toBe("it's|a b\n");
      const write = await confined(`echo x > "${dirs.outside}/bridge.txt"; echo "rc=$?"`, {
        loopbackPorts,
      });
      expect(write.stdout).toMatch(/rc=[1-9]/);
      expect(() => readFileSync(join(dirs.outside, 'bridge.txt'))).toThrow();
    },
  );

  it('refuses a port that is not a port, or that the relays of the library hold, with InvalidInput', async () => {
    for (const bad of [0, 70_000, 1.5, 3128, 1080]) {
      await expect(sandbox.wrap(request('true', { loopbackPorts: [bad] }))).rejects.toBeInstanceOf(
        InvalidInput,
      );
    }
  });

  it('gives the same launch for the same request and another one for another port list', async () => {
    const one = await sandbox.wrap(request('true', { loopbackPorts: [port] }));
    const two = await sandbox.wrap(request('true', { loopbackPorts: [port] }));
    expect(two).toEqual(one);
    const none = await sandbox.wrap(request('true'));
    expect(none.args).not.toEqual(one.args);
  });
});

/**
 * N129: inside the sandbox of the library `/proc/sys/user/max_user_namespaces` is 0, so a client with
 * a sandbox of its own (Codex) cannot start it. `allowNestedUserNamespaces` is per request, and with
 * it a command can make a user namespace. Measured by the owner on 2026-11-18 with `srt` 0.0.81 [V];
 * the test asks the operating system again. Linux only, and skipped where `unshare` does not work
 * on the host itself.
 */
const nestedPossible =
  process.platform === 'linux' && spawnSync('unshare', ['-Ur', 'true']).status === 0;
real('SrtSandbox nested user namespaces (N129)', () => {
  const nested = it.skipIf(!nestedPossible);

  nested('refuses a user namespace by default', async () => {
    const outcome = await confined('unshare -Ur true');
    expect(outcome.code).not.toBe(0);
  });

  nested('allows it for the request that asks, and only for that one', async () => {
    const asked = await confined('unshare -Ur true', { allowNestedUserNamespaces: true });
    expect(asked.code, asked.stderr).toBe(0);
    const next = await confined('unshare -Ur true');
    expect(next.code).not.toBe(0);
  });

  nested('keeps the write confinement of the worktree for what the command does', async () => {
    const outsideFile = join(dirs.outside, 'nested-write.txt');
    const outcome = await confined(`echo x > ${outsideFile}`, {
      allowNestedUserNamespaces: true,
    });
    expect(outcome.code).not.toBe(0);
    expect(() => readFileSync(outsideFile)).toThrow();
  });

  it('gives another launch for the request that asks', async () => {
    const plain = await sandbox.wrap(request('true'));
    const asked = await sandbox.wrap(request('true', { allowNestedUserNamespaces: true }));
    expect(asked.args).not.toEqual(plain.args);
    const again = await sandbox.wrap(request('true', { allowNestedUserNamespaces: true }));
    expect(again).toEqual(asked);
  });
});

real('SrtSandbox after close', () => {
  it('refuses to wrap and close is idempotent', async () => {
    const own = new SrtSandbox({ tempDir: join(root, 'own-tmp') });
    // The library keeps one manager per process: the shared sandbox above is released first.
    await sandbox.close();
    expect(await own.available()).toEqual({ ok: true });
    await own.close();
    await own.close();
    await expect(own.wrap(request('true'))).rejects.toBeInstanceOf(AdapterUnavailable);
  });
});
