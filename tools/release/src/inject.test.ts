// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { codesignSteps, SEA_MACHO_SEGMENT, SEA_RESOURCE, SEA_SENTINEL_FUSE } from './inject.js';

describe('the injection', () => {
  it('uses the sentinel, resource and segment that Node looks for', () => {
    expect(SEA_SENTINEL_FUSE).toBe('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
    expect(SEA_RESOURCE).toBe('NODE_SEA_BLOB');
    expect(SEA_MACHO_SEGMENT).toBe('NODE_SEA');
  });

  it('on macOS the old signature goes first and an ad hoc one (no identity) comes after', () => {
    expect(codesignSteps('/o/otheater', 'before')).toEqual([['--remove-signature', '/o/otheater']]);
    const after = codesignSteps('/o/otheater', 'after');
    expect(after).toEqual([['--force', '--sign', '-', '/o/otheater']]);
  });
});
