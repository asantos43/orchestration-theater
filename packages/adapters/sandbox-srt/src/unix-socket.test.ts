// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LaunchOptions, SandboxRequest } from '@otheater/core';
import { SrtSandbox } from './srt-sandbox.js';

/**
 * N161: on macOS, Seatbelt refuses a confined command the loopback of the host (EPERM), so the MCP
 * server of the daemon is reached through a Unix socket in a folder of `unixSocketDirs`. These
 * tests ask Seatbelt itself: a socket of the listed folder answers, a socket elsewhere does not,
 * and the listed folder does not let the command create a socket of its own. Its own file, not
 * `srt-sandbox.test.ts`: the library keeps one global configuration per process, and the list of
 * folders is part of it. Only on macOS; on Linux the bridge is TCP (N115).
 *
 * Kept short: macOS limits the path of a Unix socket to 104 bytes.
 */
const darwin = process.platform === 'darwin';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ot-us-')));
const dirs = {
  sock: join(root, 's'),
  other: join(root, 'o'),
  wt: join(root, 'wt'),
  home: join(root, 'h'),
};
const sandbox = new SrtSandbox({ tempDir: join(root, 't'), unixSocketDirs: [dirs.sock] });
const availability = darwin ? await sandbox.available() : { ok: false };
const required = process.env.OT_REQUIRE_SANDBOX === '1';
const real = describe.runIf(darwin && (availability.ok || required));

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

function request(script: string): SandboxRequest {
  return {
    launch: {
      cmd: 'node',
      args: ['-e', script],
      cwd: dirs.wt,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dirs.home },
    },
    policy: { writeScope: 'worktree', network: { allow: [] } },
    worktree: dirs.wt,
    profileDirs: [],
    extraWritePaths: [],
    secretPaths: [],
    domains: [],
  };
}

async function confined(script: string): Promise<Outcome> {
  const outcome = await execute(await sandbox.wrap(request(script)));
  // The measurement is the point of these tests: the log of the CI keeps what Seatbelt answered.
  console.log(
    `[N161] ${script.slice(0, 60)}... -> exit ${String(outcome.code)}: ${outcome.stdout.trim()}`,
  );
  return outcome;
}

/** A GET over the Unix socket, with the `http` of Node: the same client a stdio shim would use. */
const getOver = (path: string): string =>
  `require('http').get({socketPath:${JSON.stringify(path)},path:'/mcp',headers:{host:'127.0.0.1'}},` +
  `r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log('GOT',b))})` +
  `.on('error',e=>{console.log('ERR',e.code);process.exit(3)})`;

let servers: Server[] = [];
const served = { sock: 0, other: 0, tcp: 0 };
let tcpPort = 0;

beforeAll(async () => {
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  if (!darwin) return;
  const listen = (path: string | number, name: 'sock' | 'other' | 'tcp') =>
    new Promise<Server>((resolve) => {
      const server = createServer((_request, response) => {
        served[name] += 1;
        response.end(`HELLO-${name.toUpperCase()}`);
      });
      const done = () => {
        resolve(server);
      };
      if (typeof path === 'number') server.listen(path, '127.0.0.1', done);
      else server.listen(path, done);
    });
  servers = [
    await listen(join(dirs.sock, 'd.sock'), 'sock'),
    await listen(join(dirs.other, 'x.sock'), 'other'),
    await listen(0, 'tcp'),
  ];
  tcpPort = (servers[2]?.address() as AddressInfo).port;
});

afterAll(async () => {
  await sandbox.close();
  for (const server of servers) {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
  rmSync(root, { recursive: true, force: true });
});

real('SrtSandbox Unix sockets of the daemon on macOS (N161)', () => {
  it('reaches the server of a socket in a listed folder', async () => {
    const before = served.sock;
    const outcome = await confined(getOver(join(dirs.sock, 'd.sock')));
    expect(outcome.stdout).toContain('GOT HELLO-SOCK');
    expect(served.sock).toBe(before + 1);
  });

  it('refuses a socket outside the listed folders', async () => {
    const before = served.other;
    const outcome = await confined(getOver(join(dirs.other, 'x.sock')));
    expect(outcome.code).toBe(3);
    expect(outcome.stdout).toMatch(/ERR E(PERM|ACCES)/);
    expect(served.other).toBe(before);
  });

  it('does not let the command create a socket in the listed folder', async () => {
    const path = join(dirs.sock, 'own.sock');
    const outcome = await confined(
      `require('net').createServer().listen(${JSON.stringify(path)},()=>{console.log('LISTENING');process.exit(0)})` +
        `.on('error',e=>{console.log('ERR',e.code);process.exit(3)})`,
    );
    expect(outcome.stdout).not.toContain('LISTENING');
    expect(outcome.code).toBe(3);
  });

  it('still refuses the loopback of the host over TCP', async () => {
    const before = served.tcp;
    const outcome = await confined(
      `require('net').connect(${String(tcpPort)},'127.0.0.1').on('connect',()=>{console.log('CONNECTED');process.exit(0)})` +
        `.on('error',e=>{console.log('ERR',e.code);process.exit(3)})`,
    );
    expect(outcome.stdout).not.toContain('CONNECTED');
    expect(outcome.stdout).toMatch(/ERR E(PERM|ACCES|CONNREFUSED)/);
    expect(served.tcp).toBe(before);
  });
});

describe('SrtSandbox unixSocketDirs (N161)', () => {
  it('refuses a relative folder', () => {
    expect(() => new SrtSandbox({ unixSocketDirs: ['rel/dir'] }, { platform: 'darwin' })).toThrow(
      /unixSocketDirs must be an absolute path/,
    );
  });

  it('accepts no folder by default', () => {
    expect(new SrtSandbox({}, { platform: 'darwin' }).config.unixSocketDirs).toEqual([]);
  });
});
