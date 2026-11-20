// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { API_REJECTION_REASONS } from './api-events.js';
import {
  ApiChatClosedPayloadSchema,
  ApiChatMessageDroppedPayloadSchema,
  CHAT_DROP_REASONS,
  CHAT_CLOSE_REASONS,
  ChatAskClosedPayloadSchema,
  ChatAskPayloadSchema,
  ChatDirectorReplyPayloadSchema,
  ChatDirectorSilentPayloadSchema,
  PromptQueuedPayloadSchema,
} from './chat-events.js';
import { buildDaemonEvent } from './events.js';

describe('the events of the chat WebSocket (P7 of docs/17)', () => {
  it('prompt.queued carries who, which priority and which item, never the text', () => {
    const payload = { promptId: 'p1', source: 'producer', priority: 100 };
    expect(PromptQueuedPayloadSchema.parse(payload)).toEqual(payload);
    expect(PromptQueuedPayloadSchema.safeParse({ ...payload, text: 'hi' }).success).toBe(false);
    expect(PromptQueuedPayloadSchema.safeParse({ ...payload, source: 'robot' }).success).toBe(
      false,
    );
  });

  it('chat.director_reply and chat.ask are strict', () => {
    const reply = { replyId: 1, to: 'producer', text: 'ok' };
    expect(ChatDirectorReplyPayloadSchema.parse(reply)).toEqual(reply);
    expect(ChatDirectorReplyPayloadSchema.safeParse({ ...reply, replyId: 0 }).success).toBe(false);
    const ask = { decisionId: 'd1', kind: 'producer_question', input: { questions: [] } };
    expect(ChatAskPayloadSchema.parse(ask)).toEqual(ask);
    expect(ChatAskPayloadSchema.safeParse({ ...ask, extra: 1 }).success).toBe(false);
  });

  it('chat.director_reply marks a generated reply, and a reply of the Director stays valid without the marks (N183)', () => {
    const generated = {
      replyId: 2,
      to: 'producer',
      text: 'The Director ended the turn without a reply.',
      generated: true,
      tools: [{ name: 'open_play', status: 'completed' }],
      playId: 'play-1',
    };
    expect(ChatDirectorReplyPayloadSchema.parse(generated)).toEqual(generated);
    expect(
      ChatDirectorReplyPayloadSchema.safeParse({ ...generated, generated: false }).success,
    ).toBe(false);
    expect(
      ChatDirectorReplyPayloadSchema.safeParse({
        ...generated,
        tools: [{ name: '', status: null }],
      }).success,
    ).toBe(false);
  });

  it('chat.director_silent carries the tools, the play and the mode, and is strict (N183)', () => {
    const silent = {
      tools: [{ name: 'open_play', status: null }],
      playId: null,
      mode: 'none' as const,
    };
    expect(ChatDirectorSilentPayloadSchema.parse(silent)).toEqual(silent);
    expect(ChatDirectorSilentPayloadSchema.safeParse({ ...silent, mode: 'loud' }).success).toBe(
      false,
    );
    expect(ChatDirectorSilentPayloadSchema.safeParse({ ...silent, extra: 1 }).success).toBe(false);
    expect(buildDaemonEvent('chat.director_silent', silent).type).toBe('chat.director_silent');
  });

  it('chat.ask_closed names the decision and how it ended, and is strict (N179)', () => {
    const closed = { decisionId: 'd1', kind: 'producer_question', state: 'decided' as const };
    expect(ChatAskClosedPayloadSchema.parse(closed)).toEqual(closed);
    expect(ChatAskClosedPayloadSchema.parse({ ...closed, state: 'cancelled' }).state).toBe(
      'cancelled',
    );
    // Still pending is not a way for a question to close, and the answer stays out of the event.
    expect(ChatAskClosedPayloadSchema.safeParse({ ...closed, state: 'pending' }).success).toBe(
      false,
    );
    expect(ChatAskClosedPayloadSchema.safeParse({ ...closed, answer: {} }).success).toBe(false);
    expect(buildDaemonEvent('chat.ask_closed', closed).type).toBe('chat.ask_closed');
  });

  it('api.chat_message_dropped takes a reason and the event when known', () => {
    expect(
      ApiChatMessageDroppedPayloadSchema.parse({
        reason: 'unfit',
        eventId: 42,
        eventType: 'chat.ask',
      }),
    ).toEqual({ reason: 'unfit', eventId: 42, eventType: 'chat.ask' });
    expect(
      ApiChatMessageDroppedPayloadSchema.parse({
        reason: 'prepare_failed',
        eventId: null,
        eventType: null,
      }).eventId,
    ).toBeNull();
    expect(
      ApiChatMessageDroppedPayloadSchema.safeParse({
        reason: 'lost',
        eventId: null,
        eventType: null,
      }).success,
    ).toBe(false);
    expect(CHAT_DROP_REASONS).toEqual(['unfit', 'prepare_failed']);
  });

  it('api.chat_closed takes a reason and a close code or null', () => {
    expect(ApiChatClosedPayloadSchema.parse({ reason: 'daemon_stop', code: 1001 })).toEqual({
      reason: 'daemon_stop',
      code: 1001,
    });
    expect(ApiChatClosedPayloadSchema.parse({ reason: 'no_pong', code: null }).code).toBeNull();
    expect(ApiChatClosedPayloadSchema.safeParse({ reason: 'bored', code: 1000 }).success).toBe(
      false,
    );
    expect(ApiChatClosedPayloadSchema.safeParse({ reason: 'no_pong', code: 999 }).success).toBe(
      false,
    );
    expect(CHAT_CLOSE_REASONS).toEqual([
      'daemon_stop',
      'token_rotated',
      'no_pong',
      'client_closed',
      'protocol_error',
      'feed_failed',
    ]);
  });

  it('the new events build through the registry and the rejection reasons grew', () => {
    expect(
      buildDaemonEvent('prompt.queued', { promptId: 'p1', source: 'producer', priority: 100 }).type,
    ).toBe('prompt.queued');
    expect(API_REJECTION_REASONS).toEqual(['token', 'host', 'origin', 'ticket', 'message']);
  });
});
