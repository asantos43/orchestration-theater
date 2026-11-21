// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { FakeChatServer } from './fake-socket.test-support.js';
import { ChatSession, type ChatQueueMode } from './session.js';

function sessionOver(server: FakeChatServer, queue: ChatQueueMode = 'daemon'): ChatSession {
  let clock = 0;
  return new ChatSession({
    open: (resumeFrom) => server.open('S1', resumeFrom === undefined ? {} : { resumeFrom }),
    now: () => (clock += 1),
    queue,
  });
}

const reply = (eventId: number, text: string, final = false) =>
  ({ type: 'director_reply', eventId, replyId: 1, text, final }) as const;

const texts = (session: ChatSession): string[] =>
  session.state.entries.flatMap((entry) => (entry.body.kind === 'text' ? [entry.body.text] : []));

describe('a message and the commands', () => {
  it('sends text as a message and a line with a slash as a command', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server);
    session.connect();
    session.submit('build the thing');
    session.submit('/status');
    const socket = server.latest('S1');
    expect(socket?.sent).toEqual([
      { type: 'message', text: 'build the thing' },
      { type: 'command', text: '/status' },
    ]);
  });

  it('sends attachments with the message, and a line with a slash and attachments stays a message', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server);
    session.connect();
    session.submit('/etc/hosts is odd', ['A1']);
    expect(server.latest('S1')?.sent).toEqual([
      { type: 'message', text: '/etc/hosts is odd', attachments: ['A1'] },
    ]);
  });

  it('throws when the socket is not there, so the text box keeps what was typed', () => {
    const session = sessionOver(new FakeChatServer());
    expect(() => {
      session.submit('hello');
    }).toThrow();
  });

  it('resends a command with confirm: true after the Producer confirms', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server);
    session.connect();
    const socket = server.latest('S1');
    session.submit('/reset');
    socket?.emit({
      type: 'command_result',
      eventId: null,
      result: { status: 'confirm', command: 'reset', text: 'Sure?' },
    });
    expect(session.state.confirm?.text).toBe('/reset');
    session.sendCommand(session.state.confirm?.text ?? '', true);
    expect(socket?.sentOf('command').at(-1)).toEqual({
      type: 'command',
      text: '/reset',
      confirm: true,
    });
    expect(session.state.confirm).toBeUndefined();
  });

  it('stops the reply with /stop', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server);
    session.connect();
    session.stop();
    expect(server.latest('S1')?.sent).toEqual([{ type: 'command', text: '/stop' }]);
  });
});

describe('the queue while the Director is in a turn', () => {
  it('sends at once in `daemon` mode and marks the message as waiting', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server, 'daemon');
    session.connect();
    const socket = server.latest('S1');
    socket?.emit({ type: 'busy', eventId: 1, busy: true });
    session.submit('and this');
    expect(socket?.sentOf('message')).toHaveLength(1);
    expect(session.state.entries.at(-1)?.queued).toBe(true);
    socket?.emit({ type: 'busy', eventId: 2, busy: false });
    expect(session.state.entries.at(-1)?.queued).toBe(false);
  });

  it('keeps the message in `hold` mode and sends it when the Director is free', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server, 'hold');
    session.connect();
    const socket = server.latest('S1');
    socket?.emit({ type: 'busy', eventId: 1, busy: true });
    session.submit('first');
    session.submit('second');
    expect(socket?.sent).toEqual([]);
    expect(session.state.entries.every((entry) => entry.queued === true)).toBe(true);
    socket?.emit({ type: 'busy', eventId: 2, busy: false });
    expect(socket?.sent).toEqual([
      { type: 'message', text: 'first' },
      { type: 'message', text: 'second' },
    ]);
    expect(session.state.entries.every((entry) => entry.queued === false)).toBe(true);
  });

  it('keeps a held message when the socket is not open at the release', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server, 'hold');
    session.connect();
    const socket = server.latest('S1');
    socket?.emit({ type: 'busy', eventId: 1, busy: true });
    session.submit('later');
    if (socket !== undefined) socket.failSend = new Error('not open');
    socket?.emit({ type: 'busy', eventId: 2, busy: false });
    expect(socket?.sent).toEqual([]);
    expect(session.state.entries[0]?.queued).toBe(true);
    if (socket !== undefined) socket.failSend = undefined;
    socket?.emit({ type: 'busy', eventId: 3, busy: true });
    socket?.emit({ type: 'busy', eventId: 4, busy: false });
    expect(socket?.sent).toEqual([{ type: 'message', text: 'later' }]);
  });
});

describe('a decision', () => {
  it('sends the answer and shows what the Producer chose', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server);
    session.connect();
    const socket = server.latest('S1');
    socket?.emit({
      type: 'ask',
      eventId: 1,
      decisionId: 'D1',
      kind: 'producer_question',
      playId: null,
      input: {},
    });
    session.answer('D1', { answers: ['blue'] }, 'blue');
    expect(socket?.sentOf('answer')).toEqual([
      { type: 'answer', decisionId: 'D1', answer: { answers: ['blue'] } },
    ]);
    expect(session.state.answering).toBe('D1');
    expect(texts(session)).toContain('blue');
  });
});

describe('leaving a scenario and a socket that drops', () => {
  it('resumes from the cursor on the next socket and applies what arrives once', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server);
    session.connect();
    const first = server.latest('S1');
    first?.emit(reply(1, 'Hel'));
    first?.emit(reply(2, 'lo '));
    // The Producer goes to another scenario and comes back.
    session.disconnect();
    expect(first?.closed).toBe(true);
    session.connect();
    const second = server.latest('S1');
    expect(second).not.toBe(first);
    expect(second?.resumeFrom).toBe(2);
    // The daemon sends the part 2 again (an older cursor on its side) and then the rest.
    second?.emit(reply(2, 'lo '));
    second?.emit(reply(3, 'world', true));
    expect(texts(session)).toEqual(['Hello world']);
  });

  it('does not duplicate a reply when the same socket drops and comes back', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server);
    session.connect();
    const socket = server.latest('S1');
    socket?.setState('open');
    socket?.emit(reply(1, 'one '));
    socket?.setState('retrying');
    socket?.setState('open');
    // The real socket sends `resume` by itself and the daemon replays what is past the cursor.
    socket?.emit(reply(1, 'one '));
    socket?.emit(reply(2, 'two', true));
    expect(texts(session)).toEqual(['one two']);
    const local = session.state.entries.flatMap((entry) =>
      entry.body.kind === 'local' ? [entry.body.key] : [],
    );
    expect(local).toEqual(['connectionLost', 'reconnected']);
  });

  it('is a first opening again after dispose', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server);
    session.connect();
    session.dispose();
    expect(server.latest('S1')?.closed).toBe(true);
  });
});

describe('the listeners', () => {
  it('tells the view on every change and stops after unsubscribe', () => {
    const server = new FakeChatServer();
    const session = sessionOver(server);
    let calls = 0;
    const stop = session.subscribe(() => {
      calls += 1;
    });
    session.connect();
    server.latest('S1')?.emit(reply(1, 'x', true));
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    stop();
    server.latest('S1')?.emit(reply(2, 'y', true));
    expect(calls).toBe(before);
  });
});
