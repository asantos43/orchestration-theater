// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { SseParser, readSseText, type SseItem } from './sse-parser.js';

/** Feeds the pieces one by one and collects everything. */
function parse(...pieces: string[]): { items: SseItem[]; parser: SseParser } {
  const parser = new SseParser();
  const items: SseItem[] = [];
  for (const piece of pieces) items.push(...parser.write(piece));
  return { items, parser };
}

const events = (items: SseItem[]) => items.filter((item) => item.kind === 'event');

describe('the SSE parser: fields', () => {
  it('dispatches an event on the blank line, with its id, type and data', () => {
    const { items } = parse('id: 7\nevent: play.created\ndata: {"a":1}\n\n');
    expect(items).toEqual([{ kind: 'event', id: '7', event: 'play.created', data: '{"a":1}' }]);
  });

  it('joins several data lines with a newline and drops the last one', () => {
    const { items } = parse('data: one\ndata: two\ndata:\ndata: four\n\n');
    expect(events(items)).toEqual([
      { kind: 'event', id: '', event: 'message', data: 'one\ntwo\n\nfour' },
    ]);
  });

  it('takes only one leading space of a value, and a field with no colon as an empty value', () => {
    const { items } = parse('data:  two spaces\ndata\n\n');
    expect(events(items)).toEqual([
      { kind: 'event', id: '', event: 'message', data: ' two spaces\n' },
    ]);
  });

  it('keeps the colons that come after the first', () => {
    const { items } = parse('data: a:b:c\n\n');
    expect(events(items)).toMatchObject([{ data: 'a:b:c' }]);
  });

  it('defaults the type to message and uses an empty event field as the default too', () => {
    expect(events(parse('data: x\n\n').items)).toMatchObject([{ event: 'message' }]);
    expect(events(parse('event:\ndata: x\n\n').items)).toMatchObject([{ event: 'message' }]);
  });

  it('does not carry the type to the next event', () => {
    const { items } = parse('event: a\ndata: 1\n\ndata: 2\n\n');
    expect(events(items).map((item) => item.event)).toEqual(['a', 'message']);
  });

  it('ignores unknown fields and lines that are only a colon-less word', () => {
    const { items } = parse('foo: bar\nnonsense\ndata: ok\n\n');
    expect(items).toEqual([{ kind: 'event', id: '', event: 'message', data: 'ok' }]);
  });

  it('does not dispatch an event with no data, and does not leak its type', () => {
    const { items } = parse('event: lonely\n\nevent: next\ndata: x\n\n');
    expect(events(items)).toEqual([{ kind: 'event', id: '', event: 'next', data: 'x' }]);
  });

  it('dispatches an event whose data is empty but present', () => {
    expect(events(parse('data:\n\n').items)).toEqual([
      { kind: 'event', id: '', event: 'message', data: '' },
    ]);
  });
});

describe('the SSE parser: the last event id', () => {
  it('survives from one event to the next, and an empty id resets it', () => {
    const { items, parser } = parse('id: 1\ndata: a\n\ndata: b\n\nid:\ndata: c\n\n');
    expect(events(items).map((item) => item.id)).toEqual(['1', '1', '']);
    expect(parser.lastEventId).toBe('');
  });

  it('keeps the id of an event that had no data (a cursor with no message)', () => {
    const { items, parser } = parse('id: 42\n\n');
    expect(items).toEqual([]);
    expect(parser.lastEventId).toBe('42');
  });

  it('moves only at the blank line: half a frame cut by a drop does not move it', () => {
    const { parser } = parse('id: 5\ndata: a\n\n', 'id: 6\nevent: x\ndata: {"id"');
    expect(parser.lastEventId).toBe('5');
    parser.end();
    expect(parser.lastEventId).toBe('5');
    expect(parse('id: 6\n').parser.lastEventId).toBe('');
  });

  it('ignores an id with a NUL', () => {
    const { parser } = parse('id: 5\nid: 6\u00007\ndata: x\n\n');
    expect(parser.lastEventId).toBe('5');
  });
});

describe('the SSE parser: retry and comments', () => {
  it('reports a retry made only of digits and ignores the rest', () => {
    const { items } = parse('retry: 2500\nretry: soon\nretry: 12x\nretry: -5\nretry:\n\n');
    expect(items).toEqual([{ kind: 'retry', ms: 2500 }]);
  });

  it('reports comments, which are the heartbeat, and never dispatches them', () => {
    const { items } = parse(': keep-alive\n:no space\n\n');
    expect(items).toEqual([
      { kind: 'comment', text: 'keep-alive' },
      { kind: 'comment', text: 'no space' },
    ]);
  });

  it('lets a comment sit in the middle of an event', () => {
    const { items } = parse('data: a\n: ping\ndata: b\n\n');
    expect(items).toEqual([
      { kind: 'comment', text: 'ping' },
      { kind: 'event', id: '', event: 'message', data: 'a\nb' },
    ]);
  });
});

describe('the SSE parser: line terminators', () => {
  it('accepts \\n, \\r\\n and \\r, mixed', () => {
    const { items } = parse('data: a\r\n\r\ndata: b\r\rdata: c\n\n');
    expect(events(items).map((item) => item.data)).toEqual(['a', 'b', 'c']);
  });

  it('reads a blank line made of \\r\\r\\n as two terminators', () => {
    const { items } = parse('data: a\r\n\r\n');
    expect(events(items)).toHaveLength(1);
  });

  it('handles a \\r\\n cut between the two characters', () => {
    const { items } = parse('data: a\r', '\ndata: b\r\n\r', '\n');
    expect(events(items)).toEqual([{ kind: 'event', id: '', event: 'message', data: 'a\nb' }]);
  });

  it('does not swallow a real \\n that follows a \\r\\n of another line', () => {
    // `data: a\r` + `\n` is one terminator; the next `\n` is a blank line.
    const { items } = parse('data: a\r', '\n', '\n');
    expect(events(items)).toHaveLength(1);
  });

  it('strips a BOM at the very start only: a later one makes the field name unknown', () => {
    const { items } = parse('\uFEFFdata: a\n\n', '\uFEFFdata: b\n\n');
    expect(events(items).map((item) => item.data)).toEqual(['a']);
  });
});

describe('the SSE parser: pieces cut anywhere', () => {
  const stream =
    '﻿: hello\nretry: 3000\nid: 1\nevent: play.created\ndata: {"title":"x"}\n\r\nid: 2\r\ndata: l1\rdata: l2\n\n:tail\n';

  it('gives the same result for every way of cutting the stream into two, and one char at a time', () => {
    const whole = parse(stream).items;
    expect(events(whole)).toHaveLength(2);
    for (let cut = 0; cut <= stream.length; cut += 1) {
      expect(parse(stream.slice(0, cut), stream.slice(cut)).items, `cut at ${String(cut)}`).toEqual(
        whole,
      );
    }
    expect(parse(...stream.split('')).items).toEqual(whole);
  });

  it('keeps a field name and a value that are cut in the middle', () => {
    const { items } = parse('da', 'ta: he', 'llo wor', 'ld\n', '\n');
    expect(events(items)).toEqual([
      { kind: 'event', id: '', event: 'message', data: 'hello world' },
    ]);
  });

  it('discards what is pending at the end: half a line, and an event with no blank line after it', () => {
    const parser = new SseParser();
    expect(parser.write('id: 1\ndata: whole\n\nid: 2\ndata: half\ndata: ha')).toHaveLength(1);
    parser.end();
    // A new connection starts clean: the half event does not come back.
    expect(parser.write('\n\n')).toEqual([]);
  });
});

describe('readSseText', () => {
  const encoder = new TextEncoder();

  function bodyOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  async function textOf(body: ReadableStream<Uint8Array>): Promise<string> {
    let text = '';
    for await (const piece of readSseText(body)) text += piece;
    return text;
  }

  it('keeps a multibyte character that two chunks cut in the middle', async () => {
    const bytes = encoder.encode('data: ação 🎭 日本\n\n');
    // Every cut position, so each multibyte character is split at least once at some of them.
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const text = await textOf(bodyOf(bytes.slice(0, cut), bytes.slice(cut)));
      expect(text, `cut at ${String(cut)}`).toBe('data: ação 🎭 日本\n\n');
    }
  });

  it('parses an event whose emoji arrives one byte at a time', async () => {
    const bytes = encoder.encode('id: 3\ndata: 🎭\n\n');
    const parser = new SseParser();
    const items: SseItem[] = [];
    for await (const piece of readSseText(
      bodyOf(...Array.from(bytes, (byte) => Uint8Array.of(byte))),
    )) {
      items.push(...parser.write(piece));
    }
    expect(items).toEqual([{ kind: 'event', id: '3', event: 'message', data: '🎭' }]);
  });

  it('leaves the BOM to the parser, which strips it', async () => {
    const bytes = encoder.encode('﻿data: a\n\n');
    const parser = new SseParser();
    const items: SseItem[] = [];
    for await (const piece of readSseText(bodyOf(bytes))) items.push(...parser.write(piece));
    expect(events(items)).toMatchObject([{ data: 'a' }]);
  });

  it('cancels the body when the reader stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode('data: x\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const piece of readSseText(body)) {
      expect(piece).toContain('data');
      break;
    }
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });
});
