// SPDX-License-Identifier: MPL-2.0
import { NormalizedUpdateSchema, typedErrorOf } from '@otheater/core';
import { AdapterUnavailable, PermissionDenied, QuotaExhausted, Transient } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { ACP_UPDATES } from './fixtures/updates.js';
import {
  normalizeOpenCodeError,
  normalizeOpenCodeUpdate,
  QUOTA_SIGNAL_METHOD,
} from './normalize.js';

const acp = (raw: unknown) => normalizeOpenCodeUpdate(raw, 'acp');

describe('normalizeOpenCodeUpdate', () => {
  it('turns message and thought chunks into chunks with the same content', () => {
    expect(acp(ACP_UPDATES.message)).toEqual({
      kind: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    });
    expect(acp(ACP_UPDATES.thought)).toEqual({
      kind: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking' },
    });
  });

  it('keeps the messageId, and drops one that is too long to be valid', () => {
    expect(acp({ ...ACP_UPDATES.message, messageId: 'm-1' })).toMatchObject({ messageId: 'm-1' });
    expect(acp({ ...ACP_UPDATES.message, messageId: 'x'.repeat(300) })).not.toHaveProperty(
      'messageId',
    );
  });

  it('converts image and resource link content, and swallows what it cannot read', () => {
    expect(
      acp({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      }),
    ).toMatchObject({ content: { type: 'image', mimeType: 'image/png' } });
    expect(
      acp({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'resource_link', uri: 'file:///a', name: 'a' },
      }),
    ).toMatchObject({ content: { type: 'resource_link', name: 'a' } });
    expect(acp({ sessionUpdate: 'agent_message_chunk', content: { type: 'audio' } })).toBeNull();
    expect(acp({ sessionUpdate: 'agent_message_chunk' })).toBeNull();
  });

  it('converts tool calls and their updates, with the tool kind and the status', () => {
    expect(acp(ACP_UPDATES.toolCall)).toEqual({
      kind: 'tool_call',
      toolCallId: 'call-1',
      title: 'bash: ls',
      toolKind: 'execute',
      status: 'in_progress',
    });
    expect(acp(ACP_UPDATES.toolCallDone)).toEqual({
      kind: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
    });
  });

  it('a tool kind the schema does not know becomes `other`, a missing status `pending`', () => {
    expect(
      acp({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 't', kind: 'teleport' }),
    ).toMatchObject({ toolKind: 'other', status: 'pending' });
    expect(acp({ sessionUpdate: 'tool_call', title: 'no id' })).toBeNull();
  });

  it('keeps the locations of a tool call that name a path', () => {
    expect(
      acp({
        ...ACP_UPDATES.toolCall,
        locations: [{ path: '/work/a.ts', line: 3 }, { line: 1 }, { path: '' }],
      }),
    ).toMatchObject({ locations: [{ path: '/work/a.ts', line: 3 }] });
  });

  it('converts the plan, fixing an entry the schema would refuse', () => {
    expect(acp(ACP_UPDATES.plan)).toEqual({
      kind: 'plan',
      entries: [
        { content: 'read the file', priority: 'high', status: 'completed' },
        { content: 'edit the file', priority: 'medium', status: 'in_progress' },
      ],
    });
    expect(
      acp({
        sessionUpdate: 'plan',
        entries: [{ content: 'x', priority: 'urgent', status: 'odd' }],
      }),
    ).toEqual({ kind: 'plan', entries: [{ content: 'x', priority: 'medium', status: 'pending' }] });
  });

  it('turns usage_update into usage: context window and cost in dollars', () => {
    expect(acp(ACP_UPDATES.usage)).toEqual({
      kind: 'usage',
      contextUsed: 1200,
      contextSize: 200000,
      costUsd: 0.0123,
    });
  });

  it('does not take a cost in another currency for dollars', () => {
    const update = acp({ ...ACP_UPDATES.usage, cost: { amount: 5, currency: 'BRL' } });
    expect(update).toEqual({ kind: 'usage', contextUsed: 1200, contextSize: 200000 });
  });

  it('a usage with no number at all is not a valid update and is swallowed', () => {
    expect(acp({ sessionUpdate: 'usage_update' })).toBeNull();
  });

  it('converts the command list', () => {
    expect(acp(ACP_UPDATES.commands)).toEqual({
      kind: 'available_commands',
      commands: [{ name: 'init', description: 'create AGENTS.md' }],
    });
  });

  it('turns a mode change and a config change into config_changed', () => {
    expect(acp(ACP_UPDATES.mode)).toEqual({
      kind: 'config_changed',
      options: [{ id: 'mode', category: 'mode', value: 'plan' }],
    });
    expect(
      acp({
        sessionUpdate: 'config_option_update',
        configOptions: [{ id: 'model', category: 'model', currentValue: 'a/b' }, { id: 'broken' }],
      }),
    ).toEqual({
      kind: 'config_changed',
      options: [{ id: 'model', category: 'model', value: 'a/b' }],
    });
  });

  it('swallows the replay of the user prompt and anything it does not know', () => {
    expect(acp(ACP_UPDATES.userEcho)).toBeNull();
    expect(acp({ sessionUpdate: 'session_info_update', title: 'x' })).toBeNull();
    expect(acp({})).toBeNull();
    expect(acp(null)).toBeNull();
    expect(acp('text')).toBeNull();
    expect(acp([1, 2])).toBeNull();
  });

  it('the headless stream was not measured: it is swallowed, any other transport is ACP', () => {
    expect(normalizeOpenCodeUpdate(ACP_UPDATES.message, 'headless')).toBeNull();
    expect(normalizeOpenCodeUpdate(ACP_UPDATES.message, 'fake')).not.toBeNull();
  });

  it('everything it returns passes the schema of the normalized updates', () => {
    for (const raw of Object.values(ACP_UPDATES)) {
      const update = acp(raw);
      if (update !== null) expect(NormalizedUpdateSchema.safeParse(update).success).toBe(true);
    }
  });

  describe('quota signals', () => {
    const signal = (inner: unknown) => ({ sessionUpdate: QUOTA_SIGNAL_METHOD, signal: inner });

    it('a window becomes rate_limit, rejected once it is full', () => {
      expect(
        acp(signal({ kind: 'window', window: '5h', usedPercent: 40, resetsAt: 1_800_000_000 })),
      ).toEqual({
        kind: 'rate_limit',
        status: 'allowed',
        window: '5h',
        usedPercent: 40,
        resetsAt: 1_800_000_000_000,
      });
      expect(acp(signal({ kind: 'window', window: '5h', usedPercent: 100 }))).toMatchObject({
        status: 'rejected',
      });
    });

    it('accepts the signal inside params, as a notification carries it', () => {
      expect(
        acp({ method: QUOTA_SIGNAL_METHOD, params: { signal: { kind: 'limit_hit' } } }),
      ).toEqual({ kind: 'rate_limit', status: 'rejected' });
    });

    it('a usage signal becomes usage', () => {
      expect(
        acp(
          signal({ kind: 'usage', model: 'a/b', inputTokens: 10, outputTokens: 5, costUsd: 0.5 }),
        ),
      ).toEqual({ kind: 'usage', model: 'a/b', inputTokens: 10, outputTokens: 5, costUsd: 0.5 });
    });

    it('a window without its numbers, or a kind it does not know, is swallowed', () => {
      expect(acp(signal({ kind: 'window', window: '5h' }))).toBeNull();
      expect(acp(signal({ kind: 'window', usedPercent: 3 }))).toBeNull();
      expect(acp(signal({ kind: 'mystery' }))).toBeNull();
      expect(acp({ method: QUOTA_SIGNAL_METHOD })).toBeNull();
    });
  });
});

describe('normalizeOpenCodeError', () => {
  it('maps the quota error of the shells (code and data type) to quota_exhausted', () => {
    const byCode = normalizeOpenCodeError({ code: -32001, message: 'out of quota' });
    expect(byCode).toMatchObject({ kind: 'quota_exhausted', message: 'out of quota' });
    expect(normalizeOpenCodeError({ message: 'x', data: { type: 'QuotaExhausted' } }).kind).toBe(
      'quota_exhausted',
    );
  });

  it('says where the limit came from: structured field, HTTP 429 or the message (P8)', () => {
    expect(normalizeOpenCodeError({ code: -32001, message: 'out' }).limitSource).toBe('structured');
    expect(
      normalizeOpenCodeError({ message: 'x', data: { type: 'QuotaExhausted' } }).limitSource,
    ).toBe('structured');
    expect(normalizeOpenCodeError(new Error('HTTP 429 Too Many Requests')).limitSource).toBe('429');
    expect(normalizeOpenCodeError(new Error('You exceeded your current quota')).limitSource).toBe(
      'message',
    );
    expect(normalizeOpenCodeError(new Error('network down')).limitSource).toBeUndefined();
  });

  it('takes resetsAt only from the field of the error, never from the text', () => {
    const iso = '2026-12-01T10:00:00.000Z';
    expect(
      normalizeOpenCodeError({ code: -32001, message: 'q', data: { resetsAt: iso } }),
    ).toMatchObject({ kind: 'quota_exhausted', resetsAt: Date.parse(iso) });
    expect(
      normalizeOpenCodeError({ message: 'rate limit, resets tomorrow at 9am' }),
    ).not.toHaveProperty('resetsAt');
  });

  it.each([
    'HTTP 429 Too Many Requests',
    'You exceeded your current quota',
    'rate limit reached',
    'insufficient credits',
  ])('recognises a quota failure by its words: %s', (message) => {
    expect(normalizeOpenCodeError(new Error(message)).kind).toBe('quota_exhausted');
  });

  it('maps a missing login to auth_required, by the ACP code and by words', () => {
    expect(normalizeOpenCodeError({ code: -32000, message: 'Authentication required' }).kind).toBe(
      'auth_required',
    );
    expect(normalizeOpenCodeError(new Error('401 Unauthorized')).kind).toBe('auth_required');
    expect(normalizeOpenCodeError(new Error('No API key configured')).kind).toBe('auth_required');
  });

  it('maps a permission refusal to permission', () => {
    expect(
      normalizeOpenCodeError(
        new Error('The user has specified a rule which prevents you from using this tool'),
      ),
    ).toMatchObject({ kind: 'permission' });
  });

  it('maps a killed process ("ACP connection closed", Phase 0) to client_crash', () => {
    expect(normalizeOpenCodeError(new Error('ACP connection closed')).kind).toBe('client_crash');
    expect(normalizeOpenCodeError(new Error('write EPIPE')).kind).toBe('client_crash');
  });

  it('maps a stall to stuck and a network or service failure to transient', () => {
    expect(normalizeOpenCodeError(new Error('the client is unresponsive')).kind).toBe('stuck');
    expect(normalizeOpenCodeError({ code: -32603, message: 'OpenCode service failure' }).kind).toBe(
      'transient',
    );
    expect(normalizeOpenCodeError(new Error('connect ETIMEDOUT')).kind).toBe('transient');
  });

  it('keeps anything else as unknown, with the message and the original error', () => {
    const raw = { code: 7, message: 'something odd' };
    expect(normalizeOpenCodeError(raw)).toEqual({
      kind: 'unknown',
      message: 'something odd',
      cause: raw,
    });
    expect(normalizeOpenCodeError(undefined).kind).toBe('unknown');
    expect(normalizeOpenCodeError('plain text failure').message).toBe('plain text failure');
  });

  it('reads the words of data when the message is bare', () => {
    expect(
      normalizeOpenCodeError({
        code: -32603,
        message: 'Internal error',
        data: { details: 'HTTP 429' },
      }).kind,
    ).toBe('quota_exhausted');
  });

  it('goes through the typed errors of the ports as the architecture says', () => {
    expect(typedErrorOf(normalizeOpenCodeError({ code: -32001, message: 'q' }))).toBeInstanceOf(
      QuotaExhausted,
    );
    expect(typedErrorOf(normalizeOpenCodeError({ code: -32000, message: 'a' }))).toBeInstanceOf(
      PermissionDenied,
    );
    expect(typedErrorOf(normalizeOpenCodeError(new Error('ACP connection closed')))).toBeInstanceOf(
      AdapterUnavailable,
    );
    expect(typedErrorOf(normalizeOpenCodeError(new Error('odd')))).toBeInstanceOf(Transient);
  });
});
