// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
  waitUntil,
  type ChatDaemon,
} from './chat/fake-agent.test-support.js';
import { PANE_TERM, TmuxSession, detectTmux } from './tmux.test-support.js';

/**
 * The smoke test of the TUI in a real tmux (P20 of docs/18, N191; architecture 5.13): the compiled
 * TUI runs in a pane, against the real daemon with the fake agent, and the test sends the keys of
 * the registry with `tmux send-keys` and reads the frames with `tmux capture-pane`, as the
 * `spikes/tui-keys` did for the keys alone. It proves what the tests over `ink-testing-library`
 * cannot: the real process, the real terminal modes, the real Node entry and the `ot` command that
 * starts it. It does not prove that a Windows Terminal or a Terminal.app sends those keys: that is
 * the manual script, `tools/acceptance/tui-terminals.md`.
 *
 * What it does not depend on: the size of the terminal that runs the tests (the window is 120x36 and
 * is resized by tmux), its `TERM` (the pane has `xterm-256color`), the tmux of the person (a socket
 * of its own, `tmux -L`, and a configuration file of its own) and the HOME of the person (a
 * temporary one, with the client folder in it). Nothing real runs (N57): no client is started but
 * the fake agent. The tmux server of each test is killed in `afterEach`, and the test fails if a
 * process of the pane outlives it.
 *
 * The CI Linux job installs tmux and sets `OT_REQUIRE_TMUX=1`: there a missing tmux (or a missing
 * build) fails the test instead of skipping it. Anywhere else it skips, and the title says why.
 */

const TUI_MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const OT_CLI = fileURLToPath(new URL('../../daemon/dist/cli.js', import.meta.url));
const REQUIRE = process.env.OT_REQUIRE_TMUX === '1';

/** Why the smoke test cannot run here, or `undefined` when it can. */
async function unavailable(): Promise<string | undefined> {
  if (process.platform === 'win32') return 'tmux does not run on Windows';
  if ((await detectTmux()) === undefined) return 'tmux was not found on the PATH';
  if (NO_LAUNCHER) return 'this platform has no process launcher';
  const missing = [TUI_MAIN, OT_CLI, FAKE_AGENT_CLI].filter((file) => !existsSync(file));
  if (missing.length > 0)
    return `not built, run "pnpm build" (${String(missing.length)} file(s) missing)`;
  return undefined;
}

const skipReason = await unavailable();
const suite = skipReason === undefined || REQUIRE ? describe : describe.skip;
const TEST_TIMEOUT = 90_000;

/** The columns a line takes (its characters, not its UTF-16 units). */
function width(line: string): number {
  return Array.from(line).length;
}
const SIZE = { columns: 120, rows: 36 };

let chat: ChatDaemon;
let home: string;
let session: TmuxSession | undefined;

suite(
  skipReason === undefined
    ? `the TUI in a real tmux (${process.platform})`
    : `the TUI in a real tmux (skipped: ${skipReason})`,
  () => {
    if (skipReason !== undefined) {
      // Only reached with OT_REQUIRE_TMUX=1 (otherwise the suite is skipped): the CI must not pass
      // without having run the smoke test.
      it('can run here', () => {
        throw new Error(`The smoke test of the TUI in tmux cannot run: ${skipReason}`);
      });
      return;
    }

    // A daemon and a home of their own for each test: the layout (open tabs, folded sections) is
    // kept by the daemon, so a test never starts from what the one before it left.
    beforeEach(async () => {
      chat = await startChatDaemon(
        {
          codeHost: new FakeCodeHost(),
          clock: new FakeClock(),
          vault: new InMemorySecretVault(),
          client: (launcher, command, env) =>
            new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
        },
        // The daemon of the smoke names no preset, so the setup assistant (P17) would take the
        // screen on the first run: the smoke is about the layout, so it keeps the assistant closed.
        { extra: 'ui:\n  setup:\n    open: never\n' },
      );
      home = await mkdtemp(join(tmpdir(), 'otheater-tmux-home-'));
    }, TEST_TIMEOUT);

    afterEach(async () => {
      const ended = session;
      session = undefined;
      try {
        // Killing the server of tmux closes the terminal under whatever is left in it, as closing the
        // window does: the TUI must end by itself, and `kill()` fails the test if a process outlives it.
        await ended?.kill();
      } finally {
        try {
          await chat.dispose();
        } finally {
          await rm(home, { recursive: true, force: true });
        }
      }
    }, 60_000);

    /** The environment of the program in the pane: nothing of the person's, a fixed locale and terminal. */
    function paneEnv(): Record<string, string> {
      return {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        OT_CLIENT_CONFIG_DIR: join(home, 'client'),
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        PATH: process.env.PATH ?? '',
        TERM: PANE_TERM,
      };
    }

    async function open(command: readonly string[]): Promise<TmuxSession> {
      const started = await TmuxSession.start({ command, env: paneEnv(), size: SIZE });
      session = started;
      return started;
    }

    /** The chat is connected and the Director listens (not `connecting`), and the keys are bound. */
    async function ready(tmux: TmuxSession): Promise<void> {
      await tmux.waitFor(/State: idle · Director active/);
      // The first frame is on the screen before the effects that listen to the keys have run.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    /** The TUI itself (`node main.js`), with its chat connected to the Director. */
    async function openTui(): Promise<TmuxSession> {
      const tmux = await open([process.execPath, TUI_MAIN, '--data-dir', chat.dataDir]);
      await ready(tmux);
      return tmux;
    }

    /** The line of the tab bar of the work panel (the one with its `Alt+J` hint). */
    function tabBar(screen: string): string {
      return screen.split('\n').find((line) => line.includes('⟩ Alt+J')) ?? '';
    }

    /** Waits until the tab bar of the panel shows `name` (a prefix: a narrow bar truncates the label). */
    async function waitTab(tmux: TmuxSession, name: string): Promise<void> {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const screen = await tmux.screen();
        if (tabBar(screen).includes(name)) return;
        if (Date.now() > deadline) throw new Error(`The tab ${name} did not open:\n${screen}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    /** Waits until the panel has a tab bar and it no longer shows `name`. */
    async function waitTabGone(tmux: TmuxSession, name: string): Promise<void> {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const screen = await tmux.screen();
        const bar = tabBar(screen);
        if (bar !== '' && !bar.includes(name)) return;
        if (Date.now() > deadline) throw new Error(`The tab ${name} did not close:\n${screen}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    it(
      'opens with the side bar, the chat and the work panel',
      async () => {
        const tmux = await openTui();
        const screen = await tmux.screen();
        const lines = screen.split('\n');
        // The header, with the scenario and the daemon.
        expect(lines[0]).toContain('ot │ repo');
        expect(lines[0]).toMatch(/daemon 127\.0\.0\.1:\d+/);
        // The three areas: the side bar (scenarios, subscriptions, Settings), the chat and the panel.
        expect(screen).toContain('Navigation');
        expect(screen).toContain('SCENARIOS');
        expect(screen).toContain('SUBSCRIPTIONS');
        expect(screen).toContain('─ Chat ─');
        expect(tabBar(screen)).toContain('Overview');
        expect(screen).toContain('▾ Pipeline');
        // The text box, and the bar of shortcuts with the keys of the registry.
        expect(screen).toMatch(/^.*❯/m);
        // The TUI knows it runs inside tmux and says which of its keys tmux keeps for itself.
        expect(lines.at(-1)).toMatch(/Ctrl\+B .*prefix of tmux/);
        // Nothing wider than the window, and the window is the size the test asked for.
        for (const line of lines) expect(width(line)).toBeLessThanOrEqual(SIZE.columns);
        expect(await tmux.size()).toEqual(SIZE);
        expect(await tmux.alive()).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      'switches the tabs of the panel by the keys of the registry',
      async () => {
        const tmux = await openTui();
        expect(tabBar(await tmux.screen())).toContain('Overview');
        // F5 goes to the Settings tab.
        await tmux.keys('F5');
        await waitTab(tmux, 'Settings');
        // F6 goes to the Plugins tab (Phase 9, P11).
        await tmux.keys('F6');
        await waitTab(tmux, 'Plugin');
        // Alt+A opens the picker; the first tab it offers is Trajectories.
        await tmux.keys('M-a');
        await tmux.waitFor('Open a tab');
        await tmux.keys('Enter');
        await waitTab(tmux, 'Trajec');
        // Alt+W closes it, and the panel is left on another tab.
        await tmux.keys('M-w');
        await waitTabGone(tmux, 'Trajec');
      },
      TEST_TIMEOUT,
    );

    it(
      'hides and shows the work panel and the side bar by their keys',
      async () => {
        const tmux = await openTui();
        await tmux.keys('M-j');
        await tmux.waitGone('▾ Quota');
        expect(await tmux.screen()).toContain('SCENARIOS');
        await tmux.keys('M-j');
        await tmux.waitFor('▾ Quota');
        await tmux.keys('M-s');
        await tmux.waitGone('SCENARIOS');
        expect(await tmux.screen()).toContain('─ Chat ─');
        await tmux.keys('M-s');
        await tmux.waitFor('SCENARIOS');
      },
      TEST_TIMEOUT,
    );

    it(
      'opens the palette, runs a command from it, and closes it with Esc',
      async () => {
        const tmux = await openTui();
        await tmux.keys('M-k');
        await tmux.waitFor('Command palette');
        await tmux.type('usage');
        await tmux.waitFor('Go to the tab Usage');
        await tmux.keys('Enter');
        await tmux.waitGone('Command palette');
        await waitTab(tmux, 'Usage');
        await tmux.waitFor('▾ Totals');
        // The other key of the palette, F1, and Esc to close it.
        await tmux.keys('F1');
        await tmux.waitFor('Command palette');
        await tmux.keys('Escape');
        await tmux.waitGone('Command palette');
        // The help is a screen of the palette, from the keymap in force.
        await tmux.keys('M-k');
        await tmux.waitFor('Command palette');
        await tmux.type('shortcuts');
        await tmux.waitFor('Show the keyboard shortcuts');
        await tmux.keys('Enter');
        const help = await tmux.waitFor('Show or hide the side bar');
        expect(help).toContain('Alt+S');
      },
      TEST_TIMEOUT,
    );

    it(
      'sends a message to the Director of the fake agent and shows its answer',
      async () => {
        const tmux = await openTui();
        const token = randomBytes(4).toString('hex');
        await tmux.type(`#ot-chat hello ${token}`);
        await tmux.waitFor(`❯ #ot-chat hello ${token}`);
        await tmux.keys('Enter');
        // The Producer's line, then the Director's answer, which the fake agent builds from the marker.
        const screen = await tmux.waitFor(`answer: hello ${token}`);
        expect(screen).toContain('You ·');
        expect(screen).toContain('Director ·');
        // The text box is empty again.
        expect(screen).not.toContain('❯ #ot-chat');
        // It really went through the daemon: the log has the Director's reply.
        const types = (await chat.events()).map((event) => event.type);
        expect(types).toContain('chat.director_reply');
      },
      TEST_TIMEOUT,
    );

    it(
      'answers the decision of a play by a click on its option (P14, N34)',
      async () => {
        const tmux = await openTui();
        await tmux.type('#ot-play write alpha #outcome:exhausted');
        await tmux.keys('Enter');
        // The play runs out of attempts and the card of the menu takes the keyboard.
        const card = await tmux.waitFor('Cancel the play');
        expect(card).toContain('The play needs you');
        expect((await chat.plays())[0]?.state).toBe('AWAITING_PRODUCER');
        // The click is on the line of the option, where a person points at what they see; the pane
        // asked for the mouse by itself (`ui.mouse` is `full`), so no key is involved.
        const lines = card.split('\n');
        const row = lines.findIndex((line) => line.includes('Cancel the play'));
        const col = (lines[row] ?? '').indexOf('Cancel the play');
        expect(row).toBeGreaterThanOrEqual(0);
        await tmux.click(col, row);
        await waitUntil('the play to be cancelled', async () =>
          (await chat.plays())[0]?.state === 'CANCELLED' ? true : undefined,
        );
        await tmux.waitGone('The play needs you');
        expect(await tmux.alive()).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      'follows the size of the window when it is resized',
      async () => {
        const tmux = await openTui();
        expect(await tmux.screen()).toContain('▾ Quota');
        const fits = (screen: string, columns: number): boolean =>
          screen.split('\n').every((line) => width(line) <= columns);
        // Narrower: the work panel gives way, the side bar and the chat stay. The frame is read only
        // when it is the one of the new size (a resize shows a frame of the old one first).
        await tmux.resize(80, 24);
        expect(await tmux.size()).toEqual({ columns: 80, rows: 24 });
        await tmux.waitForScreen(
          (screen) =>
            !screen.includes('▾ Quota') &&
            screen.includes('Navigation') &&
            screen.includes('─ Chat ─') &&
            fits(screen, 80),
          'the side bar and the chat in 80 columns, without the panel',
        );
        // Narrower still: the side bar becomes a rail.
        await tmux.resize(50, 20);
        await tmux.waitForScreen(
          (screen) =>
            !screen.includes('Navigation') && screen.includes('─ Chat ─') && fits(screen, 50),
          'the rail and the chat in 50 columns',
        );
        // Wider than the start: everything is back, and the frame fills the new width.
        await tmux.resize(150, 45);
        const wide = await tmux.waitForScreen(
          (screen) =>
            screen.includes('▾ Quota') &&
            screen.includes('Navigation') &&
            Math.max(...screen.split('\n').map((line) => width(line))) > SIZE.columns,
          'everything back in 150 columns',
        );
        expect(tabBar(wide)).toContain('Overview');
        expect(fits(wide, 150)).toBe(true);
        expect(await tmux.alive()).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      'Ctrl+Q ends the TUI and leaves no process behind',
      async () => {
        const tmux = await openTui();
        expect((await tmux.processTree()).length).toBeGreaterThan(0);
        await tmux.keys('C-q');
        await tmux.waitExit();
      },
      TEST_TIMEOUT,
    );

    it(
      'a terminal that closes under the TUI ends it, with no process left',
      async () => {
        // No Ctrl+Q: the pty goes away under the TUI, as when the window of the terminal is closed.
        // The TUI used to spin at full CPU on the writes that failed with EIO and never ended.
        const tmux = await openTui();
        const tree = await tmux.killServer();
        expect(tree.length).toBeGreaterThan(0);
        expect(await tmux.waitProcessesGone(tree, 8_000)).toEqual([]);
      },
      TEST_TIMEOUT,
    );

    it(
      '`ot` alone opens the TUI in a terminal (N195), and Ctrl+Q ends it with its process',
      async () => {
        // No `tui` argument: the bare command opens the interface when the terminal is interactive.
        const tmux = await open([process.execPath, OT_CLI, '--data-dir', chat.dataDir]);
        await ready(tmux);
        const screen = await tmux.screen();
        expect(screen).toContain('SCENARIOS');
        expect(screen).toContain('─ Chat ─');
        expect(screen).not.toContain('ot <command>');
        // `ot` runs the TUI in a process of its own: both are in the pane, and both must end.
        expect((await tmux.processTree()).length).toBeGreaterThan(1);
        await tmux.keys('C-q');
        await tmux.waitExit();
      },
      TEST_TIMEOUT,
    );
  },
);
