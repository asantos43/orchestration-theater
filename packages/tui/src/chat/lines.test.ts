// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { clockOf, messageOf, messagesOf, waitReason, type Translate } from './lines.js';
import type { ChatEntry } from './model.js';
import type { ShellCommandFinishedPayload } from '@otheater/protocol';

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

describe('a ! command (P18)', () => {
  const result = (
    extra: Partial<ShellCommandFinishedPayload> = {},
  ): ShellCommandFinishedPayload => ({
    commandId: 'sh_1',
    outcome: 'exited',
    exitCode: 0,
    durationMs: 1400,
    totalLines: 2,
    shownLines: 2,
    keep: 'tail',
    logTruncated: false,
    attachmentId: 'A1',
    askedInput: false,
    context: 'sent',
    logPath: null,
    ...extra,
  });
  const finished = (
    extra: Partial<ShellCommandFinishedPayload> = {},
    snippet = 'a\n  b\n',
  ): ChatEntry =>
    entry(
      { kind: 'shellFinished', result: result(extra), snippet, command: 'ls -la' },
      { who: 'system' },
    );

  it('draws the command in progress as a block with its place and no output', () => {
    const message = messageOf(
      t,
      entry(
        { kind: 'shellStarted', command: { commandId: 'sh_1', command: 'sleep 3', place: 'host' } },
        { who: 'system' },
      ),
    );
    expect(message.terminal).toEqual({
      header: '! sleep 3',
      output: [],
      notes: [{ text: '[layout.chat.entry.shellStarted place=host]', tone: 'dim' }],
    });
  });

  it('draws the end as the command, the output with its indentation and how it ended', () => {
    const message = messageOf(t, finished());
    expect(message.terminal).toEqual({
      header: '! ls -la',
      output: ['a', '  b'],
      notes: [
        { text: '[layout.chat.entry.shell.exited code=0,seconds=1,error=]', tone: 'ok' },
        { text: '[layout.chat.entry.shellContext.sent]', tone: 'dim' },
      ],
    });
    // The same things as plain text, for what does not draw a block.
    expect(message.text.split('\n')).toEqual([
      '! ls -la',
      'a',
      '  b',
      '[layout.chat.entry.shell.exited code=0,seconds=1,error=]',
      '[layout.chat.entry.shellContext.sent]',
    ]);
  });

  it('says what was left out, from which end', () => {
    const notes = messageOf(t, finished({ totalLines: 50, shownLines: 2, keep: 'head' })).terminal
      ?.notes;
    expect(notes?.[0]).toEqual({
      text: '[layout.chat.entry.shellCut.head shown=2,total=50]',
      tone: 'dim',
    });
  });

  it('warns when the command asked for input', () => {
    const notes = messageOf(t, finished({ askedInput: true, exitCode: 1 })).terminal?.notes ?? [];
    expect(notes.map((note) => [note.text, note.tone])).toContainEqual([
      '[layout.chat.entry.shellAskedInput]',
      'warn',
    ]);
  });

  it('tells a non-zero code and a timeout (warn) from a command that did not start (error)', () => {
    const tone = (extra: Partial<ShellCommandFinishedPayload>): string | undefined =>
      messageOf(t, finished(extra)).terminal?.notes.find((note) =>
        note.text.includes('entry.shell.'),
      )?.tone;
    expect(tone({ exitCode: 2 })).toBe('warn');
    expect(tone({ outcome: 'timeout', exitCode: null })).toBe('warn');
    expect(tone({ outcome: 'failed', exitCode: null, error: 'no launcher' })).toBe('error');
  });

  it('says what became of the output with the Director, and nothing when there was none', () => {
    const contexts = (context: ShellCommandFinishedPayload['context']): string[] =>
      (messageOf(t, finished({ context })).terminal?.notes ?? []).map((note) => note.text);
    expect(contexts('asked')).toContain('[layout.chat.entry.shellContext.asked]');
    expect(contexts('never')).toContain('[layout.chat.entry.shellContext.never]');
    expect(contexts('none').join('')).not.toContain('shellContext');
  });

  it('shortens a long command to one line and draws a bare ! when the start was not seen', () => {
    const long = messageOf(
      t,
      entry(
        {
          kind: 'shellStarted',
          command: { commandId: 'sh_1', command: `echo ${'x'.repeat(200)}\nmore`, place: 'host' },
        },
        { who: 'system' },
      ),
    );
    expect(long.terminal?.header.length).toBeLessThanOrEqual(62);
    expect(long.terminal?.header).toMatch(/…$/u);
    const unknown = messageOf(
      t,
      entry({ kind: 'shellFinished', result: result(), snippet: '', command: '' }),
    );
    expect(unknown.terminal?.header).toBe('!');
  });

  it('names the default Executor of the role, not ?, when the Director goes back to the default (N330)', () => {
    const text = messageOf(
      t,
      entry(
        {
          kind: 'system',
          notice: {
            kind: 'director_switch',
            scenarioId: 'S1',
            form: 'stored',
            fromExecutor: null,
            toExecutor: null,
            model: null,
            effort: null,
            override: false,
            waited: false,
          },
        },
        { who: 'system' },
      ),
    ).text;
    expect(text).toContain('what=[layout.chat.entry.directorSwitch.defaultExecutor]');
    expect(text).not.toContain('what=?');
  });

  it('says why the Director is unavailable, when the daemon tells (N331)', () => {
    const text = (detail: string | null): string =>
      messageOf(
        t,
        entry(
          {
            kind: 'system',
            notice: {
              kind: 'director_failover',
              scenarioId: 'S1',
              outcome: 'unavailable',
              cause: 'client_crash',
              fromExecutor: null,
              toExecutor: null,
              requeued: null,
              resetsAt: null,
              detail,
            },
          },
          { who: 'system' },
        ),
      ).text;
    expect(text('no Executor left')).toContain(
      '[layout.chat.entry.failover.detail detail=no Executor left]',
    );
    expect(text(null)).not.toContain('failover.detail');
  });

  it('says the cause in words, and what to do about a refusal of the policy (N334)', () => {
    const text = (cause: 'permission' | 'client_crash'): string =>
      messageOf(
        t,
        entry(
          {
            kind: 'system',
            notice: {
              kind: 'director_failover',
              scenarioId: 'S1',
              outcome: 'unavailable',
              cause,
              fromExecutor: null,
              toExecutor: null,
              requeued: null,
              resetsAt: null,
              detail: 'short of layers',
            },
          },
          { who: 'system' },
        ),
      ).text;
    expect(text('permission')).toContain('cause=[layout.chat.entry.failover.cause.permission]');
    expect(text('permission')).toContain('[layout.chat.entry.failover.permissionHint]');
    expect(text('client_crash')).toContain('cause=[layout.chat.entry.failover.cause.client_crash]');
    expect(text('client_crash')).not.toContain('permissionHint');
  });

  it('shows a refusal by its code, with the message of the daemon as the fallback', () => {
    const text = (code: 'forbidden' | 'internal'): string =>
      messageOf(
        t,
        entry(
          {
            kind: 'shellRefused',
            error: { code, message: 'nope' },
            command: '',
            clientId: undefined,
          },
          { who: 'system' },
        ),
      ).text;
    expect(text('forbidden')).toContain('layout.chat.entry.shellRefused.forbidden');
    expect(
      messageOf(
        t,
        entry({
          kind: 'shellRefused',
          error: { code: 'forbidden', message: 'x' },
          command: '',
          clientId: undefined,
        }),
      ).terminal,
    ).toBeUndefined();
    // With the line it is for, the refusal says which one (several may be in flight).
    const named = messageOf(
      t,
      entry({
        kind: 'shellRefused',
        error: { code: 'forbidden', message: 'x' },
        command: 'ls -la',
        clientId: 'sh-1',
      }),
    ).text;
    expect(named).toContain('layout.chat.entry.shellRefusedFor');
    expect(named).toContain('ls -la');
  });
});
