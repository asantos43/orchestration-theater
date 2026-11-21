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
  type ChatFakes,
} from '../../chat/fake-agent.test-support.js';
import {
  cleanupApps,
  KEYS,
  renderApp,
  TEST_UI_SETTINGS,
  type RenderedApp,
} from '../../ink.test-support.js';

/**
 * The telemetry panels of the Usage tab (Phase 8, P10) against the real daemon with the fake agent:
 * a play runs to the end, and the tab draws the tree of its spans and the state of the telemetry
 * from the two new routes, and the trend and the bottlenecks from the analysis (no day is closed
 * yet in a daemon that has just started, so those two say so instead of drawing zeros). Nothing real
 * runs (N57): temporary folders, loopback, a fake clock, a fake code host and the fake agent.
 * It runs in English and in Brazilian Portuguese, every expected text taken from the catalog.
 */

beforeAll(assertFakeAgentBuilt);
afterEach(cleanupApps);

const SIZE = { columns: 230, rows: 70 };
const NEED = '#ot-play write alpha and beta #outcome:approved';

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

/** Opens a tab through the palette (the tab has no key of its own). */
async function openTab(app: RenderedApp, palette: string, tab: string): Promise<void> {
  app.press('\x1bk');
  await app.waitForText(palette);
  app.press(tab);
  await app.waitForText(tab);
  app.press(KEYS.enter);
  await app.settle();
}

describe.skipIf(NO_LAUNCHER).each(LOCALES)(
  'the telemetry panels of the Usage tab against the daemon, in $name',
  { timeout: 180_000 },
  ({ systemLocale }) => {
    it('draws the spans of the finished play, the state of the telemetry and the empty trend', async () => {
      await withChatDaemon(fakes(), {}, async (chat) => {
        const producer = chat.daemon.producer;
        if (producer === undefined) throw new Error('the daemon has no Producer channel');
        await producer.send(chat.scenarioId, NEED);
        const play = await waitUntil('the play', async () => (await chat.plays())[0]);
        await waitUntil('the play to be DONE', async () =>
          (await chat.plays())[0]?.state === 'DONE' ? true : undefined,
        );

        const app = await renderApp({
          connector: chat.connector,
          size: SIZE,
          systemLocale,
          settings: {
            ...TEST_UI_SETTINGS,
            usage: {
              ...TEST_UI_SETTINGS.usage,
              sections: ['trend', 'bottlenecks', 'play', 'telemetry'],
              refreshSeconds: 1,
            },
          },
          chatSocket: { initialDelayMs: 20, maxDelayMs: 50, jitter: 0 },
        });
        const translate = app.i18n.t.bind(app.i18n) as (
          key: string,
          vars?: Record<string, unknown>,
        ) => string;
        const t = (key: string, vars?: Record<string, unknown>): string => translate(key, vars);
        await app.waitForText(t('layout.sidebar.scenarios'));
        await openTab(app, t('layout.palette.title'), t('tabs.usage'));

        // The tree of the play: the span of the play, its stages and its attempts.
        const seen = async (text: string): Promise<string> =>
          waitUntil(
            `"${text}" (last frame: ${app.frame()})`,
            () => {
              const frame = app.frame().replace(/\s+/g, ' ');
              return Promise.resolve(frame.includes(text) ? frame : undefined);
            },
            60_000,
          );
        await seen(t('usage.play.title'));
        await seen(play.id);
        await seen(t('usage.play.kind.play'));
        await seen(t('usage.play.kind.stage'));
        await seen(t('usage.play.kind.attempt'));

        // The state of the telemetry: the receiver listens, nothing was refused.
        await seen(t('usage.telemetry.title'));
        await seen(t('usage.telemetry.rejected', { format: 0, size: 0, token: 0 }));

        // A daemon that has just started has closed no day: the trend says so, with no zeros.
        await seen(t('usage.trend.noneReady'));
        await seen(t('usage.bottlenecks.none'));
        expect(app.frame()).not.toContain(t('usage.failed.other', { code: 'internal' }));
        expect(app.frame()).not.toMatch(/Could not|Não foi possível/);
      });
    });
  },
);
