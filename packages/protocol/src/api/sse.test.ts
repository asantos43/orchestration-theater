// SPDX-License-Identifier: MPL-2.0
import type { EventEnvelope } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  ApiEventEnvelopeSchema,
  ApiSseMessageSchema,
  EventStreamHeadersSchema,
  EventStreamQuerySchema,
  LAST_EVENT_ID_HEADER,
  queryList,
  sseMessageOf,
  streamEvents,
} from './sse.js';

const daemonId = '3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b';
const envelope: EventEnvelope = {
  id: 42,
  timestamp: 1_700_000_000_000,
  type: 'play.created',
  schemaVersion: 1,
  payload: { title: 'x', nested: { n: [1, 2] } },
  scenarioId: 'S1',
  playId: 'P1',
};

describe('the stream query', () => {
  it('reads one scenario, several, types as prefixes and since', () => {
    expect(EventStreamQuerySchema.parse({})).toEqual({});
    expect(EventStreamQuerySchema.parse({ scenario: 'S1', types: 'play.', since: '10' })).toEqual({
      scenario: 'S1',
      types: 'play.',
      since: 10,
    });
    expect(
      EventStreamQuerySchema.parse({ scenario: ['S1', 'S2'], types: ['play.', 'quota.'] }),
    ).toEqual({ scenario: ['S1', 'S2'], types: ['play.', 'quota.'] });
  });

  it('refuses an empty list, an upper-case prefix, a negative since and unknown parameters', () => {
    for (const bad of [
      { scenario: [] },
      { types: 'Play.' },
      { types: '' },
      { since: '-1' },
      { since: '1.5' },
      { cursor: '1' },
    ]) {
      expect(EventStreamQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('turns one value or a list into a list', () => {
    expect(queryList(undefined)).toEqual([]);
    expect(queryList('a')).toEqual(['a']);
    expect(queryList(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('Last-Event-ID', () => {
  it('names the header and checks the value', () => {
    expect(LAST_EVENT_ID_HEADER).toBe('Last-Event-ID');
    expect(EventStreamHeadersSchema.safeParse({ 'last-event-id': '42' }).success).toBe(true);
    expect(EventStreamHeadersSchema.safeParse({ 'last-event-id': '0' }).success).toBe(true);
    expect(EventStreamHeadersSchema.safeParse({ 'last-event-id': 'abc' }).success).toBe(false);
    expect(EventStreamHeadersSchema.safeParse({ 'last-event-id': '007' }).success).toBe(false);
    expect(EventStreamHeadersSchema.safeParse({ accept: 'text/event-stream' }).success).toBe(true);
  });
});

describe('the stream message', () => {
  it('carries the id of the log, the type and the envelope with the daemon id', () => {
    const message = sseMessageOf(envelope, daemonId);
    expect(message).toEqual({
      id: '42',
      event: 'play.created',
      data: { ...envelope, daemonId },
    });
    expect(ApiSseMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
    expect(ApiEventEnvelopeSchema.safeParse(message.data).success).toBe(true);
  });

  it('refuses an id or an event that disagree with the envelope, or an envelope with no daemon', () => {
    const good = sseMessageOf(envelope, daemonId);
    expect(ApiSseMessageSchema.safeParse({ ...good, id: '43' }).success).toBe(false);
    expect(ApiSseMessageSchema.safeParse({ ...good, event: 'play.other' }).success).toBe(false);
    const bare: Record<string, unknown> = { ...good.data };
    delete bare.daemonId;
    expect(ApiSseMessageSchema.safeParse({ ...good, data: bare }).success).toBe(false);
    expect(
      ApiSseMessageSchema.safeParse({ ...good, data: { ...good.data, extra: 1 } }).success,
    ).toBe(false);
  });

  it('is the response of the stream route', () => {
    expect(streamEvents.kind).toBe('sse');
    expect(streamEvents.path).toBe('/v1/events');
    expect(streamEvents.response).toBe(ApiSseMessageSchema);
  });
});
