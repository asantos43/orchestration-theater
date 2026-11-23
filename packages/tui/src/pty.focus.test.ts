// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FAKE_AGENT_CLI,
  NO_LAUNCHER,
  startChatDaemon,
  type ChatDaemon,
} from './chat/fake-agent.test-support.js';
import { sgrReport } from './mouse/sgr.js';

/**
 * The clicks of the terminal of the Claude desktop, on the real process (the 2026-11-22 report: "I
 * cannot activate the areas by clicking them"). The compiled TUI runs in a real pseudo-terminal
 * (the `pty` module of Python, which is what `tmux` would give without `tmux`, and without its
 * rewriting of the mouse reports), the terminal starts at 120x30 and is made 213x83 by a resize
 * (SIGWINCH), as the panel of the desktop app does when it shows up. The test then writes the bytes
 * that terminal was measured to send for one click, as three chunks of their own: the press, a
 * move with the button down on the SAME cell, and the release. It reads what the TUI draws and
 * checks that the bar of shortcuts is the one of the area that was clicked.
 *
 * The screen is not emulated: the bar of shortcuts is a whole line that Ink rewrites when the focus
 * changes, so the bytes drawn after a click (without the colors) carry the new bar. That is why the clicks alternate
 * between the areas: a click on the area that already has the focus draws nothing new.
 *
 * Nothing real runs: the daemon is the one of the smoke test of the TUI (the fake agent), in
 * temporary folders, and the HOME is a temporary one. The test skips where there is no Python 3 or
 * no build; `OT_REQUIRE_PTY=1` turns each of those skips into a failure.
 */

const TUI_MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
/** What the owner runs: `ot tui`, which starts the TUI as a child of the daemon CLI. */
const OT_CLI = fileURLToPath(new URL('../../daemon/dist/cli.js', import.meta.url));
const REQUIRE = process.env.OT_REQUIRE_PTY === '1';
const TEST_TIMEOUT = 90_000;

/** The driver: runs the command in a pty, applies the steps, returns what each `mark` drew since the one before. */
const DRIVER = String.raw`
import codecs, fcntl, json, os, pty, re, select, signal, struct, sys, termios, time

spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec['cwd'])
    os.execvpe(spec['argv'][0], spec['argv'], spec['env'])

def set_size(cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

CSI = re.compile(r'\x1b\[[0-9;?<>=]*[ -/]*[@-~]')
decoder = codecs.getincrementaldecoder('utf-8')('replace')
drawn = ''

def pump(quiet_ms, max_ms):
    """Reads until nothing came for quiet_ms (or max_ms went by); False when the child is gone."""
    global drawn
    start = last = time.time()
    while True:
        now = time.time()
        if now - last >= quiet_ms / 1000 or now - start >= max_ms / 1000:
            return True
        ready, _, _ = select.select([fd], [], [], 0.05)
        if fd not in ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            return False
        if not data:
            return False
        drawn += decoder.decode(data)
        last = time.time()

set_size(spec['cols'], spec['rows'])
marks = {}
try:
    # The TUI is up when its bar of shortcuts is on the screen (the first bytes can take a while).
    deadline = time.time() + 30
    while 'Side bar' not in CSI.sub('', drawn) and time.time() < deadline:
        pump(300, 1000)
    pump(800, 5000)
    drawn = ''
    for step in spec['steps']:
        if 'resize' in step:
            cols, rows = step['resize']
            set_size(cols, rows)
            os.kill(pid, signal.SIGWINCH)
            pump(1200, 10000)
        elif 'send' in step:
            os.write(fd, step['send'].encode('utf-8'))
            pump(60, 2000)
        elif 'settle' in step:
            pump(step['settle'], 10000)
        elif 'until' in step:
            # Waits for the text (a loaded machine takes longer), then lets the rest of the frame come.
            deadline = time.time() + 6
            while step['until'] not in CSI.sub('', drawn) and time.time() < deadline:
                pump(200, 500)
            pump(200, 2000)
        elif 'mark' in step:
            marks[step['mark']] = CSI.sub('', drawn)
            drawn = ''
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    pump(300, 3000)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
print(json.dumps(marks))
`;

interface DriverStep {
  readonly send?: string;
  readonly resize?: readonly [number, number];
  readonly settle?: number;
  readonly until?: string;
  readonly mark?: string;
}

function hasPython(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('python3', ['-I', '-c', 'import pty'], { timeout: 10_000 }, (error) => {
      resolve(error === null);
    });
  });
}

async function unavailable(): Promise<string | undefined> {
  if (process.platform === 'win32') return 'there is no pty on Windows';
  // The bytes of the clicks were measured in the terminal of the desktop app on Linux. On the macOS
  // runner of the CI no click changed the bar (not explained yet), so the test only runs on Linux.
  if (process.platform !== 'linux') return `only measured on Linux, not on ${process.platform}`;
  if (!(await hasPython())) return 'python3 was not found on the PATH';
  if (NO_LAUNCHER) return 'this platform has no process launcher';
  const missing = [TUI_MAIN, OT_CLI, FAKE_AGENT_CLI].filter((file) => !existsSync(file));
  if (missing.length > 0)
    return `not built, run "pnpm build" (${String(missing.length)} file(s) missing)`;
  return undefined;
}

const skipReason = await unavailable();
const suite = skipReason === undefined || REQUIRE ? describe : describe.skip;

/** The terminal of the desktop app after the panel showed up. */
const START = { columns: 120, rows: 30 };
const SHOWN = { columns: 213, rows: 83 };

/** A cell well inside each area at `SHOWN`: the side bar, the chat and the work panel. */
const AREAS = {
  sidebar: { col: 10, row: 12, bar: 'New project' },
  chat: { col: 40, row: 12, bar: 'PageUp  Scroll' },
  panel: { col: 150, row: 12, bar: 'Enter  Fold' },
} as const;

/** The press, the move on the same cell and the release, each in a chunk of its own. */
function clickSteps(col: number, row: number, until: string, mark: string): DriverStep[] {
  const at = { col, row };
  return [
    { send: sgrReport({ action: 'press', button: 'left', ...at }) },
    { send: sgrReport({ action: 'drag', button: 'left', ...at }) },
    { send: sgrReport({ action: 'release', button: 'left', ...at }) },
    { until },
    { mark },
  ];
}

let chat: ChatDaemon | undefined;
let home: string | undefined;
let scripts: string | undefined;

suite(
  skipReason === undefined
    ? `the clicks on the TUI in a real pty (${process.platform})`
    : `the clicks on the TUI in a real pty (skipped: ${skipReason})`,
  () => {
    if (skipReason !== undefined) {
      it('can run here', () => {
        throw new Error(`The test of the clicks in a pty cannot run: ${skipReason}`);
      });
      return;
    }

    beforeEach(async () => {
      chat = await startChatDaemon(
        {
          codeHost: new FakeCodeHost(),
          clock: new FakeClock(),
          vault: new InMemorySecretVault(),
          client: (launcher, command, env) =>
            new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
        },
        // The assistant of the first run would take the screen; the test is about the areas.
        { extra: 'ui:\n  setup:\n    open: never\n' },
      );
      home = await mkdtemp(join(tmpdir(), 'otheater-pty-home-'));
      scripts = await mkdtemp(join(tmpdir(), 'otheater-pty-driver-'));
    }, TEST_TIMEOUT);

    afterEach(async () => {
      try {
        await chat?.dispose();
      } finally {
        await rm(home ?? '', { recursive: true, force: true });
        await rm(scripts ?? '', { recursive: true, force: true });
      }
    }, 60_000);

    /** How the TUI is started: the compiled app itself, or `ot tui` (the CLI that spawns it). */
    type Entry = 'main' | 'ot-tui';

    function drive(
      steps: readonly DriverStep[],
      entry: Entry = 'main',
    ): Promise<Record<string, string>> {
      return new Promise((resolve, reject) => {
        void (async () => {
          if (chat === undefined || home === undefined || scripts === undefined) {
            reject(new Error('the fixture is not up'));
            return;
          }
          const driver = join(scripts, 'driver.py');
          await writeFile(driver, DRIVER);
          const spec = {
            argv:
              entry === 'main'
                ? [process.execPath, TUI_MAIN, '--data-dir', chat.dataDir]
                : [process.execPath, OT_CLI, 'tui'],
            cwd: home,
            // What the desktop app measured: `TERM` and `TERM_PROGRAM`; nothing of the person's.
            env: {
              HOME: home,
              USERPROFILE: home,
              XDG_CONFIG_HOME: join(home, 'config'),
              OT_CLIENT_CONFIG_DIR: join(home, 'client'),
              ...(entry === 'ot-tui' ? { OT_DATA_DIR: chat.dataDir } : {}),
              LANG: 'en_US.UTF-8',
              LC_ALL: 'en_US.UTF-8',
              PATH: process.env.PATH ?? '',
              TERM: 'xterm-256color',
              TERM_PROGRAM: 'claude-desktop',
            },
            cols: START.columns,
            rows: START.rows,
            steps,
          };
          execFile(
            'python3',
            ['-I', driver, JSON.stringify(spec)],
            { timeout: 80_000, killSignal: 'SIGKILL', maxBuffer: 1 << 27 },
            (error, stdout, stderr) => {
              if (error !== null) reject(new Error(`${error.message}\n${stderr}`));
              else resolve(JSON.parse(stdout) as Record<string, string>);
            },
          );
        })();
      });
    }

    it.each(['main', 'ot-tui'] as const)(
      'gives the focus to each area by a click, after the terminal was resized (%s)',
      async (entry) => {
        const order = ['sidebar', 'panel', 'chat', 'panel', 'sidebar', 'chat'] as const;
        const steps: DriverStep[] = [
          { resize: [SHOWN.columns, SHOWN.rows] },
          { mark: 'resized' },
          ...order.flatMap((area, index) =>
            clickSteps(
              AREAS[area].col,
              AREAS[area].row,
              AREAS[area].bar,
              `${String(index)}:${area}`,
            ),
          ),
        ];
        const marks = await drive(steps, entry);
        // The layout follows the resize: the panel is drawn at the right of the 213 columns.
        expect(marks.resized).toContain('Overview');
        order.forEach((area, index) => {
          expect(marks[`${String(index)}:${area}`], `the click on the ${area}`).toContain(
            AREAS[area].bar,
          );
        });
      },
      TEST_TIMEOUT,
    );
  },
);
