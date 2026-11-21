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
