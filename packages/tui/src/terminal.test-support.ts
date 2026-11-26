// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the TUI in an emulated terminal only (excluded from the build of the package).
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Backend, TuiTest as TuiTestClass } from '@microsoft/tui-test';
import { FAKE_AGENT_CLI, NO_LAUNCHER } from './chat/fake-agent.test-support.js';

/**
 * The compiled TUI in a real pseudo-terminal whose screen is emulated (N320, P17 of Phase 11b): the
 * `@microsoft/tui-test` runs the program in a pty (ConPTY on Windows), parses what it draws with the
 * engine of a real terminal (alacritty, xterm.js or ghostty) and answers by cells, colours and links,
 * as a person sees them. What `ink-testing-library` cannot see (the colours of the theme, the OSC 8
 * links, the mouse, a resize, Ctrl+C and the exit of the real binary) is tested here.
 *
 * Nothing real runs: the daemon is the one of the test (the fake agent, in temporary folders), the
 * HOME is a temporary one, and the variables of the person do not reach the TUI (they are blanked).
 */

/** The compiled app itself. */
export const TUI_MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
/** What the owner runs: `ot tui`, which starts the TUI as a child of the daemon CLI. */
export const OT_CLI = fileURLToPath(new URL('../../daemon/dist/cli.js', import.meta.url));
/** `OT_REQUIRE_PTY=1` turns each skip into a failure (the job of the CI that must run these tests). */
export const REQUIRE_PTY = process.env.OT_REQUIRE_PTY === '1';

/** The terminals the tests can run on; `OT_TUI_TEST_BACKEND` picks one, or `all`. */
export const TERMINAL_BACKENDS = ['alacritty', 'xtermjs', 'ghostty'] as const;
export type TerminalBackend = (typeof TERMINAL_BACKENDS)[number] & Backend;
/** The terminal when `OT_TUI_TEST_BACKEND` is not set [proposta, N320]. */
export const DEFAULT_TERMINAL_BACKEND: TerminalBackend = 'alacritty';

/** The terminals of `OT_TUI_TEST_BACKEND` (`alacritty`, `xtermjs`, `ghostty` or `all`). A typo fails. */
export function terminalBackendsOf(
  value: string | undefined = process.env.OT_TUI_TEST_BACKEND,
): readonly TerminalBackend[] {
  const mode = value?.trim() ?? '';
  if (mode === '') return [DEFAULT_TERMINAL_BACKEND];
  if (mode === 'all') return TERMINAL_BACKENDS;
  const found = TERMINAL_BACKENDS.find((backend) => backend === mode);
  if (found === undefined) {
    throw new Error(
      `OT_TUI_TEST_BACKEND=${mode}: use ${TERMINAL_BACKENDS.join(', ')} or all (default ${DEFAULT_TERMINAL_BACKEND})`,
    );
  }
  return [found];
}

/** Where the trace (`trace.md`) and the text of the screen of a failed test go: `OT_TUI_TEST_ARTIFACTS`. */
export const ARTIFACTS_DIR = artifactsDir(process.env.OT_TUI_TEST_ARTIFACTS);

function artifactsDir(value: string | undefined): string {
  const dir = value?.trim() ?? '';
  return dir === '' ? join(tmpdir(), 'otheater-tui-test') : dir;
}

type TuiTestModule = typeof import('@microsoft/tui-test');

/** The module, or why it cannot load here (no native binary for this platform). */
async function loadTuiTest(): Promise<TuiTestModule | string> {
  try {
    return await import('@microsoft/tui-test');
  } catch (error) {
    return `@microsoft/tui-test does not load on ${process.platform}-${process.arch}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const loaded = await loadTuiTest();

/** Why the tests cannot run here, or `undefined`. */
export function terminalUnavailable(): string | undefined {
  if (typeof loaded === 'string') return loaded;
  if (NO_LAUNCHER) return 'this platform has no process launcher (build native/job-launcher)';
  const missing = [TUI_MAIN, OT_CLI, FAKE_AGENT_CLI].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    return `not built, run "pnpm build" (${String(missing.length)} file(s) missing)`;
  }
  return undefined;
}

/** How the TUI is started: the compiled app itself, or `ot tui` (the CLI that spawns it). */
export type TuiEntry = 'main' | 'ot-tui';

export interface OpenTuiOptions {
  readonly backend: TerminalBackend;
  /** The data folder of the daemon the TUI connects to. */
  readonly dataDir: string;
  readonly entry?: TuiEntry;
  readonly columns?: number;
  readonly rows?: number;
  /** The name of the test, for the folder of its artifacts. */
  readonly name: string;
  /**
   * More of `ui` for the TUI of `main` (it goes as `OT_TUI_UI`, over {@link SAFE_UI}). The launcher of
   * `ot-tui` writes that variable from `config.yaml`, so a test of `ot-tui` puts its `ui` there.
   */
  readonly ui?: Readonly<Record<string, unknown>>;
}

/**
 * The `ui` a test starts with: no assistant over the layout, and a login never opens the browser of
 * the machine (`xdg-open`, `open` or `start` would open a real one).
 */
export const SAFE_UI = { setup: { open: 'never' }, login: { browser: 'off' } } as const;

/** The same, as the lines of a `config.yaml` (for the daemon of `ot-tui`, after `persistConfig`). */
export const SAFE_UI_YAML = 'ui:\n  setup:\n    open: never\n  login:\n    browser: "off"\n';

export interface TuiTerminal {
  readonly term: TuiTestClass;
  readonly home: string;
}

/** What survives of the person's variables on Windows: without them Node cannot start or open a socket. */
const WINDOWS_SYSTEM = new Set([
  'systemroot',
  'systemdrive',
  'windir',
  'pathext',
  'comspec',
  'path',
  'temp',
  'tmp',
  'programdata',
  'programfiles',
  'programfiles(x86)',
  'number_of_processors',
  'processor_architecture',
  'os',
]);

/** The variables that tell a program it runs in a CI. */
const CI_MARKERS = ['CI', 'CONTINUOUS_INTEGRATION'] as const;

/**
 * Takes the CI markers out of the variables of this test process, as a terminal of a person has
 * none. Blanking them is not enough: Ink 8 (`is-in-ci`) takes any value but `0` and `false` as a
 * CI, and then writes only the last frame, at the exit; `supports-color` turns the colours off when
 * `CI` exists at all. Either way the screen of the test stays empty or grey on the runners.
 */
function dropCiMarkers(): void {
  for (const key of CI_MARKERS) Reflect.deleteProperty(process.env, key);
}

/**
 * The variables of the TUI. The tui-test adds `env` to the variables of this process, so each of
 * those is blanked first (an empty value), except `PATH` and, on Windows, what the system needs.
 */
function tuiEnv(home: string, dataDir: string, entry: TuiEntry): Record<string, string> {
  dropCiMarkers();
  const keep = (key: string): boolean =>
    key === 'PATH' || (process.platform === 'win32' && WINDOWS_SYSTEM.has(key.toLowerCase()));
  const blanked = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => !keep(key))
      .map((key) => [key, '']),
  );
  return {
    ...blanked,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    OT_CLIENT_CONFIG_DIR: join(home, 'client'),
    ...(entry === 'ot-tui' ? { OT_DATA_DIR: dataDir } : {}),
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9._-]+/giu, '-').slice(0, 80);
}

/**
 * Runs `body` with the compiled TUI on the screen of `options.backend`, connected to the daemon of
 * `options.dataDir`. The session closes at the end. When `body` fails, the trace of the session
 * (`trace.md`, which an agent reads) and the text of the screen go to {@link ARTIFACTS_DIR}.
 */
export async function withTui(
  options: OpenTuiOptions,
  body: (tui: TuiTerminal) => Promise<void>,
): Promise<void> {
  if (typeof loaded === 'string') throw new Error(loaded);
  const { TuiTest } = loaded;
  const entry = options.entry ?? 'main';
  const artifacts = join(ARTIFACTS_DIR, `${safeName(options.name)}-${options.backend}`);
  const home = await mkdtemp(join(tmpdir(), 'otheater-tui-term-'));
  const term = TuiTest.ephemeral('ot-tui', {
    backend: options.backend,
    trace: { mode: 'on-failure', directory: join(artifacts, 'trace') },
    artifacts: { dir: join(artifacts, 'failure'), onFailure: 'text' },
    timeouts: { text: 20_000 },
  });
  let failed = false;
  try {
    await mkdir(join(home, 'AppData', 'Roaming'), { recursive: true });
    await mkdir(join(home, 'AppData', 'Local'), { recursive: true });
    const args = entry === 'main' ? [TUI_MAIN, '--data-dir', options.dataDir] : [OT_CLI, 'tui'];
    await term.run(process.execPath, args, {
      cols: options.columns ?? 120,
      rows: options.rows ?? 30,
      cwd: home,
      env: {
        ...tuiEnv(home, options.dataDir, entry),
        OT_TUI_UI: JSON.stringify({ ...SAFE_UI, ...options.ui }),
      },
    });
    await body({ term, home });
  } catch (error) {
    failed = true;
    try {
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(artifacts, 'screen.txt'), await term.text({ full: true }));
    } catch {
      // The session may be gone: the trace still tells what happened.
    }
    throw error;
  } finally {
    try {
      await term.close({ failed });
    } catch {
      await term.closeQuiet();
    }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
