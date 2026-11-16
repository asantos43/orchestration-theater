// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { InvalidInput } from '../errors.js';
import { formatProfileId, parseProfileId } from './executor.js';

describe('profile ids', () => {
  it('round-trip <client>/<profile>', () => {
    expect(formatProfileId({ client: 'claude-code', profile: 'empresa' })).toBe(
      'claude-code/empresa',
    );
    expect(parseProfileId('opencode/local')).toEqual({ client: 'opencode', profile: 'local' });
  });

  it('refuse anything that is not exactly two valid names', () => {
    for (const id of [
      '',
      'codex',
      'codex/',
      '/a',
      'a/b/c',
      'A/b',
      'a/B',
      'a b/c',
      '-a/b',
      'a/..',
    ]) {
      expect(() => parseProfileId(id), id).toThrow(InvalidInput);
    }
    expect(() => formatProfileId({ client: 'codex', profile: 'a/b' })).toThrow(InvalidInput);
  });
});
