// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
 * "New project" in the TUI (P22 of Phase 7, N208 item 1), end to end against the real daemon of
 * this process with the fake agent: the action of the side bar (its key and the click on the `+`),
 * `/new project <repo>` and `/new project` alone in the chat, and a folder that is not a
 * repository. In English and in Brazilian Portuguese; every expected text comes from the catalog.
 * Nothing real runs: temporary folders, loopback only, fake clock and CodeHost.
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
    ): Promise<void> {
      const other = await makeRepo('otheater-p22-other-');
      try {
        await withChatDaemon(fakes(), {}, async (chat) => {
          const app = await renderApp({
            connector: chat.connector,
            systemLocale,
            size: SIZE,
            settings: TEST_UI_SETTINGS,
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
          await seen(app, basename(chat.repo));
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
          await press(app, 'n');
          await seen(app, T('layout.newProject.label'));
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
          await press(app, 'n');
          await seen(app, T('layout.newProject.label'));
          await pause();
          await press(app, ESC);
          await gone(app, T('layout.newProject.label'));

          const notRepo = await realpath(await mkdtemp(join(BASE, 'otheater-p22-plain-')));
          try {
            await press(app, 'n');
            await seen(app, T('layout.newProject.label'));
            // Lets the prompt take the keyboard, then clears the field and types a folder with no
            // repository in it.
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
            await press(app, '\x15');
            await typeText(app, notRepo);
            await press(app, ENTER);
            // The message wraps in the box: the part before the folder is on one line.
            await seen(app, T('layout.newProject.badRepo', { repo: '@@' }).split('@@')[0] ?? '');
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
  },
);
