// SPDX-License-Identifier: MPL-2.0
// ot-ci: no-cross (the job `tui-terminal` runs it on the three systems)
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  FakeLoginFlow,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startChatDaemon, waitUntil, type ChatDaemon } from './chat/fake-agent.test-support.js';
import {
  REQUIRE_PTY,
  SAFE_UI_YAML,
  terminalBackendsOf,
  terminalUnavailable,
  withTui,
  type TuiEntry,
} from './terminal.test-support.js';
import type { TuiTest } from '@microsoft/tui-test';
import { SIGNAL_EXIT_CODES } from './terminal.js';

/**
 * The compiled TUI in a real terminal (N320, P17 of Phase 11b): what `ink-testing-library` cannot
 * see. The colours of the theme by cell, the OSC 8 link of the sign-in panel, the click of the mouse
 * on each area, a resize, Ctrl+C and the exit of the real binary (the terminal given back as it
 * was). Each terminal of `OT_TUI_TEST_BACKEND` runs the whole suite.
 *
 * The colours are written here as they are, not read from the palette, so that a colour changed by
 * mistake fails this test [proposta, N320].
 */

const TEST_TIMEOUT = 120_000;
/** The address the fake sign-in shows; `.invalid`, and the browser is off ({@link SAFE_UI_YAML}). */
const LOGIN_URL = 'https://login.example.invalid/device?code=ABCD-1234';

/** The colours of the `otheater` theme (the mockup), as the terminal draws them. */
const OTHEATER = {
  header: '#3a46a8',
  borderActive: '#7d8cff',
  border: '#3a4150',
} as const;

/**
 * At 120x30 (zero-based): the header is the line 0, the areas start on the line 1, the side bar on
 * the column 0, the chat on 30 and the work panel on 90.
 */
const CORNER = { y: 1, sidebar: 0, chat: 30, panel: 90 } as const;
/** A cell well inside each area, and the bar of shortcuts it shows when it has the focus. */
const AREAS = {
  sidebar: { x: 10, y: 12, bar: 'New project' },
  chat: { x: 50, y: 12, bar: 'PageUp  Scroll' },
  panel: { x: 100, y: 12, bar: 'Enter  Fold' },
} as const;

const skipReason = terminalUnavailable();
const backends = skipReason === undefined ? terminalBackendsOf() : [];

/** The last line of the screen: the bar of shortcuts. */
async function bar(term: TuiTest): Promise<string> {
  const lines = (await term.text()).split('\n');
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
  return lines.at(-1) ?? '';
}

async function cellAt(term: TuiTest, x: number, y: number) {
  const [cell] = await term.cells(x, y, 1, 1);
  if (cell === undefined) throw new Error(`no cell at ${String(x)},${String(y)}`);
  return cell;
}

/** Waits until the screen says the TUI quit and gave the terminal back as it found it. */
async function expectCleanExit(term: TuiTest, codes: readonly number[]): Promise<void> {
  await term.waitExit({ timeout: 15_000 });
  const state = await term.state();
  expect(codes, JSON.stringify(state)).toContain(state.exited);
  expect(state.modes.alternate_screen).toBe(false);
  expect(state.modes.cursor_visible).toBe(true);
  expect(state.modes.bracketed_paste).toBe(false);
  expect(state.mouse_mode).toBe('none');
}

if (skipReason !== undefined) {
  describe(`the TUI in a real terminal (skipped: ${skipReason})`, () => {
    (REQUIRE_PTY ? it : it.skip)('can run here', () => {
      throw new Error(`The tests of the TUI in a real terminal cannot run: ${skipReason}`);
    });
  });
}

describe.each(backends)('the TUI in a real terminal (%s)', (backend) => {
  let chat: ChatDaemon | undefined;

  beforeEach(async () => {
    chat = await startChatDaemon(
      {
        codeHost: new FakeCodeHost(),
        clock: new FakeClock(),
        vault: new InMemorySecretVault(),
        client: (launcher, command, env) =>
          new FakeClientAdapter({
            launcher,
            baseEnv: {},
            env,
            adapterVersion: '1.0.0',
            command,
            login: () => new FakeLoginFlow({ mode: 'browser', url: LOGIN_URL }),
          }),
      },
      {
        // `ot tui` reads its `ui` from this file: no assistant and no browser there either.
        extra: SAFE_UI_YAML,
        persistConfig: true,
        prepare: async (daemon) => {
          await daemon.store.profiles.create({
            client: 'fake',
            name: 'plan',
            kind: 'token_plan',
            provider: 'fake',
            dir: '/profiles/fake/plan',
            secretRef: null,
          });
        },
      },
    );
  }, TEST_TIMEOUT);

  afterEach(async () => {
    await chat?.dispose();
    chat = undefined;
  }, 60_000);

  function open(
    name: string,
    body: Parameters<typeof withTui>[1],
    more: { entry?: TuiEntry; ui?: Record<string, unknown> } = {},
  ): Promise<void> {
    if (chat === undefined) throw new Error('the daemon is not up');
    return withTui({ backend, dataDir: chat.dataDir, name, ...more }, body);
  }

  it(
    'paints the otheater theme: the header, the border of the area with the focus and the others',
    async () => {
      await open('theme-otheater', async ({ term }) => {
        await term.getByText('Side bar').expect();
        await term.waitIdle();
        expect((await cellAt(term, 3, 0)).bg).toBe(OTHEATER.header);
        // The chat has the focus when the TUI opens; the side bar does not.
        expect((await cellAt(term, CORNER.chat, CORNER.y)).fg).toBe(OTHEATER.borderActive);
        expect((await cellAt(term, CORNER.sidebar, CORNER.y)).fg).toBe(OTHEATER.border);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'paints the terminal theme with the named colours of the terminal, not with true colour',
    async () => {
      await open(
        'theme-terminal',
        async ({ term }) => {
          await term.getByText('Side bar').expect();
          await term.waitIdle();
          const active = (await cellAt(term, CORNER.chat, CORNER.y)).fg;
          const other = (await cellAt(term, CORNER.sidebar, CORNER.y)).fg;
          // `blueBright` and `gray` are the colours 12 and 8 of the 16 of the terminal.
          expect([active, other]).toEqual([12, 8]);
        },
        { ui: { theme: 'terminal' } },
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'follows a resize: the frame and the bar move to the new edges',
    async () => {
      await open('resize', async ({ term }) => {
        await term.getByText('Side bar').expect();
        await term.waitIdle();
        await term.resize(213, 83);
        await waitUntil('the bar on the last line of 83', async () => {
          const lines = (await term.text()).split('\n');
          return lines[82]?.includes('Side bar') === true;
        });
        expect((await cellAt(term, 212, 1)).char).toBe('╮');
        expect((await term.state()).cols).toBe(213);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'gives the focus to the area that is clicked',
    async () => {
      await open('mouse', async ({ term }) => {
        await term.getByText('Side bar').expect();
        await term.waitIdle();
        for (const area of ['sidebar', 'panel', 'chat', 'panel', 'sidebar', 'chat'] as const) {
          const { x, y, bar: expected } = AREAS[area];
          await term.mouse.click(x, y);
          await waitUntil(`the bar of the ${area}`, async () =>
            (await bar(term)).includes(expected),
          );
        }
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'draws the address of the sign-in panel as an OSC 8 link, without opening a browser',
    async () => {
      await open('osc8-login', async ({ term }) => {
        await term.getByText('Side bar').expect();
        await term.waitIdle();
        await term.press('F5');
        await term.getByText('Scope: global').expect();
        await term.waitIdle();
        await term.type('l');
        await term.getByText('Sign in: fake/plan').expect();
        await term.getByLink(LOGIN_URL).expect();
      });
    },
    TEST_TIMEOUT,
  );

  it.each(['main', 'ot-tui'] as const)(
    'leaves on Ctrl+C and gives the terminal back as it was (%s)',
    async (entry) => {
      await open(
        `ctrl-c-${entry}`,
        async ({ term }) => {
          await term.getByText('Side bar').expect();
          await term.waitIdle();
          await term.press('Ctrl+C');
          await expectCleanExit(term, [0]);
        },
        { entry },
      );
    },
    TEST_TIMEOUT,
  );

  (process.platform === 'win32' ? it.skip : it)(
    'leaves on a signal with the code of a signal and gives the terminal back as it was',
    async () => {
      await open('sigterm', async ({ term }) => {
        await term.getByText('Side bar').expect();
        await term.waitIdle();
        await term.signal('TERM');
        // The tui-test 0.1.1 ends the session with a hang-up here (129, not 143 as `kill` would give,
        // [N] not confirmed in its code); which code each signal gets is tested in `run.test.tsx`.
        await expectCleanExit(term, Object.values(SIGNAL_EXIT_CODES));
      });
    },
    TEST_TIMEOUT,
  );
});
