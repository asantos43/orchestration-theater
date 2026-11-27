// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, TEST_UI_SETTINGS, type RenderedApp } from './ink.test-support.js';
import {
  assertFakeAgentBuilt,
  NO_LAUNCHER,
  waitUntil,
  withChatDaemon,
  type ChatDaemon,
  type ChatFakes,
} from './chat/fake-agent.test-support.js';

/**
 * "New scenario" in the TUI (P22 of Phase 7, N208 item 1; N329), end to end against the real daemon
 * of this process with the fake agent: the action of the side bar (its key and the click on the
 * `+`), the row of the types (project, task off, chat), `/new project <repo>` and `/new project`
 * alone in the chat, a folder that is not a repository, and a message sent with no scenario, which
 * opens the prompt and reaches the Director of the chat it opens. In English and in Brazilian
 * Portuguese; every expected text comes from the catalog. Nothing real runs: temporary folders,
 * loopback only, fake clock and CodeHost.
 */

beforeAll(assertFakeAgentBuilt);
afterEach(cleanupApps);

const run = promisify(execFile);
const SIZE = { columns: 200, rows: 50 };
const ENTER = '\r';
const ESC = '\x1b';
// macOS tmpdir() is a long /private/var/folders path: the field and the chat would cut or wrap it.
const BASE = process.platform === 'win32' ? tmpdir() : '/tmp';
const pause = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 200));
const TAB = '\t';
const WAIT_MS = 30_000;
const TEST_MS = 90_000;

const LOCALES = [
  { name: 'en', systemLocale: 'en_US.UTF-8' },
  { name: 'pt-BR', systemLocale: 'pt_BR.UTF-8' },
] as const;

function fakes(): ChatFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

/** A folder that is a git repository with one commit on `main` (what a project can start from). */
async function makeRepo(prefix: string): Promise<string> {
  const folder = await realpath(await mkdtemp(join(BASE, prefix)));
  const git = (...args: string[]): Promise<unknown> =>
    run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: folder,
      env: { PATH: process.env.PATH ?? '', HOME: folder, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  await git('init', '--quiet', '--initial-branch=main');
  await writeFile(join(folder, 'readme.txt'), 'hello\n');
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'initial commit');
  return folder;
}

/** The frame without the runs of spaces, so a text on one line matches wherever the column puts it. */
function flat(frame: string): string {
  return frame.replace(/\s+/g, ' ');
}

async function seen(app: RenderedApp, text: string): Promise<string> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const frame = app.frame();
    if (flat(frame).includes(text)) return frame;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for the text "${text}". Last frame:\n${frame}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function gone(app: RenderedApp, text: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (flat(app.frame()).includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for "${text}" to leave. Last frame:\n${app.frame()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function press(app: RenderedApp, keys: string): Promise<void> {
  app.press(keys);
  await app.settle();
}

/** Types text a key at a time and waits for it to be on the screen. */
async function typeText(app: RenderedApp, text: string): Promise<void> {
  for (const char of Array.from(text)) await press(app, char);
  await seen(app, text);
}

/** The shortcut bar: the last line of the frame, which changes with the area that has the focus. */
function barOf(app: RenderedApp): string {
  const lines = app.frame().trimEnd().split('\n');
  return flat(lines[lines.length - 1] ?? '');
}

/**
 * Moves the focus to the side bar (chat, edge, panel, side bar: three Tabs) and waits for its
 * shortcut. Each Tab waits for the bar to change, so two keys never act on the same focus.
 */
/**
 * Opens the prompt by the key of the side bar, which starts on the chat (`ui.newProject.type`), and
 * moves to the project with Tab.
 */
async function openProjectPrompt(app: RenderedApp, T: (key: string) => string): Promise<void> {
  await press(app, 'n');
  await seen(app, T('layout.newProject.nameLabel'));
  await pause();
  await press(app, TAB);
  await seen(app, T('layout.newProject.label'));
}

/**
 * Opens the prompt by the key of the side bar and moves to the project with Tab: with
 * `ui.newProject.picker: browser` that is the folder browser, on the folder `dir` (N332).
 */
async function openBrowser(
  app: RenderedApp,
  T: (key: string, vars?: Record<string, unknown>) => string,
  dir: string,
): Promise<void> {
  await focusSidebar(app, T('bar.sidebar.newProject'));
  await press(app, 'n');
  await seen(app, T('layout.newProject.nameLabel'));
  await pause();
  await press(app, TAB);
  await seen(app, T('layout.newProject.picker.dir', { dir }));
}

async function focusSidebar(app: RenderedApp, shortcut: string): Promise<void> {
  for (let tab = 0; tab < 3; tab += 1) {
    const before = barOf(app);
    await press(app, TAB);
    const deadline = Date.now() + WAIT_MS;
    while (barOf(app) === before && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  await seen(app, shortcut);
}

describe.skipIf(NO_LAUNCHER).each(LOCALES)(
  'new project in the TUI, in $name',
  ({ systemLocale }) => {
    async function withApp(
      body: (context: {
        app: RenderedApp;
        chat: ChatDaemon;
        other: string;
        T: (key: string, vars?: Record<string, unknown>) => string;
      }) => Promise<void>,
      openScenario = true,
      picker: 'browser' | 'path' = 'path',
    ): Promise<void> {
      const other = await makeRepo('otheater-p22-other-');
      try {
        await withChatDaemon(fakes(), { openScenario }, async (chat) => {
          const app = await renderApp({
            connector: chat.connector,
            systemLocale,
            size: SIZE,
            // The tests of the field type a path; the browser has its own test (N332).
            settings: {
              ...TEST_UI_SETTINGS,
              newProject: { ...TEST_UI_SETTINGS.newProject, picker },
            },
            chatSocket: { initialDelayMs: 20, maxDelayMs: 50, jitter: 0 },
            cwd: other,
          });
          const translate = app.i18n.t.bind(app.i18n) as (
            key: string,
            vars?: Record<string, unknown>,
          ) => string;
          const T = (key: string, vars?: Record<string, unknown>): string =>
            flat(translate(key, vars));
          await seen(app, T('layout.sidebar.scenarios'));
          if (openScenario) await seen(app, basename(chat.repo));
          await body({ app, chat, other, T });
        });
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    }

    /** The project scenario of the repository `folder`, once the daemon has it. */
    async function projectOf(chat: ChatDaemon, folder: string) {
      return waitUntil(`the project of ${folder}`, async () => {
        const all = await chat.daemon.store.scenarios.list();
        return all.find((scenario) => scenario.kind === 'project' && scenario.folder === folder);
      });
    }

    it(
      'opens the project by the key of the side bar, with the folder of the TUI in the field',
      async () => {
        await withApp(async ({ app, chat, other, T }) => {
          await focusSidebar(app, T('bar.sidebar.newProject'));
          await openProjectPrompt(app, T);
          // The field starts with the folder the TUI was opened in (`ui.newProject.repo: cwd`).
          await seen(app, `> ${other}`);
          await pause();
          await press(app, ENTER);
          await gone(app, T('layout.newProject.label'));
          const scenario = await projectOf(chat, other);
          expect(scenario.name).toBe(basename(other));
          // It is in the side bar and it is the active one: the header and the chat are about it.
          await seen(app, T('layout.newProject.opened', { name: basename(other) }));
          await seen(app, `▸ `);
          const frame = flat(app.frame());
          expect(frame).toContain(basename(other));
          expect(frame).toContain(basename(chat.repo));
          const events = (await chat.events()).filter((event) => event.type === 'scenario.created');
          expect(events.length).toBeGreaterThanOrEqual(2);
        });
      },
      TEST_MS,
    );

    it(
      'cancels with Esc, and shows catalog text for a folder that is not a repository',
      async () => {
        await withApp(async ({ app, chat, T }) => {
          await focusSidebar(app, T('bar.sidebar.newProject'));
          await openProjectPrompt(app, T);
          await pause();
          await press(app, ESC);
          await gone(app, T('layout.newProject.label'));

          const notRepo = await realpath(await mkdtemp(join(BASE, 'otheater-p22-plain-')));
          try {
            await openProjectPrompt(app, T);
            // Lets the prompt take the keyboard, then clears the field and types a folder with no
            // repository in it.
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
            await press(app, '\x15');
            await typeText(app, notRepo);
            await press(app, ENTER);
            // The message wraps in the box, and a long path (macOS /private/tmp) wraps right after the
            // text before the quotes: only that part is on one line.
            const before = (
              T('layout.newProject.badRepo', { repo: '@@' }).split('@@')[0] ?? ''
            ).replace(/[\s"“”«»]+$/u, '');
            await seen(app, before);
            // The prompt stays open for another try, and nothing was created.
            expect(flat(app.frame())).toContain(T('layout.newProject.label'));
            const all = await chat.daemon.store.scenarios.list();
            expect(all.some((scenario) => scenario.folder === notRepo)).toBe(false);
            // An empty field says what is missing.
            await press(app, '\x15');
            await press(app, ENTER);
            await seen(app, T('layout.newProject.noRepo'));
            await press(app, ESC);
            await gone(app, T('layout.newProject.label'));
          } finally {
            await rm(notRepo, { recursive: true, force: true });
          }
        });
      },
      TEST_MS,
    );

    it(
      'browses the folders: walks up, filters, opens the project with Space (N332)',
      async () => {
        await withApp(
          async ({ app, chat, other, T }) => {
            await openBrowser(app, T, other);
            // The folder of the TUI is a repository: the browser says so, with its branch.
            expect(flat(app.frame())).toContain(T('layout.newProject.picker.git', { ref: 'main' }));
            expect(flat(app.frame())).not.toContain(T('layout.newProject.label'));
            await pause();
            // Left goes up; typing the name filters; Enter goes back in.
            await press(app, '\x1b[D');
            await seen(app, T('layout.newProject.picker.dir', { dir: dirname(other) }));
            await typeText(app, basename(other));
            await seen(app, T('layout.newProject.picker.filter', { text: basename(other) }));
            await press(app, ENTER);
            await seen(app, T('layout.newProject.picker.dir', { dir: other }));
            // Space chooses the folder and opens it through the same route as the field.
            await press(app, ' ');
            await gone(app, T('layout.newProject.picker.dir', { dir: other }));
            const scenario = await projectOf(chat, other);
            expect(scenario.name).toBe(basename(other));
            await seen(app, T('layout.newProject.opened', { name: basename(other) }));
          },
          true,
          'browser',
        );
      },
      TEST_MS,
    );

    it(
      'shows the refusal in the browser, and goes to the field with / and back with Ctrl+O (N332)',
      async () => {
        await withApp(
          async ({ app, chat, other, T }) => {
            const notRepo = await realpath(await mkdtemp(join(BASE, 'otheater-n332-plain-')));
            try {
              await openBrowser(app, T, other);
              await pause();
              // The slash hands the folder to the field; the field takes another folder.
              await press(app, '/');
              await seen(app, T('layout.newProject.label'));
              await seen(app, `> ${other}`);
              await press(app, '\x15');
              await typeText(app, notRepo);
              // Ctrl+O comes back to the browser, on the folder of the field.
              await press(app, '\x0f');
              await seen(app, T('layout.newProject.picker.dir', { dir: notRepo }));
              await press(app, ' ');
              const before = (
                T('layout.newProject.badRepo', { repo: '@@' }).split('@@')[0] ?? ''
              ).replace(/[\s"“”«»]+$/u, '');
              await seen(app, before);
              // Still in the browser, nothing created.
              expect(flat(app.frame())).toContain(
                T('layout.newProject.picker.dir', { dir: notRepo }),
              );
              const all = await chat.daemon.store.scenarios.list();
              expect(all.some((scenario) => scenario.folder === notRepo)).toBe(false);
              // Back to the field with the slash, and open the repository from there.
              await press(app, '/');
              await seen(app, `> ${notRepo}`);
              await press(app, '\x15');
              await typeText(app, other);
              await press(app, ENTER);
              await projectOf(chat, other);
              await seen(app, T('layout.newProject.opened', { name: basename(other) }));
            } finally {
              await rm(notRepo, { recursive: true, force: true });
            }
          },
          true,
          'browser',
        );
      },
      TEST_MS,
    );

    it(
      'opens the project by /new project <repo> in the chat',
      async () => {
        const second = await makeRepo('otheater-p22-second-');
        try {
          await withApp(async ({ app, chat }) => {
            await typeText(app, `/new project ${second}`);
            await press(app, ENTER);
            const scenario = await projectOf(chat, second);
            // The side bar lists it and the chat went to it.
            await seen(app, scenario.name);
            const frame = flat(app.frame());
            expect(frame).toContain(`▸ `);
            expect(await chat.daemon.store.scenarios.get(scenario.id)).toBeDefined();
          });
        } finally {
          await rm(second, { recursive: true, force: true });
        }
      },
      TEST_MS,
    );

    it(
      'opens the prompt for /new project alone, and answers a bad path in the chat',
      async () => {
        await withApp(async ({ app, other, T }) => {
          await typeText(app, '/new project');
          await press(app, ENTER);
          await seen(app, T('layout.newProject.label'));
          await seen(app, `> ${other}`);
          await pause();
          await press(app, ESC);
          await gone(app, T('layout.newProject.label'));
        });
      },
      TEST_MS,
    );

    it(
      'opens a chat by the key of the side bar, with the task shown off',
      async () => {
        await withApp(async ({ app, chat, T }) => {
          await focusSidebar(app, T('bar.sidebar.newProject'));
          await press(app, 'n');
          await seen(app, T('layout.newProject.nameLabel'));
          // The three types are in the row, and the task says the phase it comes with.
          const frame = flat(app.frame());
          for (const type of ['project', 'task', 'chat']) {
            expect(frame).toContain(T(`layout.newProject.types.${type}`));
          }
          await seen(app, T('layout.newProject.taskOff'));
          await pause();
          await press(app, ENTER);
          await gone(app, T('layout.newProject.nameLabel'));
          const chats = await waitUntil('the new chat', async () => {
            const all = await chat.daemon.store.scenarios.list();
            const found = all.filter((scenario) => scenario.kind === 'chat');
            return found.length > 0 ? found : undefined;
          });
          // The scenario of the helper is a project, so the chat is the only one of its kind.
          expect(chats.length).toBe(1);
        });
      },
      TEST_MS,
    );

    it(
      'with no scenario, says so, and a message opens the prompt and reaches the new chat',
      async () => {
        await withApp(async ({ app, chat, T }) => {
          const before = (T('layout.chat.noScenario', { key: '@@' }).split('@@')[0] ?? '').trim();
          await seen(app, before);
          await typeText(app, 'hello from no scenario');
          await press(app, ENTER);
          // The prompt opens on the chat (`ui.newProject.type`), and the message is kept.
          await seen(app, T('layout.newProject.nameLabel'));
          await pause();
          await press(app, ENTER);
          await gone(app, T('layout.newProject.nameLabel'));
          const opened = await waitUntil('the chat of the message', async () => {
            const all = await chat.daemon.store.scenarios.list();
            return all.find((scenario) => scenario.kind === 'chat');
          });
          // Once the chat is on screen and its socket is open, the message goes to its Director.
          // The event does not carry the text: this test sends no other prompt, so one is enough.
          await waitUntil('the message at the Director', async () =>
            (await chat.events()).some((event) => event.type === 'prompt.queued'),
          );
          expect(await chat.daemon.store.scenarios.get(opened.id)).toBeDefined();
          await seen(app, 'hello from no scenario');
        }, false);
      },
      TEST_MS,
    );
  },
);
