// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, type RenderedApp } from './ink.test-support.js';
import {
  assertFakeAgentBuilt,
  NO_LAUNCHER,
  waitUntil,
  withChatDaemon,
  type ChatFakes,
} from './chat/fake-agent.test-support.js';

/**
 * The part of the acceptance of Phase 9 (P13 of docs/20) that is the screen: the tab Plugins draws
 * the panel of the example plugin `notes` from what the REAL route `GET /v1/plugins/:pluginId/panel`
 * answers (the real daemon of this process, the real client, the default wiring of the tab: no
 * fake API and no recorded response), with no code of the plugin in the interface. The action of the
 * panel waits for the Producer, and what the Producer answers is what happens. It runs in English
 * and in Brazilian Portuguese; the words of the screen come from the catalog (`app.i18n.t`) and the
 * words of the panel from the `i18n` block of the manifest. The rest of the phase (roles, secret,
 * event, flow, spans and metrics) is in `packages/daemon/src/phase9-acceptance.e2e.test.ts`.
 *
 * Nothing real runs: temporary home, SQLite and data folder, loopback only, fake clock and agent,
 * in-memory vault. The plugin's server is the example as it ships (its `dist` comes from `pnpm
 * build`), started by the daemon for the panel and nothing else: no Executor calls it here.
 *
 * Timings are real and tolerant to load: every wait polls the frame or the daemon with a wide
 * timeout, and a key is followed by a wait for the screen it should cause.
 */

beforeAll(assertFakeAgentBuilt);
afterEach(cleanupApps);

const SIZE = { columns: 220, rows: 60 };
const F6 = '\x1b[17~';
const WAIT_MS = 60_000;

/** The example plugin, as it is in the repository. */
const NOTES_DIR = fileURLToPath(new URL('../../../examples/plugin-notes', import.meta.url));

const LOCALES = [
  {
    name: 'en',
    systemLocale: 'en_US.UTF-8',
    title: 'Notes',
    action: 'Delete all notes',
    texts: ['Notes', 'Note', 'Created'],
  },
  {
    name: 'pt-BR',
    systemLocale: 'pt_BR.UTF-8',
    title: 'Notas',
    action: 'Apagar todas as notas',
    texts: ['Notas', 'Nota', 'Criada em'],
  },
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

/** The frame without the runs of spaces, so a text on one line matches wherever the column puts it. */
function flat(frame: string): string {
  return frame.replace(/\s+/g, ' ');
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

/** The notes the plugin keeps in the folder of the project. */
function notesFile(notes: { id: number; text: string }[]): string {
  return JSON.stringify({
    version: 1,
    next_id: notes.length + 1,
    notes: notes.map((note) => ({ ...note, created_at: '2026-11-22T12:00:00.000Z' })),
  });
}

describe.skipIf(NO_LAUNCHER).each(LOCALES)(
  'the acceptance of Phase 9 on the screen, in $name',
  ({ systemLocale, title, action, texts }) => {
    it(
      'draws the panel the route answers, and the action waits for the Producer',
      { timeout: 180_000 },
      async () => {
        await withChatDaemon(fakes(), {}, async (chat) => {
          const { daemon, scenarioId, repo } = chat;
          const { producer } = daemon;
          if (producer === undefined) throw new Error('the daemon has no Producer channel');

          // The plugin is installed and turned on in the project of the scenario, the way the CLI does it.
          const manifest = await readFile(join(NOTES_DIR, 'plugin.yaml'));
          const hash = createHash('sha256').update(manifest).digest('hex');
          await daemon.plugins.register({
            id: 'notes',
            version: '1.0.0',
            origin: { kind: 'path', path: NOTES_DIR },
            dir: NOTES_DIR,
            manifestHash: hash,
          });
          await daemon.plugins.enable('notes', scenarioId, hash);
          const file = join(repo, '.plugin-notes.json');
          await writeFile(
            file,
            notesFile([
              { id: 1, text: 'buy milk' },
              { id: 2, text: 'call the bank' },
            ]),
          );

          const app = await renderApp({
            connector: chat.connector,
            systemLocale,
            size: SIZE,
            chatSocket: { initialDelayMs: 20, maxDelayMs: 50, jitter: 0 },
          });
          const translate = app.i18n.t.bind(app.i18n) as (
            key: string,
            vars?: Record<string, unknown>,
          ) => string;
          const T = (key: string, vars?: Record<string, unknown>): string =>
            flat(translate(key, vars));

          // 1. The tab lists the plugin as on, and draws the panel of its manifest: the title, the
          //    columns and the language come from the manifest and the route, the rest from the catalog.
          await seen(app, T('layout.sidebar.scenarios'));
          await seen(app, T('layout.chat.director.active'));
          app.press(F6);
          await app.settle();
          await seen(app, 'buy milk');
          const frame = flat(app.frame());
          for (const text of texts) expect(frame, `the panel shows "${text}"`).toContain(text);
          expect(frame).toContain('call the bank');
          expect(frame).toMatch(/notes 1\.0\.0 /);
          expect(frame).toContain(`[ ${action} ]`);
          expect(frame).toContain(T(`plugins.action.approval.manifest`));

          // 2. The action asks the Producer, and nothing is deleted before the answer.
          app.press('a');
          await seen(app, T('plugins.action.waiting', { action }));
          const ask = await waitUntil(
            'the card of the approval',
            async () =>
              (await producer.state(scenarioId)).asks.find((card) =>
                JSON.stringify(card.input).includes('notes__clear_notes'),
              ),
            WAIT_MS,
          );
          expect(await readFile(file, 'utf8')).toContain('buy milk');
          const options = (ask.input as { questions: { options: { label: string }[] }[] })
            .questions[0]?.options;
          const allow = options?.[0]?.label;
          expect(allow).toBeDefined();
          await producer.answer(ask.id, { answers: [allow ?? ''] });

          // 3. The Producer allowed it: the screen says it is done, and the notes are gone.
          await seen(app, T('plugins.action.doneWith', { action, result: '{"deleted":2}' }));
          await gone(app, 'buy milk');
          expect((JSON.parse(await readFile(file, 'utf8')) as { notes: unknown[] }).notes).toEqual(
            [],
          );
          expect(flat(app.frame())).toContain(title);
        });
      },
    );
  },
);
