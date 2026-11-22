// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  createEventPublisher,
  PLUGIN_EVENT_MAX_BYTES,
  PluginEventError,
  type PluginEventParams,
} from './events.js';

function publisher(maxBytes?: number) {
  const sent: PluginEventParams[] = [];
  const events = createEventPublisher({
    declared: ['note_added', 'job.done'],
    ...(maxBytes === undefined ? {} : { maxBytes }),
    send: (params) => {
      sent.push(params);
      return Promise.resolve();
    },
  });
  return { events, sent };
}

async function refusal(promise: Promise<unknown>): Promise<PluginEventError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PluginEventError) return error;
    throw error;
  }
  throw new Error('the event was sent');
}

describe('createEventPublisher', () => {
  it('sends a declared name with its payload, with no prefix', async () => {
    const { events, sent } = publisher();
    await events.publish('note_added', { id: 7, tags: ['a'] });
    await events.publish('job.done');
    expect(sent).toEqual([
      { name: 'note_added', payload: { id: 7, tags: ['a'] } },
      { name: 'job.done', payload: {} },
    ]);
  });

  it('refuses an undeclared name and says what is declared', async () => {
    const { events, sent } = publisher();
    const error = await refusal(events.publish('note_deleted', {}));
    expect(error.code).toBe('undeclared');
    expect(error.message).toContain('"note_deleted"');
    expect(error.message).toContain('note_added, job.done');
    expect(sent).toEqual([]);
  });

  it('refuses a name with the daemon prefix, because the manifest declares it without one', async () => {
    const { events } = publisher();
    expect((await refusal(events.publish('plugin.notes.note_added'))).code).toBe('undeclared');
  });

  it('refuses a payload that is not an object', async () => {
    const { events, sent } = publisher();
    for (const payload of [[1], 'text', 5, null, new Date(0), new Map()]) {
      const error = await refusal(events.publish('note_added', payload as never));
      expect(error.code).toBe('invalid_payload');
    }
    expect(sent).toEqual([]);
  });

  it('refuses a payload that has no JSON text', async () => {
    const { events } = publisher();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect((await refusal(events.publish('note_added', circular))).code).toBe('invalid_payload');
    expect((await refusal(events.publish('note_added', { n: 10n }))).code).toBe('invalid_payload');
  });

  it('accepts a payload of exactly the limit and refuses one byte more', async () => {
    const { events, sent } = publisher();
    const overhead = Buffer.byteLength(JSON.stringify({ text: '' }), 'utf8');
    const exact = { text: 'x'.repeat(PLUGIN_EVENT_MAX_BYTES - overhead) };
    await events.publish('note_added', exact);
    expect(sent).toHaveLength(1);
    const error = await refusal(
      events.publish('note_added', { text: 'x'.repeat(PLUGIN_EVENT_MAX_BYTES - overhead + 1) }),
    );
    expect(error.code).toBe('too_large');
    expect(error.message).toContain(String(PLUGIN_EVENT_MAX_BYTES));
    expect(sent).toHaveLength(1);
  });

  it('counts bytes, not characters', async () => {
    const { events } = publisher(32);
    // 12 characters, 36 bytes of text in UTF-8 (3 bytes each), over the limit of 32.
    expect((await refusal(events.publish('note_added', { t: '€'.repeat(12) }))).code).toBe(
      'too_large',
    );
  });

  it('keeps the default limit at 16 KB, the default of plugins.event_max_bytes', () => {
    expect(PLUGIN_EVENT_MAX_BYTES).toBe(16384);
  });
});
