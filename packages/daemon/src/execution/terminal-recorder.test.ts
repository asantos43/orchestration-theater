// SPDX-License-Identifier: MPL-2.0
import { TERMINAL_BLOCK_BYTES } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import type { TerminalOutputSettings } from './settings.js';
import { TerminalRecorder, type TerminalBlock } from './terminal-recorder.js';

const KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

function recorder(settings: Partial<TerminalOutputSettings> = {}): TerminalRecorder {
  const all: TerminalOutputSettings = { mode: 'truncated', maxBytes: 64 * 1024, ...settings };
  return new TerminalRecorder(() => all);
}

function out(terminalId: string, text: string, toolCallId = 'tc1') {
  return { kind: 'terminal_output' as const, terminalId, toolCallId, text };
}

function textOf(blocks: readonly TerminalBlock[]): string {
  return blocks.map((block) => block.text).join('');
}

describe('TerminalRecorder', () => {
  it('holds a line until it ends and writes whole lines', () => {
    const r = recorder();
    expect(r.push(out('t', 'par'))).toEqual([]);
    expect(r.push(out('t', 'tial\nnext'))).toEqual([
      { terminalId: 't', toolCallId: 'tc1', text: 'partial\n' },
    ]);
    expect(r.flush()).toEqual([{ terminalId: 't', toolCallId: 'tc1', text: 'next' }]);
    expect(r.flush()).toEqual([]);
  });

  it('masks a secret that arrives split across two chunks', () => {
    const r = recorder();
    const first = r.push(out('t', `token ${KEY.slice(0, 12)}`));
    const second = r.push(out('t', `${KEY.slice(12)}\n`));
    const text = textOf([...first, ...second]);
    expect(text).toBe('token [REDACTED]\n');
    expect(text).not.toContain('abcdefghijkl');
  });

  it('masks an assignment of a secret name and holds a private key until it ends', () => {
    const r = recorder();
    const head = r.push(out('t', 'API_KEY=hunter2\n-----BEGIN PRIVATE KEY-----\nMIIE\n'));
    expect(textOf(head)).toBe('API_KEY=[REDACTED]\n');
    const tail = r.push(out('t', 'abc\n-----END PRIVATE KEY-----\ndone\n'));
    expect(textOf(tail)).not.toContain('MIIE');
    expect(textOf(tail)).not.toContain('abc');
    expect(textOf(tail)).toContain('done');
  });

  it('puts the exit on the last block, or on its own event when nothing was held', () => {
    const r = recorder();
    const last = r.push({ ...out('t', 'bye\n'), exit: { code: 3, signal: null } });
    expect(last).toEqual([
      { terminalId: 't', toolCallId: 'tc1', text: 'bye\n', exitCode: 3, signal: null },
    ]);
    const alone = r.push({
      kind: 'terminal_output',
      terminalId: 'u',
      exit: { code: null, signal: 'SIGKILL' },
    });
    expect(alone).toEqual([{ terminalId: 'u', text: '', exitCode: null, signal: 'SIGKILL' }]);
  });

  it('cuts a terminal at the limit, marks the block and tells what was left out', () => {
    const r = recorder({ maxBytes: 100 });
    const blocks: TerminalBlock[] = [];
    for (let i = 0; i < 10; i += 1) blocks.push(...r.push(out('t', `${'x'.repeat(39)}\n`)));
    blocks.push(
      ...r.push({ kind: 'terminal_output', terminalId: 't', exit: { code: 0, signal: null } }),
    );
    const kept = blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0);
    expect(kept).toBe(100);
    expect(blocks.filter((block) => block.truncated === true && block.text !== '')).toHaveLength(1);
    const closing = blocks[blocks.length - 1];
    expect(closing).toMatchObject({ text: '', truncated: true, omittedBytes: 300, exitCode: 0 });
  });

  it('closes a cut terminal with a note on flush when no exit was told', () => {
    const r = recorder({ maxBytes: 10 });
    r.push(out('t', `${'y'.repeat(30)}\n`));
    expect(r.flush()).toEqual([
      { terminalId: 't', toolCallId: 'tc1', text: '', truncated: true, omittedBytes: 21 },
    ]);
  });

  it('cuts by whole characters', () => {
    const r = recorder({ maxBytes: 5 });
    const blocks = r.push(out('t', 'ééé\n'));
    expect(textOf(blocks)).toBe('éé');
  });

  it('keeps everything with on, and nothing with off', () => {
    const on = recorder({ mode: 'on', maxBytes: 1 });
    expect(textOf(on.push(out('t', 'a long line\n')))).toBe('a long line\n');
    const off = recorder({ mode: 'off' });
    expect(off.push(out('t', 'a long line\n'))).toEqual([]);
    expect(off.flush()).toEqual([]);
  });

  it('writes blocks of at most the block size', () => {
    const r = recorder({ mode: 'on' });
    const line = `${'z'.repeat(1023)}\n`;
    const blocks = r.push(out('t', line.repeat(40)));
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(TERMINAL_BLOCK_BYTES);
    }
    expect(textOf(blocks)).toBe(line.repeat(40));
  });

  it('writes a held text with no line break once it is as large as a block', () => {
    const r = recorder({ mode: 'on' });
    expect(r.push(out('t', 'a'.repeat(TERMINAL_BLOCK_BYTES - 1)))).toEqual([]);
    expect(textOf(r.push(out('t', 'bb'))).length).toBe(TERMINAL_BLOCK_BYTES + 1);
  });

  it('follows the settings at each call', () => {
    const current = { mode: 'off' as TerminalOutputSettings['mode'], maxBytes: 10 };
    const r = new TerminalRecorder(() => current);
    expect(r.push(out('t', 'a\n'))).toEqual([]);
    current.mode = 'on';
    expect(r.push(out('t', 'b\n'))).toHaveLength(1);
  });
});
