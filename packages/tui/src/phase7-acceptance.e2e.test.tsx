// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  withChatDaemon,
  type ChatDaemon,
  type ChatFakes,
} from './chat/fake-agent.test-support.js';

/**
 * The acceptance of Phase 7 (P21 of docs/18), in the automatic level: the whole path of a person
 * who opens the TUI for the first time, by keys only, against the real daemon of this process with
 * the fake agent in every role. Setup assistant on the first run, an account added in Settings, a
 * role rule edited, a need asked in the chat, the decision of the delivery answered and the play
 * followed to DONE, with the pull request in the fake CodeHost. It runs in English and in Brazilian
 * Portuguese through the same path; every expected text comes from the catalog (`app.i18n.t`).
 *
 * Nothing real runs (N57): temporary home, SQLite and data folder, loopback only, fake clock, fake
 * CodeHost, in-memory vault, no credential read. The "detected account" of the first step is a
 * fake profile in the store: the official login of a client is NOT exercised here (the real level,
 * `tools/acceptance/real-acceptance.sh --level phase7`, leaves it to the owner at the keyboard).
 *
 * Timings are real and tolerant to load: every wait polls the frame or the daemon with a wide
 * timeout, and a key that changes the screen is followed by a wait for the new screen, never by a
 * read of the frame right after the key.
 */

beforeAll(assertFakeAgentBuilt);
afterEach(cleanupApps);

const SIZE = { columns: 200, rows: 50 };
const ENTER = '\r';
const ESC = '\x1b';
const TAB = '\t';
const DOWN = '\x1b[B';
const F5 = '\x1b[15~';
/** The play that goes all the way: a plan, two demands, the critique and the delivery. */
const NEED = '#ot-play write alpha and beta #outcome:approved';
const WAIT_MS = 60_000;

const LOCALES = [
  { name: 'en', systemLocale: 'en_US.UTF-8' },
  { name: 'pt-BR', systemLocale: 'pt_BR.UTF-8' },
] as const;

/** The delivery asks the Producer (`ask`) and someone is always there, so the menu of the delivery opens. */
const DELIVERY_ASK =
  'delivery:\n  mode: ask\n  allow_direct_merge: true\nchat:\n  presence: always\n';

function fakes(): ChatFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

/** The frame without the runs of spaces, so a text on one line matches wherever the column puts it. */
function flat(frame: string): string {
  return frame.replace(/\s+/g, ' ');
}

async function poll<T>(
  what: string,
  read: () => T | undefined | false | Promise<T | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/** Waits for the frame to show `text`; fails with the last frame. */
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

async function seenAll(app: RenderedApp, ...texts: readonly string[]): Promise<string> {
  let frame = '';
  for (const text of texts) frame = await seen(app, text);
  return frame;
}

/** Waits for the frame to lose `text`. */
async function gone(app: RenderedApp, text: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (flat(app.frame()).includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for "${text}" to leave. Last frame:\n${app.frame()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/** A key, and the renders and effects it caused. The caller then waits for the screen it expects. */
async function press(app: RenderedApp, keys: string): Promise<void> {
  app.press(keys);
  await app.settle();
}

/**
 * Types text a key at a time, as a person does, and waits for it to be on the screen. The first key
 * is pressed once: the text box hears the keys from the commit that gives it the keyboard (P24), so
 * there is no repeating of it, and a lost key fails the test.
 */
async function typeText(app: RenderedApp, text: string): Promise<void> {
  for (const char of Array.from(text)) await press(app, char);
  await seen(app, text);
}

/** The events of the daemon of this type, once at least `min` of them are in the log. */
async function eventsOf(chat: ChatDaemon, type: string, min = 1) {
  return poll(`${String(min)} event(s) ${type}`, async () => {
    const found = (await chat.events()).filter((event) => event.type === type);
    return found.length >= min ? found : undefined;
  });
}

describe.skipIf(NO_LAUNCHER).each(LOCALES)(
  'the acceptance of Phase 7, by keys only, in $name',
  ({ systemLocale }) => {
    it('goes from the first run to the pull request, with the setup assistant, Settings and the chat', async () => {
      await withChatDaemon(
        fakes(),
        {
          // The first run is read from the file of the data folder, as in a real install.
          persistConfig: true,
          extra: DELIVERY_ASK,
          prepare: async (daemon) => {
            // The detected account: a profile that was never logged in, and no credential.
            await daemon.store.profiles.create({
              client: 'claude-code',
              name: 'main',
              kind: 'token_plan',
              provider: 'anthropic',
              dir: '/profiles/claude-code/main',
              secretRef: null,
            });
          },
        },
        async (chat) => {
          const app = await renderApp({
            connector: chat.connector,
            systemLocale,
            size: SIZE,
            settings: {
              ...TEST_UI_SETTINGS,
              setup: { ...TEST_UI_SETTINGS.setup, open: 'auto' as const },
            },
            chatSocket: { initialDelayMs: 20, maxDelayMs: 50, jitter: 0 },
          });
          const translate = app.i18n.t.bind(app.i18n) as (
            key: string,
            vars?: Record<string, unknown>,
          ) => string;
          const t = (key: string, vars?: Record<string, unknown>): string => translate(key, vars);
          const T = (key: string, vars?: Record<string, unknown>): string => flat(t(key, vars));

          // 1. The setup assistant opens by itself on the first run.
          await seenAll(
            app,
            T('setup.title.first_run'),
            T('setup.step.detect'),
            T('setup.hint.detect'),
            'claude-code/main',
            T('setup.detect.usable'),
          );
          // Forward to the preset, back with Esc (the run is kept), forward again.
          await press(app, ENTER);
          await seen(app, T('setup.hint.preset'));
          await press(app, ESC);
          await seen(app, T('setup.hint.detect'));
          await press(app, ENTER);
          await seen(app, T('setup.hint.preset'));
          await press(app, ENTER);
          await seen(app, T('setup.hint.executors'));
          await press(app, ENTER);
          await seen(app, T('setup.hint.review'));
          await press(app, ENTER);
          await seen(app, T('setup.done.confirmed'));
          await eventsOf(chat, 'setup.started');
          await eventsOf(chat, 'setup.step', 3);
          await eventsOf(chat, 'setup.confirmed');
          // The assistant wrote the file the daemon reads (the confirm is not applied hot).
          expect(await readFile(join(chat.dataDir, 'config.yaml'), 'utf8')).toMatch(
            /preset:\s*balanced/,
          );
          // Enter closes the assistant, and the layout with the chat of the scenario is there.
          await press(app, ENTER);
          await gone(app, T('setup.title.first_run'));
          await seenAll(
            app,
            T('layout.sidebar.scenarios'),
            T('layout.chat.director.active'),
            T('layout.chat.empty'),
          );

          // 2. Settings (F5): add an account by the line of the prompt.
          await press(app, F5);
          await seen(app, T('settings.sections.subscriptions'));
          await press(app, 'a');
          await seen(app, T('settings.prompt.add'));
          await typeText(app, 'codex work token_plan openai');
          await press(app, ENTER);
          await seen(app, T('settings.result.added', { profile: 'codex/work' }));
          await seen(app, 'codex/work token_plan');
          const profiles = await chat.daemon.store.profiles.list();
          expect(profiles.map((profile) => `${profile.client}/${profile.name}`)).toContain(
            'codex/work',
          );
          await eventsOf(chat, 'profile.added');
          // `profiles.add.login` is `ask` by default: the new account offers a login, and `n` leaves it.
          await seen(app, T('settings.prompt.confirmLogin', { profile: 'codex/work' }));
          await press(app, 'n');

          // 3. The roles: the cursor goes to the rule of the Director, and `e` changes it. The
          // Executors section is empty, so the first arrow lands on it with nothing to see.
          await press(app, DOWN);
          await press(app, DOWN);
          await seen(app, '›director');
          await press(app, 'e');
          await seen(app, T('settings.result.hot', { keys: 'roles.director.when_exhausted' }));
          await seen(app, `director ${T('settings.role.rule', { rule: t('settings.role.wait') })}`);
          expect(await readFile(join(chat.dataDir, 'config.yaml'), 'utf8')).toMatch(
            /when_exhausted:\s*wait/,
          );
          await eventsOf(chat, 'config.edited');
          await eventsOf(chat, 'config.changed');

          // 4. Back to the chat (Tab goes through the side bar and its edge to it, N277) and the need.
          await press(app, TAB);
          await press(app, TAB);
          await press(app, TAB);
          await seen(app, T('bar.chat.scroll'));
          await typeText(app, NEED);
          await press(app, ENTER);
          const play = await poll('the play of the scenario', async () => (await chat.plays())[0]);
          expect(play.need).toContain('write alpha and beta');
          await seen(app, T('layout.chat.entry.play', { id: play.id, state: 'PLANNING' }));

          // 5. The delivery asks the Producer: the card is on the chat, and 1 opens the pull request.
          await seenAll(
            app,
            T('layout.chat.card.title.producer_menu'),
            T('layout.chat.card.option.deliver_pr'),
            T('layout.chat.card.option.deliver_merge'),
          );
          await eventsOf(chat, 'decision.created');
          expect(chat.codeHost.pullRequests()).toHaveLength(0);
          await press(app, '1');
          await gone(app, T('layout.chat.card.title.producer_menu'));

          // 6. The play goes on to DONE, and the pull request is in the fake CodeHost.
          await seen(app, T('layout.chat.entry.play', { id: play.id, state: 'DONE' }));
          await seen(app, T('layout.chat.state', { state: t('layout.state.done') }));
          await poll('the play to be DONE', async () =>
            (await chat.plays())[0]?.state === 'DONE' ? true : undefined,
          );
          expect(chat.codeHost.pullRequests()).toHaveLength(1);
          const answered = await eventsOf(chat, 'decision.answered');
          expect(answered.length).toBeGreaterThan(0);
          const delivered = await eventsOf(chat, 'delivery.completed');
          expect(delivered[0]?.payload).toMatchObject({ mode: 'pr', requestedBy: 'producer' });
        },
      );
    }, 240_000);
  },
);
