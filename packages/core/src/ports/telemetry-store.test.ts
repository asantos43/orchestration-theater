// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { joinUnixNano, splitUnixNano } from './telemetry-store.js';

describe('splitUnixNano / joinUnixNano', () => {
  it('splits exact epoch nanoseconds beyond 2^53 and joins them back', () => {
    for (const nanos of [
      0n,
      1n,
      999_999n,
      1_000_000n,
      1_700_000_000_123_456_789n,
      9_007_199_254_740_993n,
    ]) {
      const { ms, subNs } = splitUnixNano(nanos);
      expect(subNs).toBeGreaterThanOrEqual(0);
      expect(subNs).toBeLessThan(1_000_000);
      expect(joinUnixNano(ms, subNs)).toBe(nanos);
    }
    expect(splitUnixNano(1_700_000_000_123_456_789n)).toEqual({
      ms: 1_700_000_000_123,
      subNs: 456_789,
    });
  });
});
