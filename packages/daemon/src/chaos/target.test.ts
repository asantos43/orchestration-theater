// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chaosTarget, overSea } from './target.js';

const dir = mkdtempSync(join(tmpdir(), 'otheater-target-test-'));
const exe = join(dir, 'otheater');
writeFileSync(exe, '');
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('chaosTarget', () => {
  it('is the source when nothing is set, or it is empty or named', () => {
    expect(chaosTarget({})).toEqual({ kind: 'source' });
    expect(chaosTarget({ OT_CHAOS_TARGET: '' })).toEqual({ kind: 'source' });
    expect(chaosTarget({ OT_CHAOS_TARGET: 'source', OT_CHAOS_SEA: exe })).toEqual({
      kind: 'source',
    });
  });

  it('takes the executable of the sea mode', () => {
    expect(chaosTarget({ OT_CHAOS_TARGET: 'sea', OT_CHAOS_SEA: exe })).toEqual({
      kind: 'sea',
      executable: exe,
    });
  });

  it('throws on an unknown mode, on the sea mode with no executable, and on one that is not a file', () => {
    expect(() => chaosTarget({ OT_CHAOS_TARGET: 'exe' })).toThrow(/OT_CHAOS_TARGET=exe/);
    expect(() => chaosTarget({ OT_CHAOS_TARGET: 'sea' })).toThrow(/needs OT_CHAOS_SEA/);
    expect(() => chaosTarget({ OT_CHAOS_TARGET: 'sea', OT_CHAOS_SEA: dir })).toThrow(/not a file/);
    expect(() =>
      chaosTarget({ OT_CHAOS_TARGET: 'sea', OT_CHAOS_SEA: join(dir, 'missing') }),
    ).toThrow(/not a file/);
  });
});

describe('overSea', () => {
  it('is true only for the sea mode', () => {
    expect(overSea({ OT_CHAOS_TARGET: 'sea' })).toBe(true);
    expect(overSea({ OT_CHAOS_TARGET: 'source' })).toBe(false);
    expect(overSea({})).toBe(false);
  });
});
