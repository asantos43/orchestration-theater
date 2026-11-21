// SPDX-License-Identifier: MPL-2.0
import type { ChatServerMessage } from '@otheater/protocol';
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
import type { FakeChatSocket } from './fake-socket.test-support.js';

/**
 * The click on the options of the decision card (P14 of docs/19, N34): the mouse reports go through
 * the real layer over `ink-testing-library`, and a click does what the keys of the registry do on
 * that option, on a simple and on a multiple choice, in each mode of `ui.chat.decisionClick`.
 */

afterEach(cleanupApps);

const SIZE = { columns: 140, rows: 42 };
const DOWN = '\x1b[B';
const ENTER = '\r';

interface Point {
  readonly col: number;
  readonly row: number;
}

interface Open {
  readonly app: RenderedApp;
  readonly socket: () => FakeChatSocket;
}

async function open(settings: UiSettings = TEST_UI_SETTINGS): Promise<Open> {
  const online = fakeOnline();
  seedStores(online.stores);
  const app = await renderApp({
    connector: online.connector,
    size: SIZE,
    settings,
    mouseWrites: [],
  });
  await app.waitForText('127.0.0.1');
  const socket = (): FakeChatSocket => {
    const [first] = [...online.chat.sockets.keys()];
    const found = first === undefined ? undefined : online.chat.latest(first);
    if (found === undefined) throw new Error('the chat has no socket yet');
    return found;
  };
  await waitFor(() => (online.chat.sockets.size > 0 ? true : undefined), 'a chat socket');
  return { app, socket };
}

const withChat = (chat: Partial<UiSettings['chat']>): UiSettings => ({
  ...TEST_UI_SETTINGS,
  chat: { ...TEST_UI_SETTINGS.chat, ...chat },
});

const simple: Extract<ChatServerMessage, { type: 'ask' }> = {
  type: 'ask',
  eventId: 1,
  decisionId: 'D1',
  kind: 'producer_question',
  playId: null,
  input: {
    questions: [
      {
        question: 'Which database?',
        options: [
          { label: 'sqlite', description: 'one file' },
          { label: 'postgres', description: 'a server' },
        ],
        multi_select: false,
      },
    ],
  },
};

const multiple: Extract<ChatServerMessage, { type: 'ask' }> = {
  ...simple,
  input: {
    questions: [
      {
        question: 'Which checks?',
        options: [{ label: 'lint' }, { label: 'types' }, { label: 'tests' }],
        multi_select: true,
      },
    ],
  },
};

/** Where `text` is on the screen, the way a person points at what they see. */
function locate(frame: string, text: string): Point {
  const lines = frame.split('\n');
  for (let row = 0; row < lines.length; row += 1) {
    const col = (lines[row] ?? '').indexOf(text);
    if (col >= 0) return { col, row };
  }
  throw new Error(`"${text}" is not on the screen:\n${frame}`);
}

async function click(app: RenderedApp, at: Point): Promise<string> {
  app.press(sgrReport({ action: 'press', button: 'left', ...at }));
  await app.settle();
  app.press(sgrReport({ action: 'release', button: 'left', ...at }));
  return app.settle();
}

const answers = (socket: FakeChatSocket): unknown[] =>
  socket.sentOf('answer').map((frame) => frame.answer);

describe('a click on a simple choice', () => {
  it('answers with the option, as the number key does (answer, the default)', async () => {
    const { app, socket } = await open();
    socket().emit(simple);
    const frame = await app.waitForText('Which database?');
    await click(app, locate(frame, '2. postgres'));
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the decision',
    );
    expect(socket().sentOf('answer')).toEqual([
      { type: 'answer', decisionId: 'D1', answer: { answers: ['postgres'] } },
    ]);
  });

  it('answers with the option the cursor is on when the click is on its description', async () => {
    const { app, socket } = await open();
    socket().emit(simple);
    await app.waitForText('Which database?');
    // The description of the option under the cursor is part of it.
    const frame = await app.waitForText('one file');
    await click(app, locate(frame, 'one file'));
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the decision',
    );
    expect(answers(socket())).toEqual([{ answers: ['sqlite'] }]);
  });

  it('ui.chat.decisionClick select: the first click moves the cursor, the second answers', async () => {
    const { app, socket } = await open(withChat({ decisionClick: 'select' }));
    socket().emit(simple);
    const frame = await app.waitForText('Which database?');
    const second = locate(frame, '2. postgres');
    const moved = await click(app, second);
    expect(socket().sentOf('answer')).toEqual([]);
    // The cursor is on postgres now (its description is shown, the arrow is on its line).
    expect(moved).toContain('a server');
    expect(moved).toMatch(/› 2\. postgres/);
    await click(app, locate(moved, '2. postgres'));
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the decision',
    );
    expect(answers(socket())).toEqual([{ answers: ['postgres'] }]);
  });

  it('is the same as the arrows and Enter: the cursor of the keys is where the click left it', async () => {
    const { app, socket } = await open(withChat({ decisionClick: 'select' }));
    socket().emit(simple);
    const frame = await app.waitForText('Which database?');
    await click(app, locate(frame, '2. postgres'));
    app.press(ENTER);
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the decision',
    );
    expect(answers(socket())).toEqual([{ answers: ['postgres'] }]);
  });
});

describe('a click on a multiple choice', () => {
  it('marks and unmarks the option, and Enter answers with the marked ones', async () => {
    const { app, socket } = await open();
    socket().emit(multiple);
    let frame = await app.waitForText('Which checks?');
    frame = await click(app, locate(frame, '3. [ ] tests'));
    expect(frame).toContain('3. [x] tests');
    frame = await click(app, locate(frame, '1. [ ] lint'));
    expect(frame).toContain('1. [x] lint');
    frame = await click(app, locate(frame, '3. [x] tests'));
    expect(frame).toContain('3. [ ] tests');
    // A click never answers a multiple choice by itself.
    expect(socket().sentOf('answer')).toEqual([]);
    app.press(ENTER);
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the decision',
    );
    expect(answers(socket())).toEqual([{ answers: ['lint'] }]);
  });

  it('with select, the first click only moves the cursor and the second marks', async () => {
    const { app, socket } = await open(withChat({ decisionClick: 'select' }));
    socket().emit(multiple);
    let frame = await app.waitForText('Which checks?');
    frame = await click(app, locate(frame, '2. [ ] types'));
    expect(frame).toContain('2. [ ] types');
    expect(frame).toMatch(/› 2\. \[ \] types/);
    frame = await click(app, locate(frame, '2. [ ] types'));
    expect(frame).toContain('2. [x] types');
    app.press(DOWN);
    app.press(ENTER);
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the decision',
    );
    expect(answers(socket())).toEqual([{ answers: ['types'] }]);
  });
});

describe('a click on an option that asks for text', () => {
  it('opens the line to type, as the key does, and a click on the list while typing does nothing', async () => {
    const { app, socket } = await open();
    socket().emit(simple);
    let frame = await app.waitForText('Which database?');
    frame = await click(app, locate(frame, '3. Other'));
    expect(frame).toContain('█');
    expect(socket().sentOf('answer')).toEqual([]);
    // The keys do not move the cursor while the text is typed; neither does the mouse.
    frame = await click(app, locate(frame, '1. sqlite'));
    expect(socket().sentOf('answer')).toEqual([]);
    expect(frame).toContain('█');
  });
});

describe('the mouse off', () => {
  it('ui.mouse off: a click on the options does nothing and the keys still answer', async () => {
    const { app, socket } = await open({ ...TEST_UI_SETTINGS, mouse: 'off' });
    socket().emit(simple);
    const frame = await app.waitForText('Which database?');
    await click(app, locate(frame, '2. postgres'));
    expect(socket().sentOf('answer')).toEqual([]);
    app.press('2');
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the decision',
    );
    expect(answers(socket())).toEqual([{ answers: ['postgres'] }]);
  });

  it('ui.mouse wheel has no click either', async () => {
    const { app, socket } = await open({ ...TEST_UI_SETTINGS, mouse: 'wheel' });
    socket().emit(simple);
    const frame = await app.waitForText('Which database?');
    await click(app, locate(frame, '2. postgres'));
    expect(socket().sentOf('answer')).toEqual([]);
  });
});
