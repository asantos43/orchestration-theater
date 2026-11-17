// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { OutputCollector, truncateText } from './truncate.js';

const encoder = new TextEncoder();

describe('truncateText', () => {
  it('returns short text as it is, not truncated', () => {
    expect(truncateText('hello', 100)).toEqual({
      text: 'hello',
      truncated: false,
      originalBytes: 5,
    });
    expect(truncateText('', 10)).toEqual({ text: '', truncated: false, originalBytes: 0 });
    expect(truncateText('12345', 5).truncated).toBe(false);
  });

  it('keeps the head and says how much was cut', () => {
    const out = truncateText('0123456789'.repeat(10), 20, 'head');
    expect(out.truncated).toBe(true);
    expect(out.originalBytes).toBe(100);
    expect(out.text.startsWith('01234567890123456789')).toBe(true);
    expect(out.text).toContain('[... 80 of 100 bytes truncated ...]');
  });

  it('keeps the tail', () => {
    const out = truncateText(`${'a'.repeat(100)}END`, 10, 'tail');
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith('aaaaaaaEND')).toBe(true);
    expect(out.text).toContain('93 of 103 bytes truncated');
  });

  it('keeps both ends by default, with the mark between them', () => {
    const out = truncateText(`HEAD${'x'.repeat(200)}TAIL`, 20);
    expect(out.truncated).toBe(true);
    expect(out.originalBytes).toBe(208);
    expect(out.text.startsWith('HEADxxxxxx')).toBe(true);
    expect(out.text.endsWith('xxxxxxTAIL')).toBe(true);
    expect(out.text).toContain('188 of 208 bytes truncated');
  });

  it('never cuts a UTF-8 character in two', () => {
    const text = 'ação '.repeat(40);
    for (const mode of ['head', 'tail', 'head_tail'] as const) {
      for (let max = 1; max < 30; max++) {
        const out = truncateText(text, max, mode);
        expect(out.text).not.toContain('�');
      }
    }
  });
});

describe('OutputCollector', () => {
  it('gets the same result from many small chunks as from one', () => {
    const whole = `START${'.'.repeat(5000)}FINISH`;
    const bytes = encoder.encode(whole);
    const collector = new OutputCollector(64);
    for (let i = 0; i < bytes.length; i += 7) collector.push(bytes.subarray(i, i + 7));
    expect(collector.result()).toEqual(truncateText(whole, 64));
    expect(collector.totalBytes).toBe(bytes.length);
  });

  it('keeps memory bounded: only the limit is held, however much is pushed', () => {
    const collector = new OutputCollector(1024);
    const chunk = new Uint8Array(64 * 1024).fill(65);
    for (let i = 0; i < 64; i++) collector.push(chunk);
    const out = collector.result();
    expect(out.originalBytes).toBe(64 * 64 * 1024);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThan(1200);
  });

  it('rejects a limit that is not a positive integer', () => {
    expect(() => new OutputCollector(0)).toThrow(RangeError);
    expect(() => new OutputCollector(1.5)).toThrow(RangeError);
  });
});
