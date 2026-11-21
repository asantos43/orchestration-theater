// SPDX-License-Identifier: MPL-2.0
// Shared by the smoke test of the TUI in a real tmux only (excluded from the build of the package).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sgrReport } from './mouse/sgr.js';

/**
 * A real tmux for the smoke test of the TUI (P20 of docs/18, N191; `spikes/tui-keys` is the
 * reference, and it is not imported: spikes are disposable). Each {@link TmuxSession} owns a tmux
 * server of its own, on a socket of its own (`tmux -L <unique name>`), so the sessions of the person
 * who runs the tests are never touched, and it only ever kills that server.
 *
 * What the test must not depend on is fixed here: the size of the window, the `TERM` of the pane and
 * the options of tmux (an empty configuration file plus the few lines below, never the user's
 * `~/.tmux.conf`).
 */

/** The `TERM` of the program in the pane (a color terminal that Ink and the TUI know). */
export const PANE_TERM = 'xterm-256color';

/** The size the session starts with, whatever terminal runs the tests. */
export const START_SIZE = { columns: 120, rows: 36 } as const;

/** The longest a single tmux command may take; tmux answers in milliseconds, so this only catches a hang. */
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * How `tmux` runs here: the environment is reduced to what it needs, with no `TMUX` of the person
 * and a fixed locale (the screen is read as UTF-8 whatever the locale of the machine is; `-u` too).
 */
function tmuxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: 'en_US.UTF-8' };
  for (const name of ['PATH', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

interface Executed {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `tmux <args>`; never rejects (a failure is in `code`), but a hang is cut at the timeout. */
function runTmux(args: readonly string[], env: NodeJS.ProcessEnv = tmuxEnv()): Promise<Executed> {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      [...args],
      { env, timeout: COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** Whether a usable `tmux` is on the PATH (the answer to `tmux -V`), and its version line. */
export async function detectTmux(): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  const result = await runTmux(['-V']);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** `text` without the color and cursor sequences (`capture-pane` without `-e` has none, but be safe). */
function stripEscapes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

export interface TmuxStart {
  /** The program and its arguments, run directly (no shell). */
  readonly command: readonly string[];
  /** The environment of the program: only these variables and `TERM`, nothing of the person's. */
  readonly env: Readonly<Record<string, string>>;
  readonly size?: { readonly columns: number; readonly rows: number } | undefined;
}

/** One tmux server with one session `s`, started detached. */
export class TmuxSession {
  readonly socket: string;
  readonly #dir: string;
  readonly #seen = new Set<number>();
  /** The socket file; tmux leaves it behind when the server is killed, so `kill()` deletes it. */
  #socketPath: string;

  private constructor(socket: string, dir: string) {
    this.socket = socket;
    this.#dir = dir;
    // tmux puts the socket in `$TMUX_TMPDIR` (else /tmp), in a `tmux-<uid>` folder.
    this.#socketPath = join(
      process.env.TMUX_TMPDIR ?? '/tmp',
      `tmux-${String(process.getuid?.() ?? 0)}`,
      socket,
    );
  }

  /** Starts a server of its own and a session that runs `start.command`. */
  static async start(start: TmuxStart): Promise<TmuxSession> {
    const dir = await mkdtemp(join(tmpdir(), 'otheater-tmux-'));
    const socket = `ot-smoke-${String(process.pid)}-${randomBytes(4).toString('hex')}`;
    const session = new TmuxSession(socket, dir);
    try {
      const conf = join(dir, 'tmux.conf');
      // The pane's TERM comes from `default-terminal`; the keys go through `send-keys`, which does
      // not wait for the escape time, so a key such as Esc followed by a letter is never merged.
      await writeFile(
        conf,
        [
          `set -g default-terminal "${PANE_TERM}"`,
          'set -g escape-time 0',
          'set -g history-limit 2000',
          'set -g remain-on-exit off',
          'set -g status off',
          '',
        ].join('\n'),
      );
      const size = start.size ?? START_SIZE;
      const envArgs = Object.entries({ ...start.env, TERM: PANE_TERM }).flatMap(([name, value]) => [
        '-e',
        `${name}=${value}`,
      ]);
      const result = await runTmux([
        '-u',
        '-L',
        socket,
        '-f',
        conf,
        'new-session',
        '-d',
        '-s',
        's',
        '-x',
        String(size.columns),
        '-y',
        String(size.rows),
        ...envArgs,
        ...start.command,
      ]);
      if (result.code !== 0) throw new Error(`tmux new-session failed: ${result.stderr.trim()}`);
      await session.#learnSocketPath();
      return session;
    } catch (error) {
      await session.kill();
      throw error;
    }
  }

  /** Asks the server where its socket is, which is the truth the guess from the folder only mirrors. */
  async #learnSocketPath(): Promise<void> {
    const asked = await this.#tmux('display-message', '-p', '#{socket_path}');
    const path = asked.stdout.trim();
    if (asked.code === 0 && path !== '') this.#socketPath = path;
  }

  async #tmux(...args: string[]): Promise<Executed> {
    return runTmux(['-u', '-L', this.socket, ...args]);
  }

  /** What is on the screen now, line by line (no color), trailing blanks trimmed. */
  async screen(): Promise<string> {
    const result = await this.#tmux('capture-pane', '-p', '-t', 's');
    if (result.code !== 0) return '';
    return stripEscapes(result.stdout)
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trimEnd();
  }

  /** Sends keys by their tmux names (`C-q`, `M-a`, `F5`, `Enter`, `Escape`, `Tab`, `BTab`...). */
  async keys(...names: string[]): Promise<void> {
    const result = await this.#tmux('send-keys', '-t', 's', ...names);
    if (result.code !== 0) throw new Error(`tmux send-keys failed: ${result.stderr.trim()}`);
  }

  /** Types `text` as literal characters (no key name is interpreted). */
  async type(text: string): Promise<void> {
    const result = await this.#tmux('send-keys', '-t', 's', '-l', '--', text);
    if (result.code !== 0) throw new Error(`tmux send-keys failed: ${result.stderr.trim()}`);
  }

  /**
   * A left click on the cell `col`, `row` (0-based, as `screen()` has them): the SGR report of the
   * press and of the release, written to the pane as the terminal would (`tmux send-keys -l`; the
   * program in the pane asks for the mouse by its own terminal modes, which this does not need).
   */
  async click(col: number, row: number): Promise<void> {
    await this.type(sgrReport({ action: 'press', button: 'left', col, row }));
    await this.type(sgrReport({ action: 'release', button: 'left', col, row }));
  }

  async resize(columns: number, rows: number): Promise<void> {
    const result = await this.#tmux(
      'resize-window',
      '-t',
      's',
      '-x',
      String(columns),
      '-y',
      String(rows),
    );
    if (result.code !== 0) throw new Error(`tmux resize-window failed: ${result.stderr.trim()}`);
  }

  /** The size of the window as tmux has it. */
  async size(): Promise<{ columns: number; rows: number }> {
    const result = await this.#tmux(
      'display-message',
      '-p',
      '-t',
      's',
      '#{window_width}x#{window_height}',
    );
    const match = /^(\d+)x(\d+)$/.exec(result.stdout.trim());
    if (match === null) throw new Error(`tmux gave no size: ${result.stderr.trim()}`);
    return { columns: Number(match[1]), rows: Number(match[2]) };
  }

  /** Whether the program of the pane is still running. */
  async alive(): Promise<boolean> {
    const result = await this.#tmux('list-panes', '-t', 's', '-F', '#{pane_dead}');
    return result.code === 0 && result.stdout.trim() === '0';
  }

  /** Waits (real time, short steps) until the screen matches `text`; the failure shows the screen. */
  async waitFor(text: string | RegExp, timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const last = await this.screen();
      if (typeof text === 'string' ? last.includes(text) : text.test(last)) return last;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${String(text)} on the screen:\n${last}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Waits until `ready(screen)` is true; the failure names `what` and shows the last screen. */
  async waitForScreen(
    ready: (screen: string) => boolean,
    what: string,
    timeoutMs = 20_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = await this.screen();
      if (ready(screen)) return screen;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${what}:\n${screen}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Waits until the screen no longer matches `text`. */
  async waitGone(text: string | RegExp, timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = await this.screen();
      if (!(typeof text === 'string' ? screen.includes(text) : text.test(screen))) return screen;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${String(text)} to leave the screen:\n${screen}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Waits for the program of the pane to end by itself (the pane is gone or dead). */
  async waitExit(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (await this.alive()) {
      if (Date.now() > deadline)
        throw new Error(`The program did not exit:\n${await this.screen()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * The pane's process and everything below it, as `ps` sees them (empty when it cannot be known).
   * Every pid seen is remembered, so `kill()` checks them even after the program ended by itself.
   */
  async processTree(): Promise<number[]> {
    const pane = await this.#tmux('list-panes', '-t', 's', '-F', '#{pane_pid}');
    const root = Number(pane.stdout.trim().split('\n')[0]);
    if (!Number.isInteger(root) || root <= 1) return [];
    const children = new Map<number, number[]>();
    const ps = await new Promise<string>((resolve) => {
      execFile(
        'ps',
        ['-A', '-o', 'pid=,ppid='],
        { timeout: COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8' },
        (error, stdout) => {
          resolve(error === null ? stdout : '');
        },
      );
    });
    for (const line of ps.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid === undefined || ppid === undefined || Number.isNaN(pid) || Number.isNaN(ppid))
        continue;
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
    const found = [root];
    for (const pid of found) found.push(...(children.get(pid) ?? []));
    for (const pid of found) this.#seen.add(pid);
    return found;
  }

  /**
   * Kills the tmux server only, as closing the window of a terminal does: the pty goes away under
   * the program, which gets no key and no signal from the test. The pane's process tree is
   * remembered first; `waitProcessesGone` then says whether it ended by itself.
   */
  async killServer(): Promise<number[]> {
    const tree = await this.processTree();
    await this.#tmux('kill-server');
    return tree;
  }

  /** Waits for these pids to end by themselves; returns the ones still running at the deadline. */
  async waitProcessesGone(pids: readonly number[], timeoutMs: number): Promise<number[]> {
    const deadline = Date.now() + timeoutMs;
    let left = pids.filter(isRunning);
    while (left.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      left = left.filter(isRunning);
    }
    return left;
  }

  /**
   * Kills this server (and so the programs in its pane) and deletes its folder and its socket file. Safe to call twice
   * and after a failed start; it never touches another tmux server. Whatever of the pane's process
   * tree is still running after a few seconds is killed by its pid and the call FAILS, so a program
   * that outlives its test is never silent.
   */
  async kill(): Promise<void> {
    await this.processTree();
    const tree = [...this.#seen];
    // Without a server (a start that failed before it existed) this is a harmless error.
    await this.#tmux('kill-server');
    const deadline = Date.now() + 5_000;
    let left = tree.filter(isRunning);
    while (left.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      left = left.filter(isRunning);
    }
    for (const pid of left) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // It ended in the meantime.
      }
    }
    await rm(this.#dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(this.#socketPath, { force: true });
    if (left.length > 0) {
      throw new Error(`Processes outlived the tmux server and were killed: ${left.join(', ')}`);
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
