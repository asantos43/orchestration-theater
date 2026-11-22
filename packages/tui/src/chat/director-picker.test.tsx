// SPDX-License-Identifier: MPL-2.0
import type { SlashCommandResult } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupApps,
  renderApp,
  TEST_UI_SETTINGS,
  waitFor,
  type RenderedApp,
} from '../ink.test-support.js';
import { fakeOnline, seedStores } from '../layout.test-support.js';
import { sgrReport } from '../mouse/sgr.js';
import type { UiSettings } from '../settings.js';
import {
  directorCommandOf,
  directorFooter,
  directorPickerModel,
  directorViewOf,
} from './director-picker.js';

/**
 * The footer and the picker of the Director (P14 of Phase 9, N242) over `ink-testing-library`: the
 * fake daemon answers `/director` with a view and records every line the TUI sends to it, so the
 * test sees that the footer shows the Director, that the click and the shortcut open the picker and
 * that a choice calls the daemon with the line the Producer could type.
 */

afterEach(cleanupApps);

const SIZE = { columns: 140, rows: 42 };
const ALT_M = '\x1bm';
const ESC = '\x1b';
const DOWN = '\x1b[B';
const ENTER = '\r';

const t = (key: string, options?: Record<string, unknown>): string =>
  `${key}${options === undefined ? '' : JSON.stringify(options)}`;

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scenarioId: 'S',
    session: 'open',
    inTurn: false,
    pending: false,
    current: {
      executor: 'low@f/main',
      client: 'fake',
      profile: 'fake/main',
      model: 'fake-model',
      effort: 'low',
    },
    override: null,
    default: 'low@f/main',
    executors: [
      {
        index: 1,
        id: 'low@f/main',
        validity: 'valid',
        invalidReason: null,
        quota: 'ok',
        current: true,
        isDefault: true,
      },
      {
        index: 2,
        id: 'high@f/two',
        validity: 'valid',
        invalidReason: null,
        quota: 'near_limit',
        current: false,
        isDefault: false,
      },
    ],
    models: [{ id: 'fake-model', name: null, efforts: ['low', 'high'] }],
    efforts: ['low', 'high'],
    inTurnMode: 'wait',
    ...overrides,
  };
}

describe('the pieces of the footer and of the picker', () => {
  it('reads the view of /director and ignores what is not one', () => {
    expect(directorViewOf(undefined)).toBeUndefined();
    expect(directorViewOf({ director: { session: 'bad' } })).toBeUndefined();
    const read = directorViewOf({ director: view() });
    expect(read?.executors.map((item) => item.id)).toEqual(['low@f/main', 'high@f/two']);
    expect(read?.models).toEqual(['fake-model']);
    expect(read?.overridden).toBe(false);
  });

  it('writes the footer with the Executor, the model, the effort and where it comes from', () => {
    const read = directorViewOf({ director: view({ override: { executor: 'x' } }) });
    expect(read).toBeDefined();
    if (read === undefined) return;
    const line = directorFooter(read, 'Alt+M', t);
    expect(line).toContain('"executor":"low@f/main"');
    expect(line).toContain('[fake-model / low]');
    expect(directorFooter({ ...read, current: null }, 'Alt+M', t)).toContain(
      'layout.chat.directorFooter.none',
    );
    expect(directorFooter({ ...read, pending: true }, 'Alt+M', t)).toContain(
      'layout.chat.directorFooter.pending',
    );
  });

  it('turns a pick into the line of the command', () => {
    expect(directorCommandOf('executor:a@b/c')).toBe('/director a@b/c');
    expect(directorCommandOf('model:m')).toBe('/model m');
    expect(directorCommandOf('effort:high')).toBe('/effort high');
    expect(directorCommandOf('default')).toBe('/director default');
    expect(directorCommandOf('executor:')).toBeUndefined();
    expect(directorCommandOf('what')).toBeUndefined();
  });

  it('lists the Executors, the models, the efforts and the way back to the default', () => {
    const read = directorViewOf({ director: view() });
    if (read === undefined) throw new Error('no view');
    const step = directorPickerModel(read, t).stepAt(0, []);
    expect(step?.options.map((option) => option.id)).toEqual([
      'executor:low@f/main',
      'executor:high@f/two',
      'model:fake-model',
      'effort:low',
      'effort:high',
      'default',
    ]);
  });
});

interface Open {
  readonly app: RenderedApp;
  readonly lines: string[];
}

async function open(
  options: {
    readonly settings?: UiSettings;
    readonly director?: () => Record<string, unknown>;
  } = {},
): Promise<Open> {
  const lines: string[] = [];
  const director = options.director ?? (() => view());
  const online = fakeOnline({
    runCommand: (line): Promise<SlashCommandResult> => {
      if (line === '/director') {
        return Promise.resolve({
          status: 'done',
          command: 'director',
          text: '',
          data: { director: director() } as unknown as SlashCommandResult['data'],
        });
      }
      lines.push(line);
      return Promise.resolve({ status: 'done', command: 'director', text: 'ok' });
    },
  });
  seedStores(online.stores);
  const app = await renderApp({
    connector: online.connector,
    size: SIZE,
    settings: options.settings ?? TEST_UI_SETTINGS,
    mouseWrites: [],
  });
  await app.waitForText('127.0.0.1');
  await waitFor(() => (online.chat.sockets.size > 0 ? true : undefined), 'a chat socket');
  return { app, lines };
}

async function click(app: RenderedApp, text: string): Promise<void> {
  const frame = app.frame();
  const rows = frame.split('\n');
  const row = rows.findIndex((line) => line.includes(text));
  if (row < 0) throw new Error(`"${text}" is not on the screen:\n${frame}`);
  const col = (rows[row] ?? '').indexOf(text);
  app.press(sgrReport({ action: 'press', button: 'left', col, row }));
  await app.settle();
  app.press(sgrReport({ action: 'release', button: 'left', col, row }));
  await app.settle();
}

describe('the footer of the Director in the chat', () => {
  it('shows the Executor, the model and the effort under the text box', async () => {
    const { app } = await open();
    const frame = await app.waitForText('Director: low@f/main [fake-model / low]');
    expect(frame).toContain('(default)');
    expect(frame).toContain('Alt+M');
  });

  it('shows where an override comes from and that a switch waits for the turn', async () => {
    const { app } = await open({
      director: () =>
        view({
          override: { executor: 'low@f/main' },
          pending: true,
          current: {
            executor: 'low@f/main',
            client: 'f',
            profile: 'f/main',
            model: 'm',
            effort: null,
          },
        }),
    });
    const frame = await app.waitForText('your choice');
    expect(frame).toContain('switch queued');
  });

  it('is left out with ui.chat.directorFooter off, and the shortcut then still opens the picker', async () => {
    const settings: UiSettings = {
      ...TEST_UI_SETTINGS,
      chat: { ...TEST_UI_SETTINGS.chat, directorFooter: 'off' },
    };
    const { app } = await open({ settings });
    await app.settle();
    expect(app.frame()).not.toContain('Director: low@f/main');
    app.press(ALT_M);
    await app.waitForText('Director of this scenario');
  });
});

describe('the picker of the Director', () => {
  it('opens with the shortcut, walks with the arrows and calls the daemon with the choice', async () => {
    const { app, lines } = await open();
    await app.waitForText('Director: low@f/main');
    app.press(ALT_M);
    const frame = await app.waitForText('Director of this scenario');
    expect(frame).toContain('high@f/two');
    expect(frame).toContain('quota near_limit');
    expect(frame).toContain('back to the default');
    app.press(DOWN);
    await app.settle();
    app.press(ENTER);
    await waitFor(() => (lines.length > 0 ? true : undefined), 'the command to the daemon');
    expect(lines).toEqual(['/director high@f/two']);
    await app.settle();
    expect(app.frame()).not.toContain('Director of this scenario');
  });

  it('opens with a click on the footer and takes a click on an option', async () => {
    const { app, lines } = await open();
    await app.waitForText('Director: low@f/main');
    await click(app, 'Director: low@f/main');
    await app.waitForText('Director of this scenario');
    await click(app, 'effort: high');
    await waitFor(() => (lines.length > 0 ? true : undefined), 'the command to the daemon');
    expect(lines).toEqual(['/effort high']);
  });

  it('goes back to the default with its line and closes with Esc', async () => {
    const { app, lines } = await open();
    await app.waitForText('Director: low@f/main');
    app.press(ALT_M);
    await app.waitForText('Director of this scenario');
    app.press(ESC);
    await app.settle();
    await waitFor(
      () => (app.frame().includes('Director of this scenario') ? undefined : true),
      'the picker closed',
    );
    expect(lines).toEqual([]);
    app.press(ALT_M);
    await app.waitForText('back to the default');
    for (let step = 0; step < 5; step += 1) {
      app.press(DOWN);
      await app.settle();
    }
    app.press(ENTER);
    await waitFor(() => (lines.length > 0 ? true : undefined), 'the command to the daemon');
    expect(lines).toEqual(['/director default']);
  });
});
