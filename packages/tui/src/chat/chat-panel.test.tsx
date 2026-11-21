// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiSlashCommand, ChatServerMessage } from '@otheater/protocol';
import { cleanupApps, renderApp, waitFor, type RenderedApp } from '../ink.test-support.js';
import { fakeOnline, seedStores, type FakeOnline } from '../layout.test-support.js';
import type { FakeChatSocket } from './fake-socket.test-support.js';

/**
 * The chat of the panel over `ink-testing-library` (P12): the fake daemon plays the frames of the
 * `ChatSocket` and the test presses keys. What the real daemon does with them is the job of the
 * test with the fake-agent (`chat.e2e.test.tsx`).
 */

afterEach(cleanupApps);

const SIZE = { columns: 140, rows: 42 };
const ENTER = '\r';
const ESC = '\x1b';
const DOWN = '\x1b[B';
const CTRL_N = '\x0e';

function command(name: string, overrides: Partial<ApiSlashCommand> = {}): ApiSlashCommand {
  return {
    id: name,
    name: `/${name}`,
    origin: 'daemon',
    group: 'query',
    descriptionKey: `commands.${name}`,
    description: `does ${name}`,
    args: '',
    confirm: false,
    ...overrides,
  };
}

interface Open {
  readonly app: RenderedApp;
  readonly online: FakeOnline;
  /** The socket of the scenario the chat is on. */
  readonly socket: () => FakeChatSocket;
}

async function open(commands: readonly ApiSlashCommand[] = []): Promise<Open> {
  const online = fakeOnline({ commands });
  seedStores(online.stores);
  const app = await renderApp({ connector: online.connector, size: SIZE });
  await app.waitForText('127.0.0.1');
  const socket = (): FakeChatSocket => {
    const [first] = [...online.chat.sockets.keys()];
    const found = first === undefined ? undefined : online.chat.latest(first);
    if (found === undefined) throw new Error('the chat has no socket yet');
    return found;
  };
  await waitFor(() => (online.chat.sockets.size > 0 ? true : undefined), 'a chat socket');
  return { app, online, socket };
}

const reply = (eventId: number, text: string, final = false) =>
  ({ type: 'director_reply', eventId, replyId: 1, text, final }) as const;

/** Types text into the box, one write per character so no key is taken as a paste. */
async function typeText(app: RenderedApp, text: string): Promise<void> {
  for (const char of text) {
    app.press(char);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await app.settle();
}

function scenarioOf(online: FakeOnline): string {
  const [first] = [...online.chat.sockets.keys()];
  if (first === undefined) throw new Error('the chat has no socket yet');
  return first;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('the conversation', () => {
  it('draws a streamed reply and the text of the Producer, once each', async () => {
    const { app, socket } = await open();
    await typeText(app, 'make it fast');
    app.press(ENTER);
    await app.waitForText('make it fast');
    expect(socket().sentOf('message')).toEqual([{ type: 'message', text: 'make it fast' }]);
    socket().emit(reply(1, 'Sure, '));
    socket().emit(reply(2, 'on it.'));
    const frame = await app.waitForText('Sure, on it.');
    expect(count(frame, 'Sure, on it.')).toBe(1);
    socket().emit(reply(3, '', true));
    const done = await app.settle();
    expect(count(done, 'Sure, on it.')).toBe(1);
  });

  it('shows the state of the Director in the line of the chat', async () => {
    const { app, socket } = await open();
    await app.waitForText('Director active');
    socket().emit({ type: 'busy', eventId: 1, busy: true });
    // The line of the chat is as wide as the chat: the end of it may be cut.
    await app.waitForText('Director in a turn');
    socket().emit({ type: 'busy', eventId: 2, busy: false });
    await app.waitForText('Director active');
  });

  it('shows the connection state when the socket drops and comes back', async () => {
    const { app, socket } = await open();
    socket().setState('retrying');
    await app.waitForText('reconnecting');
    socket().setState('open');
    const frame = await app.waitForText('Director active');
    expect(frame).not.toContain('reconnecting');
  });
});

describe('Esc stops the reply of the Director', () => {
  it('sends /stop when the Director is in a turn', async () => {
    const { app, socket } = await open();
    socket().emit({ type: 'busy', eventId: 1, busy: true });
    await app.waitForText('in a turn');
    app.press(ESC);
    await waitFor(
      () => (socket().sentOf('command').length > 0 ? true : undefined),
      'the command /stop',
    );
    expect(socket().sentOf('command')).toEqual([{ type: 'command', text: '/stop' }]);
  });

  it('sends nothing when the Director is not in a turn', async () => {
    const { app, socket } = await open();
    await app.waitForText('Director active');
    app.press(ESC);
    await app.settle();
    expect(socket().sent).toEqual([]);
  });
});

describe('the queue while the Director is in a turn', () => {
  it('sends the message at once and marks it as queued', async () => {
    const { app, socket } = await open();
    socket().emit({ type: 'busy', eventId: 1, busy: true });
    await app.waitForText('in a turn');
    await typeText(app, 'and also this');
    app.press(ENTER);
    const frame = await app.waitForText('and also this (queued)');
    expect(frame).toContain('(queued)');
    expect(socket().sentOf('message')).toHaveLength(1);
    socket().emit({ type: 'busy', eventId: 2, busy: false });
    const after = await app.settle();
    expect(after).not.toContain('(queued)');
  });
});

describe('a decision of the Producer', () => {
  const question: Extract<ChatServerMessage, { type: 'ask' }> = {
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

  it('shows the card, moves with the arrows and answers with Enter', async () => {
    const { app, online, socket } = await open();
    online.stores.decisions.setState({ byScenario: { [scenarioOf(online)]: [{ id: 'D1' }] } } as never);
    socket().emit(question);
    const frame = await app.waitForText('Which database?');
    expect(frame).toContain('sqlite');
    expect(frame).toContain('postgres');
    expect(frame).toContain('1 decision pending');
    app.press(DOWN);
    app.press(ENTER);
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the decision',
    );
    expect(socket().sentOf('answer')).toEqual([
      { type: 'answer', decisionId: 'D1', answer: { answers: ['postgres'] } },
    ]);
  });

  it('answers with a number key', async () => {
    const { app, socket } = await open();
    socket().emit(question);
    await app.waitForText('Which database?');
    app.press('1');
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the decision',
    );
    expect(socket().sentOf('answer')[0]?.answer).toEqual({ answers: ['sqlite'] });
  });

  it('marks several options with Space in a multiple choice', async () => {
    const { app, socket } = await open();
    socket().emit({
      ...question,
      input: {
        questions: [
          {
            question: 'Which checks?',
            options: [{ label: 'lint' }, { label: 'types' }, { label: 'tests' }],
            multi_select: true,
          },
        ],
      },
    });
    await app.waitForText('Which checks?');
    app.press(' ');
    app.press(DOWN);
    app.press(DOWN);
    app.press(' ');
    app.press(ENTER);
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the decision',
    );
    expect(socket().sentOf('answer')[0]?.answer).toEqual({ answers: ['lint, tests'] });
  });

  it('puts the card aside with Esc and opens it again with the decision key', async () => {
    const { app, socket } = await open();
    socket().emit(question);
    await app.waitForText('Which database?');
    app.press(ESC);
    const aside = await app.waitForText('1 decision is waiting');
    expect(aside).not.toContain('postgres');
    // Nothing was sent: Esc on a card is not a stop.
    expect(socket().sent).toEqual([]);
    app.press('\x0f');
    await app.waitForText('Which database?');
  });

  it('shows the answer in the conversation and drops the card when the daemon closes it', async () => {
    const { app, socket } = await open();
    socket().emit(question);
    await app.waitForText('Which database?');
    app.press('2');
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the decision',
    );
    socket().emit({ type: 'ask_closed', eventId: 2, decisionId: 'D1', state: 'decided' });
    const frame = await app.settle();
    expect(frame).not.toContain('Which database?');
    expect(frame).toContain('postgres');
  });

  it('answers the menu of a play with an option that needs no text', async () => {
    const { app, socket } = await open();
    socket().emit({
      type: 'ask',
      eventId: 1,
      decisionId: 'D2',
      kind: 'producer_menu',
      playId: 'P1',
      input: { options: ['raise_limit', 'cancel'], need: 'ship it' },
    });
    const frame = await app.waitForText('The play needs you');
    expect(frame).toContain('Raise the limit');
    expect(frame).toContain('Cancel the play');
    app.press('2');
    await waitFor(
      () => (socket().sentOf('answer').length > 0 ? true : undefined),
      'the answer to the menu',
    );
    expect(socket().sentOf('answer')[0]).toMatchObject({
      decisionId: 'D2',
      answer: { option: 'cancel' },
    });
  });
});

describe('the commands with a slash', () => {
  const commands = [
    command('status'),
    command('stop'),
    command('reset', { confirm: true, group: 'control' }),
  ];

  it('suggests the commands from GET /v1/commands as the Producer types', async () => {
    const { app } = await open(commands);
    await typeText(app, '/st');
    const frame = await app.waitForText('/status');
    expect(frame).toContain('/stop');
    expect(frame).not.toContain('/reset');
  });

  it('moves in the suggestions with Ctrl+N and completes the picked one with Enter', async () => {
    const { app, socket } = await open(commands);
    await typeText(app, '/st');
    await app.waitForText('/status');
    app.press(CTRL_N);
    await app.settle();
    app.press(ENTER);
    await app.settle();
    // Enter completes; the command is not sent until the next Enter.
    expect(socket().sentOf('command')).toEqual([]);
    expect(app.frame()).toContain('/stop');
    app.press(ENTER);
    await waitFor(
      () => (socket().sentOf('command').length > 0 ? true : undefined),
      'the command /stop',
    );
    expect(socket().sentOf('command')[0]?.text).toMatch(/^\/stop/u);
  });

  it('shows the answer of a command in the conversation', async () => {
    const { app, socket } = await open(commands);
    await typeText(app, '/status');
    app.press(ENTER);
    await waitFor(
      () => (socket().sentOf('command').length > 0 ? true : undefined),
      'the command /status',
    );
    socket().emit({
      type: 'command_result',
      eventId: null,
      result: { status: 'done', command: 'status', text: 'All quiet: 0 plays running.' },
    });
    await app.waitForText('All quiet: 0 plays running.');
  });

  it('asks to confirm a command that asks for it: Enter confirms', async () => {
    const { app, socket } = await open(commands);
    await typeText(app, '/reset');
    app.press(ENTER);
    await waitFor(
      () => (socket().sentOf('command').length > 0 ? true : undefined),
      'the command /reset',
    );
    socket().emit({
      type: 'command_result',
      eventId: null,
      result: { status: 'confirm', command: 'reset', text: 'This erases the queue.' },
    });
    await app.waitForText('Enter confirms, Esc cancels.');
    app.press(ENTER);
    await waitFor(
      () => (socket().sentOf('command').length > 1 ? true : undefined),
      'the confirmed command',
    );
    expect(socket().sentOf('command')[1]).toEqual({
      type: 'command',
      text: '/reset',
      confirm: true,
    });
  });

  it('asks to confirm a command that asks for it: Esc cancels', async () => {
    const { app, socket } = await open(commands);
    await typeText(app, '/reset');
    app.press(ENTER);
    await waitFor(
      () => (socket().sentOf('command').length > 0 ? true : undefined),
      'the command /reset',
    );
    socket().emit({
      type: 'command_result',
      eventId: null,
      result: { status: 'confirm', command: 'reset', text: 'This erases the queue.' },
    });
    await app.waitForText('Enter confirms, Esc cancels.');
    app.press(ESC);
    const frame = await app.settle();
    expect(frame).not.toContain('Enter confirms');
    expect(socket().sentOf('command')).toHaveLength(1);
  });
});

describe('a drop of the socket in the middle of a reply', () => {
  it('opens the next socket from the cursor and shows no text twice', async () => {
    const { app, online, socket } = await open();
    socket().emit(reply(1, 'First half, '));
    await app.waitForText('First half, ');
    const [id] = [...online.chat.sockets.keys()];
    // The real socket keeps its cursor across the drop and resends from the next event: the fake
    // plays the frames again from the first one, as a daemon that did not know the cursor would.
    socket().setState('retrying');
    await app.waitForText('reconnecting');
    socket().setState('open');
    socket().emit(reply(2, 'second half.'));
    const frame = await app.waitForText('First half, second half.');
    expect(count(frame, 'First half, ')).toBe(1);
    expect(id).toBeDefined();
  });
});
