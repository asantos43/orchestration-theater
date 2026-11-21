// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { clockOf, messageOf, messagesOf, waitReason, type Translate } from './lines.js';
import type { ChatEntry } from './model.js';

/** A catalog that shows the key and the values it was given. */
const t: Translate = (key, options) => {
  const shown = Object.entries(options ?? {})
    .filter(([name]) => name !== 'defaultValue')
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(',');
  return `[${key}${shown === '' ? '' : ` ${shown}`}]`;
};

const at = new Date(2026, 10, 21, 9, 5).getTime();

const entry = (body: ChatEntry['body'], extra: Partial<ChatEntry> = {}): ChatEntry => ({
  id: 'e1',
  who: 'director',
  at,
  body,
  ...extra,
});

describe('the clock', () => {
  it('writes HH:MM with two digits', () => {
    expect(clockOf(at)).toBe('09:05');
  });
});

describe('messageOf', () => {
  it('shows a text as it is and marks a queued one and a partial one', () => {
    expect(messageOf(t, entry({ kind: 'text', text: 'hi' }))).toEqual({
      id: 'e1',
      who: 'director',
      at: '09:05',
      text: 'hi',
    });
    expect(messageOf(t, entry({ kind: 'text', text: 'hi' }, { queued: true })).text).toBe(
      'hi [layout.chat.entry.queued]',
    );
    expect(messageOf(t, entry({ kind: 'text', text: 'hi' }, { partial: true })).text).toBe('hi …');
  });

  it('shows the answer of a command as the daemon wrote it', () => {
    const text = messageOf(
      t,
      entry({ kind: 'command', result: { status: 'done', command: 'status', text: 'Fine.' } }),
    ).text;
    expect(text).toBe('Fine.');
  });

  it('puts the texts of the TUI under layout.chat.entry', () => {
    expect(messageOf(t, entry({ kind: 'play', playId: 'P1', state: 'EXECUTING' })).text).toBe(
      '[layout.chat.entry.play id=P1,state=EXECUTING]',
    );
    expect(messageOf(t, entry({ kind: 'local', key: 'reconnected', params: {} })).text).toBe(
      '[layout.chat.entry.local.reconnected]',
    );
    expect(
      messageOf(t, entry({ kind: 'error', error: { code: 'not_found', message: 'gone' } })).text,
    ).toBe('[layout.chat.entry.error message=gone]');
  });

  it('says when a turn generated nothing and when it opened a play', () => {
    expect(messageOf(t, entry({ kind: 'generated', tools: [], playId: undefined })).text).toBe(
      '[layout.chat.entry.generatedNone]',
    );
    const text = messageOf(
      t,
      entry({
        kind: 'generated',
        tools: [
          { name: 'open_play', status: 'completed' },
          { name: 'consult', status: 'failed' },
        ],
        playId: 'P1',
      }),
    ).text;
    expect(text).toContain('open_play');
    expect(text).toContain('layout.chat.entry.toolFailed');
    expect(text).toContain('layout.chat.entry.generatedPlay id=P1');
  });

  it('lists every entry in order', () => {
    const list = messagesOf(t, [
      entry({ kind: 'text', text: 'a' }, { id: 'e1' }),
      entry({ kind: 'text', text: 'b' }, { id: 'e2' }),
    ]);
    expect(list.map((message) => message.text)).toEqual(['a', 'b']);
  });
});

describe('waitReason', () => {
  it('names each reason once', () => {
    const text = waitReason(t, {
      on: [
        { profile: 'one', reason: 'quota' },
        { profile: 'two', reason: 'quota' },
      ],
    });
    expect(text.match(/waitReason\.quota/g)).toHaveLength(1);
  });
});
