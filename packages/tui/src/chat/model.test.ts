// SPDX-License-Identifier: MPL-2.0
import type { ChatServerMessage } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { createChatState, reduceChat, type ChatEvent, type ChatState } from './model.js';

function run(events: readonly ChatEvent[], from: ChatState = createChatState()): ChatState {
  return events.reduce(reduceChat, from);
}

const frame = (message: ChatServerMessage): ChatEvent => ({ type: 'frame', frame: message, at: 0 });

const part = (eventId: number, text: string, final = false, replyId = 1): ChatEvent =>
  frame({ type: 'director_reply', eventId, replyId, text, final });

const texts = (state: ChatState): string[] =>
  state.entries.flatMap((entry) => (entry.body.kind === 'text' ? [entry.body.text] : []));

describe('the reply of the Director', () => {
  it('joins the parts of one reply into one entry and marks it partial until the last', () => {
    const state = run([part(1, 'Hel'), part(2, 'lo ')]);
    expect(texts(state)).toEqual(['Hello ']);
    expect(state.entries[0]?.partial).toBe(true);
    const done = run([part(3, 'world', true)], state);
    expect(texts(done)).toEqual(['Hello world']);
    expect(done.entries[0]?.partial).toBe(false);
  });

  it('drops a part that comes again after a resume: no text is repeated', () => {
    const first = run([part(1, 'one '), part(2, 'two ')]);
    // The socket dropped and came back from an older cursor: the daemon sent 1 and 2 again.
    const again = run([part(1, 'one '), part(2, 'two '), part(3, 'three', true)], first);
    expect(texts(again)).toEqual(['one two three']);
  });

  it('does not lose a part that was missed: the next one adds to the entry', () => {
    const state = run([part(1, 'a'), part(2, 'b'), part(3, 'c', true)]);
    expect(texts(state)).toEqual(['abc']);
  });

  it('keeps two turns apart by their replyId', () => {
    const state = run([part(1, 'first', true, 1), part(2, 'second', true, 2)]);
    expect(texts(state)).toEqual(['first', 'second']);
  });

  it('shows a generated reply with its tools and the play it opened', () => {
    const state = run([
      frame({
        type: 'director_reply',
        eventId: 1,
        replyId: 1,
        text: '',
        final: true,
        generated: true,
        tools: [{ name: 'open_play', status: 'completed' }],
        playId: 'P1',
      }),
    ]);
    expect(state.entries[0]?.body).toMatchObject({ kind: 'generated', playId: 'P1' });
  });

  it('takes the queued mark off a message once the Director answers', () => {
    const state = run([{ type: 'sent', text: 'do it', at: 0, queued: true }, part(1, 'ok', true)]);
    expect(state.entries[0]?.queued).toBe(false);
  });
});

describe('the decisions', () => {
  const ask = (decisionId: string, eventId = 1): ChatEvent =>
    frame({
      type: 'ask',
      eventId,
      decisionId,
      kind: 'producer_question',
      playId: null,
      input: {},
    });

  it('keeps one ask per decision, even when the daemon says it again', () => {
    const state = run([ask('D1'), ask('D1', 2), ask('D2', 3)]);
    expect(state.asks.map((item) => item.decisionId)).toEqual(['D1', 'D2']);
  });

  it('takes an ask back when it is closed and does not bring it back when it comes late', () => {
    const closed = run([
      ask('D1'),
      frame({ type: 'ask_closed', eventId: 2, decisionId: 'D1', state: 'decided' }),
    ]);
    expect(closed.asks).toEqual([]);
    expect(run([ask('D1', 3)], closed).asks).toEqual([]);
  });

  it('knows which answer is on its way and clears it when the daemon closes the ask', () => {
    const sent = run([ask('D1'), { type: 'answerSent', decisionId: 'D1' }]);
    expect(sent.answering).toBe('D1');
    const closed = run(
      [frame({ type: 'ask_closed', eventId: 2, decisionId: 'D1', state: 'decided' })],
      sent,
    );
    expect(closed.answering).toBeUndefined();
  });

  it('lets the Producer answer again when the daemon refused the answer', () => {
    const sent = run([ask('D1'), { type: 'answerSent', decisionId: 'D1' }]);
    const refused = run(
      [frame({ type: 'error', eventId: null, error: { code: 'invalid_input', message: 'no' } })],
      sent,
    );
    expect(refused.answering).toBeUndefined();
    expect(refused.asks).toHaveLength(1);
  });
});

describe('the events of the log', () => {
  it('applies a system or a play frame once', () => {
    const play = frame({ type: 'play_state', eventId: 4, playId: 'P1', state: 'EXECUTING' });
    const state = run([play, play]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.body).toEqual({ kind: 'play', playId: 'P1', state: 'EXECUTING' });
    // An older event that arrives later is a repeat too.
    const older = frame({ type: 'play_state', eventId: 3, playId: 'P1', state: 'PLANNING' });
    expect(run([older], state).entries).toHaveLength(1);
  });
});

describe('the state of the Director and the commands', () => {
  it('follows busy and the waits', () => {
    const state = run([
      frame({ type: 'busy', eventId: 1, busy: true }),
      frame({ type: 'waits', eventId: 1, waits: [] }),
    ]);
    expect(state.busy).toBe(true);
    expect(run([frame({ type: 'busy', eventId: 2, busy: false })], state).busy).toBe(false);
  });

  it('asks to confirm a command that wants it, with the line to send again', () => {
    const state = run([
      { type: 'commandSent', text: '/reset' },
      frame({
        type: 'command_result',
        eventId: null,
        result: { status: 'confirm', command: 'reset', text: 'Sure?' },
      }),
    ]);
    expect(state.confirm).toEqual({ text: '/reset', command: 'reset', prompt: 'Sure?' });
    expect(run([{ type: 'confirmDone' }], state).confirm).toBeUndefined();
  });

  it('shows the answer of a command in the conversation', () => {
    const state = run([
      frame({
        type: 'command_result',
        eventId: null,
        result: { status: 'done', command: 'status', text: 'all fine' },
      }),
    ]);
    expect(state.entries[0]?.body).toMatchObject({ kind: 'command' });
    expect(state.confirm).toBeUndefined();
  });
});

describe('the connection', () => {
  it('says so when the socket drops and when it comes back, but not on the first opening', () => {
    const open = run([{ type: 'connection', state: 'open', at: 0 }]);
    expect(open.entries).toEqual([]);
    const dropped = run([{ type: 'connection', state: 'retrying', at: 1 }], open);
    expect(dropped.entries[0]?.body).toMatchObject({ kind: 'local', key: 'connectionLost' });
    const back = run([{ type: 'connection', state: 'open', at: 2 }], dropped);
    expect(back.entries[1]?.body).toMatchObject({ kind: 'local', key: 'reconnected' });
  });

  it('treats leaving the scenario as no drop: the next opening is a first one', () => {
    const state = run([
      { type: 'connection', state: 'open', at: 0 },
      { type: 'connection', state: 'closed', at: 1 },
      { type: 'connection', state: 'open', at: 2 },
    ]);
    expect(state.entries).toEqual([]);
  });
});

describe('the size', () => {
  it('keeps the newest 5,000 entries', () => {
    let state = createChatState();
    for (let index = 0; index < 5005; index += 1) {
      state = reduceChat(state, { type: 'sent', text: `m${String(index)}`, at: 0, queued: false });
    }
    expect(state.entries).toHaveLength(5000);
    expect(state.entries[0]?.body).toMatchObject({ text: 'm5' });
  });
});

describe('a ! command (P18)', () => {
  const started = (eventId: number, commandId = 'sh_1', command = 'ls'): ChatEvent =>
    frame({
      type: 'shell_started',
      eventId,
      command: { commandId, command, place: 'host' },
    });
  const finished = (
    eventId: number,
    snippet = 'a\nb',
    result: Partial<Extract<ChatServerMessage, { type: 'shell_finished' }>['result']> = {},
    commandId = 'sh_1',
  ): ChatEvent =>
    frame({
      type: 'shell_finished',
      eventId,
      snippet,
      result: {
        commandId,
        outcome: 'exited',
        exitCode: 0,
        durationMs: 40,
        totalLines: 2,
        shownLines: 2,
        keep: 'tail',
        logTruncated: false,
        attachmentId: 'A1',
        askedInput: false,
        context: 'sent',
        logPath: null,
        ...result,
      },
    });
  const shellAsk = (eventId: number, labels = ['Send', 'Keep']): ChatEvent =>
    frame({
      type: 'ask',
      eventId,
      decisionId: `D${String(eventId)}`,
      kind: 'producer_question',
      playId: null,
      input: {
        questions: [{ question: 'Send it?', options: labels.map((label) => ({ label })) }],
      },
    });

  it('has no entry for the line typed, and one block that starts as running and ends with the output', () => {
    const sent = run([{ type: 'sent', text: '!ls', at: 1, queued: false, shell: true }]);
    expect(sent.entries).toEqual([]);
    expect(sent.shellSending).toBe(1);
    const running = run([started(1)], sent);
    expect(running.shellSending).toBe(0);
    expect(running.shells).toMatchObject([{ commandId: 'sh_1', command: 'ls' }]);
    expect(running.entries).toHaveLength(1);
    expect(running.entries[0]?.body.kind).toBe('shellStarted');
    const done = run([finished(2)], running);
    // The same entry, now with the output: the block does not grow a second line.
    expect(done.entries).toHaveLength(1);
    expect(done.entries[0]?.id).toBe(running.entries[0]?.id);
    expect(done.entries[0]?.body).toMatchObject({
      kind: 'shellFinished',
      command: 'ls',
      snippet: 'a\nb',
    });
    expect(done.shells).toEqual([]);
  });

  it('keeps two commands apart and finishes the one whose id ends', () => {
    const state = run([started(1, 'sh_1', 'sleep 5'), started(2, 'sh_2', 'ls')]);
    expect(state.shells.map((shell) => shell.command)).toEqual(['sleep 5', 'ls']);
    const after = run([finished(3, 'x', {}, 'sh_2')], state);
    expect(after.shells.map((shell) => shell.commandId)).toEqual(['sh_1']);
    expect(after.entries.map((entry) => entry.body.kind)).toEqual([
      'shellStarted',
      'shellFinished',
    ]);
  });

  it('draws an end whose start was not seen (a resume past it) as a block of its own', () => {
    const state = run([finished(5)]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.body).toMatchObject({ kind: 'shellFinished', command: '' });
  });

  it('does not repeat a start or an end that comes again after a resume', () => {
    const once = run([started(1), finished(2)]);
    const again = run([started(1), finished(2), started(3, 'sh_2')], once);
    expect(again.entries.map((entry) => entry.body.kind)).toEqual([
      'shellFinished',
      'shellStarted',
    ]);
    expect(again.shells.map((shell) => shell.commandId)).toEqual(['sh_2']);
  });

  it('attaches the command to the question of context: ask, and only to that question', () => {
    const asked = run([
      started(1),
      finished(2, 'a\nb', { context: 'asked', exitCode: 3 }),
      shellAsk(3),
    ]);
    expect(asked.asks).toHaveLength(1);
    expect(asked.asks[0]?.shell).toEqual({ command: 'ls', exitCode: 3, lines: 2 });
    expect(asked.shellAsks).toEqual([]);
    // A question of the Director with other options, with no command waiting, is not it.
    const other = run([shellAsk(4, ['sqlite', 'postgres'])], asked);
    expect(other.asks[1]?.shell).toBeUndefined();
    // Nor is a Send/Keep question that no command announced.
    const alone = run([shellAsk(1)]);
    expect(alone.asks[0]?.shell).toBeUndefined();
  });

  it('pairs two questions with their commands in the order they were announced', () => {
    const state = run([
      started(1, 'sh_1', 'first'),
      finished(2, '', { context: 'asked' }, 'sh_1'),
      started(3, 'sh_2', 'second'),
      finished(4, '', { context: 'asked' }, 'sh_2'),
      shellAsk(5),
      shellAsk(6),
    ]);
    expect(state.asks.map((ask) => ask.shell?.command)).toEqual(['first', 'second']);
  });

  it('turns the refusal of the daemon into an entry of its own, once per line sent', () => {
    const refused: ChatEvent = frame({
      type: 'error',
      eventId: null,
      error: { code: 'forbidden', message: 'The ! command is off (chat.shell_command: off)' },
    });
    const sent = run([{ type: 'sent', text: '!ls', at: 1, queued: false, shell: true }]);
    const state = run([refused], sent);
    expect(state.entries.map((entry) => entry.body.kind)).toEqual(['shellRefused']);
    expect(state.shellSending).toBe(0);
    // The same error with no `!` line in flight is an ordinary error.
    const plain = run([refused]);
    expect(plain.entries.map((entry) => entry.body.kind)).toEqual(['error']);
  });

  it('forgets the lines in flight when the socket falls: their answer may never come', () => {
    const sent = run([{ type: 'sent', text: '!ls', at: 1, queued: false, shell: true }]);
    expect(sent.shellSending).toBe(1);
    expect(run([{ type: 'connection', state: 'retrying', at: 0 }], sent).shellSending).toBe(0);
  });
});
