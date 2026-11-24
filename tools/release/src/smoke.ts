// SPDX-License-Identifier: MPL-2.0
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The acceptance of a built executable (Phase 10, P1): the same checks on every platform, run from
 * the outside, as a user would start it. Nothing real is touched: the home, the data and the PATH
 * of the children are temporary folders, the daemon listens on a loopback port the system picks,
 * and no client, agent or service is started.
 */
export interface SmokeOptions {
  readonly executable: string;
  /** When given, `--version` has to print exactly this. */
  readonly expectedVersion?: string | undefined;
  readonly log: (line: string) => void;
  /** Platform of the machine. Default: `process.platform`. For tests. */
  readonly platform?: NodeJS.Platform | undefined;
}

export interface SmokeStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number;
}

export interface SmokeResult {
  readonly ok: boolean;
  readonly steps: readonly SmokeStep[];
  /** Milliseconds from the start of the daemon to its "running" line: first start, then second. */
  readonly daemonColdMs: number | undefined;
  readonly daemonWarmMs: number | undefined;
}

/**
 * The config of the daemon in the data folder: the file vault (no keyring, no prompt) and no
 * scheduled backup, as the CLI tests of the daemon do.
 */
export const SMOKE_CONFIG = `ui:
  locale: en
adapters:
  vault: encrypted-file
vault:
  scrypt: { N: 16384, r: 8, p: 1 }
backup:
  when: manual
  content: store_only
`;

/** What the daemon prints when it is ready. */
export const DAEMON_READY = 'daemon running';

/** Exit code of an unknown internal mode, of a shim with no environment, or of the applier with no journal. [proposta] */
const EXIT_USAGE = 2;
/** Exit code of `run-adapter` when the adapter's entry script cannot be loaded (P13). [proposta] */
const EXIT_ADAPTER_FAILED = 4;
const ALT_SCREEN = '\u001b[?1049h';
const MOUSE_ON = '\u001b[?1000h';
const CTRL_Q = '\u0011';

interface Finished {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

interface Sandbox {
  readonly root: string;
  readonly data: string;
  readonly empty: string;
  readonly env: NodeJS.ProcessEnv;
}

function makeSandbox(platform: NodeJS.Platform): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), 'otheater-smoke-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const empty = path.join(root, 'empty-path');
  for (const dir of [home, data, empty]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(data, 'config.yaml'), SMOKE_CONFIG);
  const env: NodeJS.ProcessEnv = {
    // An empty PATH: no client, agent or `git` of the machine can be found by the children.
    PATH: empty,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'share'),
    XDG_STATE_HOME: path.join(home, 'state'),
    OT_CLIENT_CONFIG_DIR: path.join(root, 'client'),
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
  };
  if (platform === 'win32') {
    for (const key of ['SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return { root, data, empty, env };
}

function finish(child: ChildProcess, timeoutMs: number, input?: string): Promise<Finished> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    if (input !== undefined) child.stdin?.write(input);
    child.stdin?.end();
  });
}

function run(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
  input?: string,
): Promise<Finished> {
  return finish(
    spawn(executable, [...args], { env, stdio: 'pipe', windowsHide: true }),
    timeoutMs,
    input,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RunningDaemon {
  readonly child: ChildProcess;
  readonly done: Promise<Finished>;
  readonly readyMs: number;
}

/** Starts the daemon in the sandbox and waits for its "running" line; throws when it does not come. */
async function startDaemon(
  executable: string,
  sandbox: Sandbox,
  timeoutMs = 90_000,
): Promise<RunningDaemon> {
  const started = Date.now();
  const child = spawn(executable, ['daemon', '--data-dir', sandbox.data], {
    env: sandbox.env,
    stdio: 'pipe',
    windowsHide: true,
  });
  let seen = '';
  const state = { ready: false };
  child.stdout.on('data', (chunk: Buffer) => {
    seen += chunk.toString('utf8');
    if (seen.includes(DAEMON_READY)) state.ready = true;
  });
  const done = finish(child, 10 * 60_000);
  while (!state.ready) {
    if (Date.now() - started > timeoutMs || child.exitCode !== null) {
      child.kill('SIGKILL');
      const ended = await done;
      throw new Error(
        `the daemon did not get ready (exit ${String(ended.code)}): ${(ended.stderr || ended.stdout).slice(-400)}`,
      );
    }
    await sleep(100);
  }
  return { child, done, readyMs: Date.now() - started };
}

/** Stops the daemon: a graceful end on POSIX (exit 0), a kill on Windows, which has no SIGTERM. */
async function stopDaemon(daemon: RunningDaemon, platform: NodeJS.Platform): Promise<string> {
  daemon.child.kill(platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
  const timer = setTimeout(() => daemon.child.kill('SIGKILL'), 30_000);
  const ended = await daemon.done;
  clearTimeout(timer);
  if (platform === 'win32') return 'stopped';
  if (ended.code !== 0) {
    throw new Error(`the daemon ended with ${String(ended.code ?? ended.signal)}, not 0`);
  }
  return 'stopped with exit 0';
}

async function checkApi(sandbox: Sandbox, version: string | undefined): Promise<string> {
  const info = JSON.parse(readFileSync(path.join(sandbox.data, 'api.json'), 'utf8')) as {
    url: string;
  };
  const token = readFileSync(path.join(sandbox.data, 'api-token'), 'utf8').trim();
  const authorised = await fetch(`${info.url}/v1/status`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (authorised.status !== 200)
    throw new Error(`GET /v1/status answered ${String(authorised.status)}`);
  const status = (await authorised.json()) as { state?: string; version?: string };
  if (status.state !== 'running') throw new Error(`the daemon is "${String(status.state)}"`);
  if (version !== undefined && status.version !== version) {
    throw new Error(`the daemon says version ${String(status.version)}, not ${version}`);
  }
  const anonymous = await fetch(`${info.url}/v1/status`, { signal: AbortSignal.timeout(10_000) });
  if (anonymous.status !== 401) {
    throw new Error(`without a token the API answered ${String(anonymous.status)}`);
  }
  return `GET /v1/status 200 (version ${String(status.version)}), 401 without the token`;
}

/**
 * Opens the TUI in a pseudo terminal, waits for its first screen, presses Ctrl+Q and reads how it
 * ended. Python's `pty` is the way on POSIX (`script` differs between Linux and macOS, and the
 * runners have `python3`); a pseudo terminal is no real terminal, so none is needed. The PATH of the
 * TUI is the empty one the script sets before `exec`.
 */
export const PTY_SCRIPT = String.raw`
import fcntl, json, os, pty, select, signal, struct, sys, termios, time
exe, data, tui_path = sys.argv[1], sys.argv[2], sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.environ['PATH'] = tui_path
    os.execv(exe, [exe, '--ot-internal=tui', '--data-dir', data])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
out = b''
def pump(seconds, until=None):
    global out
    end = time.time() + seconds
    while time.time() < end:
        if until is not None and until():
            return True
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            out += chunk
    return until is None
shown = pump(30, lambda: b'OTheater' in out)
code = None
# On a fresh data folder the TUI opens the setup assistant, which Esc leaves; Ctrl+Q then ends the
# TUI. The keys count once the TUI listens, some time after its first frame, so both are pressed
# again every two seconds until the process ends.
pump(3)
end = time.time() + 40
while time.time() < end and code is None:
    for key in (b'\x1b', b'\x11'):
        try:
            os.write(fd, key)
        except OSError:
            pass
        pump(0.5)
    for _ in range(4):
        pump(0.3)
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
            break
if code is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    code = -9
text = out.decode('utf8', 'replace')
print(json.dumps({'code': code, 'shown': shown, 'alt': '\x1b[?1049h' in text, 'title': 'OTheater' in text, 'connected': 'Connecting to the daemon' not in text[-6000:] and 'No daemon is running' not in text, 'tail': text[-160:]}))
`;

async function checkTuiPty(executable: string, sandbox: Sandbox): Promise<string | undefined> {
  const env = { ...sandbox.env, PATH: process.env.PATH };
  const probe = await run('python3', ['-I', '-c', 'import pty'], env, 15_000);
  if (probe.code !== 0) return undefined;
  const ended = await run(
    'python3',
    ['-I', '-c', PTY_SCRIPT, executable, sandbox.data, sandbox.empty],
    env,
    120_000,
  );
  const line = ended.stdout.trim().split('\n').pop() ?? '';
  let report: {
    code: number;
    shown: boolean;
    alt: boolean;
    title: boolean;
    connected: boolean;
    tail: string;
  };
  try {
    report = JSON.parse(line) as typeof report;
  } catch {
    throw new Error(
      `the terminal harness gave no answer: ${(ended.stderr || ended.stdout).slice(-300)}`,
    );
  }
  if (!report.alt || !report.title || !report.shown) {
    throw new Error(
      `the TUI did not draw its screen (alt screen ${String(report.alt)}, title ${String(report.title)})`,
    );
  }
  if (!report.connected)
    throw new Error('the TUI did not get to the daemon (no screen past "Connecting")');
  if (report.code !== 0)
    throw new Error(
      `the TUI ended with ${String(report.code)} after Ctrl+Q, not 0 (last output: ${JSON.stringify(report.tail)})`,
    );
  return 'opened in a pseudo terminal, connected to the daemon, closed with Ctrl+Q (exit 0)';
}

/**
 * Where no pseudo terminal is at hand (Windows, or a machine without `python3`): the TUI is started
 * with plain pipes. Ink then refuses the input ("Raw mode is not supported") after the TUI set up
 * its terminal, so the check is that it got that far and ended on its own instead of hanging.
 */
async function checkTuiPiped(executable: string, sandbox: Sandbox): Promise<string> {
  const ended = await run(
    executable,
    ['--ot-internal=tui', '--data-dir', sandbox.data],
    sandbox.env,
    60_000,
    CTRL_Q,
  );
  if (ended.timedOut) throw new Error('the TUI did not end with the pipes closed');
  const output = ended.stdout + ended.stderr;
  if (!output.includes(MOUSE_ON) && !output.includes(ALT_SCREEN) && !output.includes('Raw mode')) {
    throw new Error(`the TUI left no sign of starting: ${output.slice(-300)}`);
  }
  return 'no pseudo terminal here: started on pipes, reached the terminal setup and ended by itself';
}

/** A server on a socket (a pipe on Windows) that stands for the MCP server of the daemon. */
async function listenFakeMcp(socketPath: string, seen: IncomingHttpHeaders[]): Promise<Server> {
  const server = createServer((request, response) => {
    seen.push(request.headers);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { pong: true } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function checkMcpShim(
  executable: string,
  sandbox: Sandbox,
  platform: NodeJS.Platform,
): Promise<string> {
  const socketPath =
    platform === 'win32'
      ? `\\\\.\\pipe\\otheater-smoke-${String(process.pid)}-${String(Date.now())}`
      : path.join(sandbox.root, 'mcp.sock');
  const seen: IncomingHttpHeaders[] = [];
  const server = await listenFakeMcp(socketPath, seen);
  try {
    const ended = await run(
      executable,
      ['--ot-internal=mcp-shim'],
      { ...sandbox.env, OT_MCP_SOCKET: socketPath, OT_MCP_AUTHORIZATION: 'Bearer smoke-token' },
      30_000,
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`,
    );
    if (ended.code !== 0) {
      throw new Error(`the shim ended with ${String(ended.code)}: ${ended.stderr.slice(-300)}`);
    }
    const answer = JSON.parse(ended.stdout.trim().split('\n')[0] ?? '') as {
      id?: number;
      result?: { pong?: boolean };
    };
    if (answer.id !== 1 || answer.result?.pong !== true) {
      throw new Error(`unexpected answer: ${ended.stdout}`);
    }
    if (seen[0]?.authorization !== 'Bearer smoke-token') {
      throw new Error('the shim did not send the authorization');
    }
    return 'relaunched by --ot-internal=mcp-shim, carried one request over the socket with the token';
  } finally {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
}

async function checkModes(executable: string, sandbox: Sandbox): Promise<string> {
  const unknown = await run(executable, ['--ot-internal=nonexistent'], sandbox.env, 30_000);
  if (unknown.code !== EXIT_USAGE) {
    throw new Error(
      `an unknown mode ended with ${String(unknown.code)}, not ${String(EXIT_USAGE)}`,
    );
  }
  const bare = await run(executable, ['--ot-internal=mcp-shim'], sandbox.env, 30_000);
  if (bare.code !== EXIT_USAGE || !bare.stderr.includes('OT_MCP_SOCKET')) {
    throw new Error(`the shim without its environment ended with ${String(bare.code)}`);
  }
  const apply = await run(executable, ['--ot-internal=apply-update'], sandbox.env, 30_000);
  // The applier (P8) is a real mode: with no `--journal` it is a usage error, like the shim with no environment.
  if (apply.code !== EXIT_USAGE || !apply.stderr.includes('--journal')) {
    throw new Error(`apply-update without its journal ended with ${String(apply.code)}`);
  }
  return `unknown mode and apply-update without --journal exit ${String(EXIT_USAGE)}`;
}

/**
 * `--ot-internal=run-adapter` (P13, N254 revised): the embedded Node loads the entry script of an ACP
 * adapter from disk, an ES module with top-level `await` that reads `process.argv`, as the managed
 * adapters under `<data>/adapters/` are. A stand-in script: the real adapters are not downloaded here.
 */
async function checkRunAdapter(executable: string, sandbox: Sandbox): Promise<string> {
  // A small module tree on disk, as a managed adapter is: the entry script, a sibling module it imports
  // by a relative specifier, a package under `node_modules` resolved through its ESM `exports`, a
  // dynamic `import()` and `import.meta.url`. Nothing is downloaded; every file is written here.
  const dir = path.join(sandbox.root, 'fake-adapter');
  const pkg = path.join(dir, 'node_modules', 'fake-dep');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({
      name: 'fake-dep',
      version: '0.0.0',
      type: 'module',
      exports: { '.': './index.js' },
    }),
  );
  writeFileSync(path.join(pkg, 'index.js'), "export const dep = 'dep-ok';\n");
  writeFileSync(path.join(dir, 'sibling.mjs'), "export const sibling = 'sibling-ok';\n");
  writeFileSync(path.join(dir, 'lazy.mjs'), "export default 'lazy-ok';\n");
  const entry = path.join(dir, 'fake-adapter.mjs');
  writeFileSync(
    entry,
    [
      "import { sibling } from './sibling.mjs';",
      "import { dep } from 'fake-dep';",
      'await Promise.resolve();',
      "const lazy = (await import('./lazy.mjs')).default;",
      "const here = import.meta.url.endsWith('/fake-adapter.mjs') ? 'url-ok' : 'url-bad';",
      "console.log(['adapter-ok', process.argv.slice(2).join(' '), sibling, dep, lazy, here].join(' '));",
      '',
    ].join('\n'),
  );
  const ran = await run(
    executable,
    ['--ot-internal=run-adapter', entry, 'one', 'two'],
    sandbox.env,
    30_000,
  );
  if (
    ran.code !== 0 ||
    !ran.stdout.includes('adapter-ok one two sibling-ok dep-ok lazy-ok url-ok')
  ) {
    throw new Error(`run-adapter ended with ${String(ran.code)}: ${ran.stderr.trim()}`);
  }
  const missing = await run(
    executable,
    ['--ot-internal=run-adapter', path.join(sandbox.root, 'nothing.mjs')],
    sandbox.env,
    30_000,
  );
  if (missing.code !== EXIT_ADAPTER_FAILED) {
    throw new Error(`run-adapter with no script ended with ${String(missing.code)}`);
  }
  return `run-adapter loads an ES module from disk (top-level await, a sibling, a package by its exports, a dynamic import, import.meta.url) with its arguments; a missing script exits ${String(EXIT_ADAPTER_FAILED)}`;
}

/** Runs the acceptance of the executable and logs one line per step. */
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const platform = options.platform ?? process.platform;
  const { executable } = options;
  const steps: SmokeStep[] = [];
  let daemonColdMs: number | undefined;
  let daemonWarmMs: number | undefined;

  const step = async (name: string, body: () => Promise<string>): Promise<boolean> => {
    const started = Date.now();
    let entry: SmokeStep;
    try {
      const detail = await body();
      entry = { name, ok: true, detail, ms: Date.now() - started };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      entry = { name, ok: false, detail, ms: Date.now() - started };
    }
    steps.push(entry);
    options.log(
      `${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name} (${String(entry.ms)} ms): ${entry.detail}`,
    );
    return entry.ok;
  };

  if (!existsSync(executable)) {
    options.log(`FAIL executable not found: ${executable}`);
    return { ok: false, steps, daemonColdMs, daemonWarmMs };
  }
  const sandbox = makeSandbox(platform);
  let version: string | undefined;
  try {
    await step('version', async () => {
      const ended = await run(executable, ['--version'], sandbox.env);
      const printed = ended.stdout.trim();
      if (ended.code !== 0 || !/^\d+\.\d+\.\d+/.test(printed)) {
        throw new Error(
          `--version gave "${printed}" (exit ${String(ended.code)}): ${ended.stderr.slice(-200)}`,
        );
      }
      if (options.expectedVersion !== undefined && printed !== options.expectedVersion) {
        throw new Error(`--version gave ${printed}, expected ${options.expectedVersion}`);
      }
      version = printed;
      return printed;
    });
    await step('help', async () => {
      const ended = await run(executable, ['--help'], sandbox.env);
      if (ended.code !== 0 || !ended.stdout.includes('Usage')) {
        throw new Error(`--help exit ${String(ended.code)}`);
      }
      return 'prints the usage';
    });
    await step('internal modes', () => checkModes(executable, sandbox));
    await step('run-adapter', () => checkRunAdapter(executable, sandbox));
    await step('mcp shim', () => checkMcpShim(executable, sandbox, platform));

    let daemon: RunningDaemon | undefined;
    const started = await step('daemon start', async () => {
      daemon = await startDaemon(executable, sandbox);
      daemonColdMs = daemon.readyMs;
      return `running after ${String(daemon.readyMs)} ms (first start: the .node files are extracted)`;
    });
    if (started && daemon !== undefined) {
      const running: RunningDaemon = daemon;
      await step('daemon api', () => checkApi(sandbox, version));
      await step('tui', async () => {
        const detail = platform === 'win32' ? undefined : await checkTuiPty(executable, sandbox);
        return detail ?? (await checkTuiPiped(executable, sandbox));
      });
      await step('daemon stop', () => stopDaemon(running, platform));
      // The second start finds the extracted addons: the "warm" time.
      await step('daemon restart', async () => {
        const again = await startDaemon(executable, sandbox);
        daemonWarmMs = again.readyMs;
        const how = await stopDaemon(again, platform);
        return `running after ${String(again.readyMs)} ms (warm), ${how}`;
      });
    }
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
  return { ok: steps.every((entry) => entry.ok), steps, daemonColdMs, daemonWarmMs };
}
