// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  CHAT_CLIENT_MESSAGE_TYPES,
  CHAT_SERVER_MESSAGE_TYPES,
  CHAT_TICKET_TTL_MS,
  ChatClientMessageSchema,
  ChatServerMessageSchema,
  ChatTicketRequestSchema,
  ChatTicketSchema,
  createChatTicket,
  openChatSocket,
} from './chat.js';

const clientMessages = [
  { type: 'message', text: 'hello' },
  { type: 'message', text: 'see this', attachments: ['A1', 'A2'] },
  { type: 'answer', decisionId: 'D4', answer: { option: 'approve' } },
  { type: 'command', text: '/idea add something' },
  { type: 'resume', lastEventId: 120 },
];

const serverMessages = [
  { type: 'director_reply', eventId: 5, replyId: 1, text: 'part', final: false },
  { type: 'director_reply', eventId: 6, replyId: 1, text: 'end', final: true },
  { type: 'ask', eventId: 7, decisionId: 'D4', kind: 'producer_question', playId: null, input: {} },
  { type: 'ask_closed', eventId: 9, decisionId: 'D4', state: 'decided' },
  {
    type: 'system',
    eventId: 8,
    message: {
      scenarioId: 'S1',
      kind: 'reset_wait',
      playId: 'P1',
      attemptId: 'A1',
      role: null,
      cause: 'quota_exhausted',
      executor: 'claude-code',
      resetsAt: null,
    },
  },
  {
    type: 'queue_held',
    eventId: 9,
    held: { scenarioId: 'S1', cause: 'play_ended', reason: 'a play ended', playId: 'P1' },
  },
  { type: 'play_state', eventId: 10, playId: 'P1', state: 'WORK' },
  {
    type: 'waits',
    eventId: 11,
    waits: [
      {
        role: 'director',
        playId: null,
        demandId: 'D1',
        on: [{ profile: 'main', reason: 'quota' }],
        until: null,
      },
    ],
  },
  { type: 'busy', eventId: 12, busy: true },
  {
    type: 'shell_started',
    eventId: 13,
    command: { commandId: 'sh_1', command: 'ls', place: 'sandbox' },
  },
  {
    type: 'shell_finished',
    eventId: 14,
    result: {
      commandId: 'sh_1',
      outcome: 'exited',
      exitCode: 0,
      durationMs: 5,
      totalLines: 2,
      shownLines: 2,
      keep: 'tail',
      logTruncated: false,
      attachmentId: 'A1',
      askedInput: false,
      context: 'sent',
      logPath: '/data/scenarios/S1/terminal/sh_1.log',
    },
    snippet: 'a\nb',
  },
  { type: 'error', eventId: null, error: { code: 'invalid_input', message: 'bad message' } },
];

describe('the messages of the client', () => {
  it('round-trips each kind', () => {
    for (const message of clientMessages) {
      expect(ChatClientMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
  });

  it('refuses an unknown type, a missing type and extra fields', () => {
    for (const bad of [
      { type: 'shout', text: 'x' },
      { text: 'x' },
      { type: 'message', text: 'x', extra: 1 },
      { type: 'command', text: 'no slash' },
      { type: 'resume', lastEventId: -1 },
      { type: 'resume' },
      { type: 'answer', decisionId: 'D1' },
      'message',
      null,
    ]) {
      expect(ChatClientMessageSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('lists every type', () => {
    expect(CHAT_CLIENT_MESSAGE_TYPES).toEqual(['message', 'answer', 'command', 'resume']);
  });
});

describe('the messages of the daemon', () => {
  it('round-trips each kind', () => {
    for (const message of serverMessages) {
      expect(ChatServerMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
    expect(new Set(serverMessages.map((m) => m.type))).toEqual(new Set(CHAT_SERVER_MESSAGE_TYPES));
  });

  it('refuses an unknown type, a message with no event id (but the error) and extra fields', () => {
    for (const bad of [
      { type: 'typing', eventId: 1 },
      { type: 'busy', busy: true },
      { type: 'busy', eventId: 0, busy: true },
      { type: 'busy', eventId: 1, busy: true, extra: 1 },
      { type: 'ask_closed', eventId: 1, decisionId: 'D4', state: 'pending' },
      { type: 'ask_closed', eventId: 1, decisionId: 'D4' },
      { type: 'error', eventId: 3, error: { code: 'internal', message: 'x' } },
      { type: 'error', eventId: null, error: { code: 'teapot', message: 'x' } },
      { type: 'director_reply', eventId: 1, replyId: 1, text: 'x' },
      { type: 'system', eventId: 1, message: { kind: 'unknown' } },
    ]) {
      expect(ChatServerMessageSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the ticket and the routes', () => {
  it('asks for a ticket for a scenario and gets a ticket and its validity', () => {
    expect(ChatTicketRequestSchema.parse({ scenarioId: 'S1' })).toEqual({ scenarioId: 'S1' });
    expect(ChatTicketRequestSchema.safeParse({}).success).toBe(false);
    const ticket = { ticket: 'x'.repeat(32), expiresInMs: CHAT_TICKET_TTL_MS };
    expect(ChatTicketSchema.parse(ticket)).toEqual(ticket);
    expect(ChatTicketSchema.safeParse({ ...ticket, expiresInMs: 0 }).success).toBe(false);
    expect(ChatTicketSchema.safeParse({ ticket: 'short', expiresInMs: 1 }).success).toBe(false);
    expect(CHAT_TICKET_TTL_MS).toBe(30_000);
  });

  it('declares the ticket route and the socket route', () => {
    expect(createChatTicket.method).toBe('POST');
    expect(createChatTicket.path).toBe('/v1/chat-tickets');
    expect(openChatSocket.kind).toBe('websocket');
    expect(openChatSocket.path).toBe('/v1/scenarios/:id/chat');
    expect(openChatSocket.clientMessage).toBe(ChatClientMessageSchema);
    expect(openChatSocket.response).toBe(ChatServerMessageSchema);
    expect(openChatSocket.query.safeParse({ ticket: 'x'.repeat(32) }).success).toBe(true);
    expect(openChatSocket.query.safeParse({}).success).toBe(false);
  });
});
