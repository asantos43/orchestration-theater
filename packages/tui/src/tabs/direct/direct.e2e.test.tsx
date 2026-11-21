// SPDX-License-Identifier: MPL-2.0
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFakeAgentBuilt,
  NO_LAUNCHER,
  waitUntil,
  withChatDaemon,
  type ChatDaemon,
  type ChatFakes,
} from '../../chat/fake-agent.test-support.js';
import { cleanupApps, renderApp, type RenderedApp } from '../../ink.test-support.js';
import { openDirectTab } from './direct.test-support.js';

/**
 * The acceptance of the direct session (P19 of docs/18), against the real daemon with the fake
 * agent: the tab of the TUI opens a session with an Actor, converses with it, runs a command of the
 * client and promotes the result to a demand; a `readonly` session has its write barred. Nothing
 * real runs (N57): the daemon is in a temporary folder, on loopback, with a fake clock, a fake
 * code host and the fake agent as the client; no test reads a credential. The test is here and
 * not in the daemon because the daemon may not import the TUI (`tui-launcher-only-from-cli`).
 */

beforeAll(assertFakeAgentBuilt);
afterEach(cleanupApps);

const SIZE = { columns: 230, rows: 60 };
const ENTER = '\r';
const RIGHT = '\x1b[C';

const ROLES = ['director', 'consultant', 'author', 'reviewer', 'scriptwriter', 'actor', 'critic'];
const entry = (profile: string): string => `fake-model@fake/${profile}`;

/** The registry of two profiles and the lists of the roles, as the daemon test of the session has it. */
const ROLES_YAML = `
executors:
${['one', 'two']
  .map(
    (profile) =>
      `  ${entry(profile)}:\n    client: fake\n    profile: ${profile}\n    model: fake-model\n`,
  )
  .join('')}
roles:
${ROLES.map((role) => `  ${role}:\n    executors: [${entry('one')}, ${entry('two')}]\n`).join('')}
selection:
  recheck_every: off
`;

function fakes(): ChatFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({
        launcher,
        baseEnv: {},
        // The Actor of a direct session plays `echo`, and the fake client announces its command.
        env: { ...env, FAKE_AGENT_SCRIPT: 'echo', FAKE_AGENT_UPDATES_ON_CONFIG: '1' },
        adapterVersion: '1.0.0',
        command,
      }),
  };
}

async function withDirectDaemon(body: (daemon: ChatDaemon) => Promise<void>): Promise<void> {
  await withChatDaemon(
    fakes(),
    {
      extra: ROLES_YAML,
      prepare: async (daemon, dataDir) => {
        for (const name of ['one', 'two']) {
          await daemon.store.profiles.create({
            client: 'fake',
            name,
            kind: 'token_plan',
            provider: 'fake',
            dir: `${dataDir}/profiles-of-the-test/${name}`,
            secretRef: null,
          });
        }
      },
    },
    body,
  );
}

/** The TUI over the real daemon, on the tab Direct session. */
async function openTui(daemon: ChatDaemon): Promise<RenderedApp> {
  const app = await renderApp({
    connector: daemon.connector,
    size: SIZE,
    chatSocket: { initialDelayMs: 20, maxDelayMs: 50, jitter: 0 },
  });
  await app.waitForText('SCENARIOS');
  await openDirectTab(app);
  await app.waitForText('No direct session yet');
  return app;
}

/** Types text into the box, a key at a time, as a person does. */
async function typeText(app: RenderedApp, text: string): Promise<void> {
  for (const char of text) {
    app.press(char);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await app.settle();
}

/** Waits for the frame to show `text` (the real daemon is slower than a fake one). */
async function seen(app: RenderedApp, text: string): Promise<string> {
  return waitUntil(`the text "${text}" (last frame: ${app.frame()})`, () => {
    const frame = app.frame();
    return Promise.resolve(frame.includes(text) ? frame : undefined);
  });
}

describe.skipIf(NO_LAUNCHER)(
  'the direct session of the TUI against the daemon with the fake agent (P19)',
  { timeout: 180_000 },
  () => {
    it('opens a session, converses, runs a client command and promotes the result to a demand', async () => {
      await withDirectDaemon(async (daemon) => {
        const app = await openTui(daemon);
        app.press('n');
        await seen(app, 'Open a direct session');
        // The Executors of the profile list are the ones the form offers: Right picks the first.
        app.press(RIGHT);
        await app.settle();
        await seen(app, entry('one'));
        app.press(ENTER);
        await seen(app, 'open.');
        const frame = await seen(app, 'own worktree');
        expect(frame).toContain('fake/one');
        expect(frame).toContain('/fake:fake-command');

        // It converses: the Actor (the fake agent) answers with what it was told.
        app.press('t');
        await app.settle();
        await typeText(app, 'hello direct actor');
        app.press(ENTER);
        await seen(app, 'you › hello direct actor');
        await seen(app, 'actor › ');
        const talked = await waitUntil('the answer of the Actor', () => {
          const text = app.frame();
          return Promise.resolve(text.split('hello direct actor').length > 2 ? text : undefined);
        });
        expect(talked).toContain('1 turns');

        // A command of the client, with "/": a turn of its own.
        await typeText(app, '/fake:fake-command with arguments');
        app.press(ENTER);
        await seen(app, '/ /fake:fake-command with arguments');
        await seen(app, 'actor › /fake-command with arguments');
        await waitUntil('the second turn to end', () =>
          Promise.resolve(app.frame().includes('2 turns') ? true : undefined),
        );

        // Back to the screen (Esc), the result goes to the queue of demands.
        // (Esc is read after a short wait for an escape sequence: "d" must not join it.)
        app.press('\x1b');
        await new Promise((resolve) => setTimeout(resolve, 400));
        app.press('d');
        await seen(app, 'Result sent to the demand queue');
        const ideas = await daemon.daemon.store.ideas.list({ scenarioId: daemon.scenarioId });
        expect(ideas).toHaveLength(1);
        expect(ideas[0]?.text).toContain('fake-command with arguments');

        // Closing: the session stays on the list as closed, with its branch kept.
        app.press('x');
        await seen(app, 'Session closed.');
        await seen(app, 'closed');
        const events = await daemon.events();
        for (const type of [
          'direct.session.opened',
          'direct.session.message',
          'direct.session.command',
          'direct.session.promoted',
          'direct.session.closed',
        ]) {
          expect(
            events.some((event) => event.type === type),
            type,
          ).toBe(true);
        }
      });
    });

    it('bars the write of a read-only session and shows the decision in the tab', async () => {
      await withDirectDaemon(async (daemon) => {
        const app = await openTui(daemon);
        app.press('n');
        await seen(app, 'Open a direct session');
        // Second field, the folder: configured, own worktree, read only.
        app.press('\t');
        await app.settle();
        app.press(RIGHT);
        await app.settle();
        app.press(RIGHT);
        await app.settle();
        await seen(app, '‹ read only ›');
        app.press(ENTER);
        await seen(app, 'read only · idle');
        app.press('t');
        await app.settle();
        await typeText(app, '#script:edit-file {"path":"barred.txt","content":"no"}');
        app.press(ENTER);
        await seen(app, 'barred: ');
        const repoFile = `${daemon.dataDir}/../repo/barred.txt`;
        const { access } = await import('node:fs/promises');
        await expect(access(repoFile)).rejects.toThrow();
        const events = await daemon.events();
        expect(events.some((event) => event.type === 'direct.session.permission')).toBe(true);
      });
    });

    it('asks to confirm before a session writes in the folder of the scenario', async () => {
      await withDirectDaemon(async (daemon) => {
        const app = await openTui(daemon);
        app.press('n');
        await seen(app, 'Open a direct session');
        app.press('\t');
        await app.settle();
        for (let i = 0; i < 3; i += 1) {
          app.press(RIGHT);
          await app.settle();
        }
        await seen(app, '‹ scenario folder ›');
        app.press(ENTER);
        await seen(app, 'writes in the folder of the scenario itself');
        expect(
          (await daemon.events()).some((event) => event.type === 'direct.session.opened'),
        ).toBe(false);
        app.press(ENTER);
        await seen(app, 'scenario folder · idle');
        expect(
          (await daemon.events()).some((event) => event.type === 'direct.session.opened'),
        ).toBe(true);
      });
    });
  },
);
