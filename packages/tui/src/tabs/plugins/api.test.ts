// SPDX-License-Identifier: MPL-2.0
import { ApiClient, type FetchLike } from '@otheater/client';
import { describe, expect, it } from 'vitest';
import { apiOf, languageParam } from './api.js';
import { UNREADABLE_BLOCK } from './model.js';

/** The routes of the tab over the real typed client and a stub `fetch`: what goes on the wire. */

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function stub(answer: (sent: Sent) => unknown): { client: ApiClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: FetchLike = (url, init) => {
    const record: Sent = {
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    sent.push(record);
    return Promise.resolve(
      new Response(JSON.stringify(answer(record)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { client: new ApiClient({ url: 'http://127.0.0.1:1', token: 't', fetch }), sent };
}

const TABLE = {
  type: 'table',
  title: 'Notes',
  source: 'list_notes',
  error: null,
  truncated: null,
  columns: [{ key: 'id', label: '#' }],
  rows: [{ id: 1 }],
};

describe('languageParam', () => {
  it('passes a language the daemon accepts and leaves out anything else', () => {
    expect(languageParam('pt-BR')).toEqual({ lang: 'pt-BR' });
    expect(languageParam('en')).toEqual({ lang: 'en' });
    expect(languageParam(undefined)).toEqual({});
    expect(languageParam('cimode')).toEqual({});
    expect(languageParam('en_US!')).toEqual({});
    expect(languageParam('')).toEqual({});
  });
});

describe('the panel route of the tab', () => {
  it('keeps the blocks it can read and marks the one it cannot, instead of failing the panel', async () => {
    const { client, sent } = stub(() => ({
      plugin: 'notes',
      project: 'S1',
      language: 'en',
      blocks: [
        TABLE,
        { type: 'gauge', title: 'From the future' },
        { type: 'table', title: 'No rows' },
      ],
    }));
    const panel = await apiOf(client).panel('notes', 'S1', 'pt-BR');
    expect(panel.blocks).toHaveLength(3);
    expect(panel.blocks[0]).toMatchObject({ type: 'table', title: 'Notes' });
    expect(panel.blocks[1]).toBe(UNREADABLE_BLOCK);
    expect(panel.blocks[2]).toBe(UNREADABLE_BLOCK);
    expect(sent[0]?.url).toContain('/v1/plugins/notes/panel');
    expect(sent[0]?.url).toContain('project=S1');
    expect(sent[0]?.url).toContain('lang=pt-BR');
  });

  it('still refuses an envelope that does not fit the contract', async () => {
    const { client } = stub(() => ({ plugin: 'notes', blocks: [] }));
    await expect(apiOf(client).panel('notes', 'S1', undefined)).rejects.toThrow();
  });
});

describe('the commands of the tab', () => {
  it('send the hash that was shown, the project, and a new Idempotency-Key for each press', async () => {
    const { client, sent } = stub((request) =>
      request.url.includes('/enable')
        ? { changed: true }
        : request.url.includes('/disable')
          ? { disabled: true }
          : {
              plugin: 'notes',
              project: 'S1',
              tool: 'clear_notes',
              ok: true,
              result: null,
              truncated: null,
              error: null,
            },
    );
    const api = apiOf(client);
    const hash = 'c'.repeat(64);
    await api.enable('notes', 'S1', hash).catch(() => undefined);
    await api.enable('notes', 'S1', hash).catch(() => undefined);
    await api.disable('notes', 'S1').catch(() => undefined);
    await api.action('notes', 'clear_notes', 'S1').catch(() => undefined);
    expect(sent).toHaveLength(4);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toContain('/v1/plugins/notes/enable');
    expect(sent[0]?.body).toEqual({ project: 'S1', manifestHash: hash });
    expect(sent[2]?.body).toEqual({ project: 'S1' });
    expect(sent[3]?.url).toContain('/v1/plugins/notes/actions/clear_notes');
    const keys = sent.map((request) => request.headers.get('idempotency-key'));
    expect(keys.every((value) => typeof value === 'string' && value.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(4);
  });
});
