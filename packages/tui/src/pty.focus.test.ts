// SPDX-License-Identifier: MPL-2.0
// ot-ci: no-cross (the job `tui-terminal` runs it on the three systems)
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import type { TuiTest } from '@microsoft/tui-test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startChatDaemon, waitUntil, type ChatDaemon } from './chat/fake-agent.test-support.js';
import { sgrReport } from './mouse/sgr.js';
import {
  REQUIRE_PTY,
  SAFE_UI_YAML,
  terminalBackendsOf,
  terminalUnavailable,
  withTui,
} from './terminal.test-support.js';

/**
 * The clicks of the terminal of the Claude desktop, on the real process (the 2026-11-22 report: "I
 * cannot activate the areas by clicking them"). The compiled TUI runs in a real pseudo-terminal
 * (ConPTY on Windows) with an emulated screen (N320, `terminal.test-support.ts`). The terminal
 * starts at 120x30 and is made 213x83 by a resize, as the panel of the desktop app does when it
 * shows up. The test then writes the bytes that terminal was measured to send for one click, as
 * three chunks of their own: the press, a move with the button down on the SAME cell, and the
 * release. Then it reads the bar of shortcuts on the screen, which must be the one of the area that
 * was clicked. (`tui-terminal.e2e.test.ts` clicks with the mouse of the emulated terminal instead.)
 *
 * Nothing real runs: the daemon is the fake agent, in temporary folders, and the HOME is a temporary
 * one. The test skips where `@microsoft/tui-test` does not load or nothing is built;
 * `OT_REQUIRE_PTY=1` turns that skip into a failure.
 */

const TEST_TIMEOUT = 120_000;

/** The terminal of the desktop app after the panel showed up. */
const SHOWN = { columns: 213, rows: 83 };

/** A cell well inside each area at `SHOWN` (one-based, as SGR counts): the side bar, the chat, the panel. */
const AREAS = {
  sidebar: { col: 10, row: 12, bar: 'New project' },
  chat: { col: 40, row: 12, bar: 'PageUp  Scroll' },
  panel: { col: 150, row: 12, bar: 'Enter  Fold' },
} as const;

const skipReason = terminalUnavailable();
const backends = skipReason === undefined ? terminalBackendsOf() : [];

/** The press, the move on the same cell and the release, each in a write of its own. */
async function click(term: TuiTest, col: number, row: number): Promise<void> {
  const at = { col, row };
  await term.write(sgrReport({ action: 'press', button: 'left', ...at }));
  await term.write(sgrReport({ action: 'drag', button: 'left', ...at }));
  await term.write(sgrReport({ action: 'release', button: 'left', ...at }));
}

/** The line `row` (zero-based) of the screen. */
async function line(term: TuiTest, row: number): Promise<string> {
  return (await term.text()).split('\n')[row] ?? '';
}

if (skipReason !== undefined) {
  describe(`the clicks on the TUI in a real pty (skipped: ${skipReason})`, () => {
    (REQUIRE_PTY ? it : it.skip)('can run here', () => {
      throw new Error(`The test of the clicks in a pty cannot run: ${skipReason}`);
    });
  });
}

describe.each(backends)('the clicks on the TUI in a real pty (%s)', (backend) => {
  let chat: ChatDaemon | undefined;

  beforeEach(async () => {
    chat = await startChatDaemon(
      {
        codeHost: new FakeCodeHost(),
        clock: new FakeClock(),
        vault: new InMemorySecretVault(),
        client: (launcher, command, env) =>
          new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
      },
      // The assistant of the first run would take the screen; `ot tui` reads this file.
      { extra: SAFE_UI_YAML, persistConfig: true },
    );
  }, TEST_TIMEOUT);

  afterEach(async () => {
    await chat?.dispose();
    chat = undefined;
  }, 60_000);

  it.each(['main', 'ot-tui'] as const)(
    'gives the focus to each area by a click, after the terminal was resized (%s)',
    async (entry) => {
      if (chat === undefined) throw new Error('the daemon is not up');
      await withTui(
        { backend, dataDir: chat.dataDir, entry, name: `pty-focus-${entry}` },
        async ({ term }) => {
          await term.getByText('Side bar').expect();
          await term.waitIdle();
          await term.resize(SHOWN.columns, SHOWN.rows);
          // The layout follows the resize: the bar is drawn on the last of the 83 lines.
          await waitUntil('the bar on the last line', async () =>
            (await line(term, SHOWN.rows - 1)).includes('Side bar'),
          );
          await term.getByText('Overview').expect();
          for (const area of ['sidebar', 'panel', 'chat', 'panel', 'sidebar', 'chat'] as const) {
            const { col, row, bar } = AREAS[area];
            await click(term, col, row);
            const shown = await waitUntil(
              `the bar of the ${area}`,
              async () => {
                const last = await line(term, SHOWN.rows - 1);
                return last.includes(bar) ? last : undefined;
              },
              20_000,
            );
            expect(shown, `the click on the ${area}`).toContain(bar);
          }
        },
      );
    },
    TEST_TIMEOUT,
  );
});
