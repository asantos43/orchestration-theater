// SPDX-License-Identifier: MPL-2.0
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * What the tests of `installer/install.sh` (Phase 10, P5) are made of: the script itself, a server
 * of releases on the loopback (nothing leaves the machine), a fake `ot` (a shell script whose calls
 * are logged, so no service is ever touched) and a runner that gives the script a temporary HOME.
 * Tests only.
 */

export const INSTALL_SH = fileURLToPath(
  new URL('../../../../installer/install.sh', import.meta.url),
);

/** The platform id of this machine in the names of the release files, or `undefined` (not in v1). */
export function hostPlatform(): string | undefined {
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  return undefined;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type VerifyBehaviour = 'accept' | 'reject' | 'absent';

/**
 * A fake `ot`. `--version` answers; `service ...` and `uninstall` append their arguments to
 * `$HOME/fake-ot-calls.log`; `--ot-internal=verify-release <manifest> <signature>` is what the
 * script falls back to when openssl cannot check Ed25519 (the real handler comes with the P7 and P9
 * wiring), and the fake accepts, rejects or is "not available" (exit 3, the answer of a build
 * without the mode).
 */
export function fakeExe(verify: VerifyBehaviour = 'accept', marker = 'a'): Buffer {
  const verifyBody = {
    accept:
      'if [ -s "$2" ] && [ -s "$3" ]; then echo "verify-release ok" >> "$HOME/fake-ot-calls.log"; exit 0; fi; exit 1',
    reject: 'exit 1',
    absent: 'echo "not available in this build" >&2; exit 3',
  }[verify];
  return Buffer.from(
    `#!/bin/sh
# fake ot, build ${marker}
case "$1" in
  --version) echo "otheater 1.2.3" ;;
  --ot-internal=verify-release) ${verifyBody} ;;
  service | uninstall) echo "$*" >> "$HOME/fake-ot-calls.log" ;;
esac
exit 0
`,
  );
}

export interface ReleaseServer {
  /** `http://127.0.0.1:<port>/releases`, with no trailing slash. */
  readonly base: string;
  /** The paths asked, in order. */
  readonly requests: string[];
  /** What is served under `/releases/<name>`; a missing name is a 404. */
  readonly files: Map<string, Buffer | string>;
  close(): Promise<void>;
}

export async function startReleaseServer(
  files = new Map<string, Buffer | string>(),
): Promise<ReleaseServer> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(path);
    const name = path.startsWith('/releases/') ? path.slice('/releases/'.length) : undefined;
    const body = name === undefined ? undefined : files.get(name);
    if (body === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(port)}/releases`,
    requests,
    files,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
        server.closeAllConnections();
      }),
  };
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `sh installer/install.sh` with a clean environment: only the PATH of this process and what
 * the test gives. `detached` makes the child a session leader, so it has no controlling terminal
 * and a question on /dev/tty cannot hang a test.
 */
export function runInstaller(
  args: readonly string[],
  env: Record<string, string | undefined>,
  options: { readonly input?: string; readonly timeoutMs?: number } = {},
): Promise<RunResult> {
  const clean: Record<string, string> = { LANG: 'en_US.UTF-8' };
  if (process.env.PATH !== undefined) clean.PATH = process.env.PATH;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) clean[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [INSTALL_SH, ...args], {
      env: clean,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 60_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}

/** Calls a function of the script (loaded with `OT_INSTALL_LIB=1`, so nothing runs) and returns what it prints. */
export function callInstallerFunction(
  name: string,
  args: readonly string[],
  options: { readonly input?: string; readonly env?: Record<string, string> } = {},
): { readonly code: number | null; readonly stdout: string } {
  const result = spawnSync('sh', ['-c', '. "$1"; shift; "$@"', 'sh', INSTALL_SH, name, ...args], {
    env: { PATH: process.env.PATH ?? '', OT_INSTALL_LIB: '1', ...options.env },
    input: options.input ?? '',
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout };
}
