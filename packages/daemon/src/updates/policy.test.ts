// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { UpdateStop } from './errors.js';
import type { UpdateManifest } from './manifest.js';
import { checkChannel, checkExpiry, checkManifestPolicy, checkMinVersion } from './policy.js';

const NOW = Date.UTC(2026, 10, 23);
const manifest = (over: Partial<UpdateManifest> = {}): UpdateManifest => ({
  schema: 1,
  version: '0.6.0',
  channel: 'stable',
  publishedAt: '2026-11-22T12:00:00Z',
  assets: [],
  ...over,
});

function reasonOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof UpdateStop ? error.reason : 'not an UpdateStop';
  }
  return undefined;
}

describe('checkExpiry', () => {
  const at = (expires: string | undefined, expiry: 'enforce' | 'require' | 'off') =>
    checkExpiry(manifest(expires === undefined ? {} : { expires }), { expiry, now: NOW });

  it('accepts a manifest in date', () => {
    expect(at('2026-11-24T00:00:00Z', 'enforce')).toEqual({ noExpiry: false });
  });

  it('refuses an expired one, at the instant and after', () => {
    expect(at(new Date(NOW).toISOString(), 'enforce')).toEqual({ noExpiry: false });
    expect(reasonOf(() => at(new Date(NOW - 1).toISOString(), 'enforce'))).toBe('bad_manifest');
    expect(reasonOf(() => at('2026-11-22T00:00:00Z', 'require'))).toBe('bad_manifest');
  });

  it('a date that cannot be read counts as expired (fails closed)', () => {
    expect(reasonOf(() => at('someday', 'enforce'))).toBe('bad_manifest');
  });

  it('a manifest with no expires: accepted by enforce (and said), refused by require', () => {
    expect(at(undefined, 'enforce')).toEqual({ noExpiry: true });
    expect(reasonOf(() => at(undefined, 'require'))).toBe('bad_manifest');
  });

  it('off ignores expires altogether', () => {
    expect(at('2001-01-01T00:00:00Z', 'off')).toEqual({ noExpiry: false });
    expect(at(undefined, 'off')).toEqual({ noExpiry: false });
  });
});

describe('checkChannel, checkMinVersion and the three together', () => {
  it('names the reason of each', () => {
    expect(
      reasonOf(() => {
        checkChannel(manifest({ channel: 'beta' }), { channel: 'stable' });
      }),
    ).toBe('wrong_channel');
    expect(
      reasonOf(() => {
        checkMinVersion(manifest({ minVersion: '0.5.5' }), { current: '0.5.0' });
      }),
    ).toBe('below_min_version');
    // Exactly the minimum is enough.
    expect(
      reasonOf(() => {
        checkMinVersion(manifest({ minVersion: '0.5.0' }), { current: '0.5.0' });
      }),
    ).toBeUndefined();
  });

  it('runs the channel first, then the minimum version, then the expiry', () => {
    const policy = { channel: 'stable', current: '0.5.0', expiry: 'enforce', now: NOW } as const;
    const bad = manifest({ channel: 'beta', minVersion: '9.0.0', expires: '2001-01-01T00:00:00Z' });
    expect(reasonOf(() => checkManifestPolicy(bad, policy))).toBe('wrong_channel');
    expect(reasonOf(() => checkManifestPolicy({ ...bad, channel: 'stable' }, policy))).toBe(
      'below_min_version',
    );
    expect(
      reasonOf(() =>
        checkManifestPolicy({ ...bad, channel: 'stable', minVersion: undefined }, policy),
      ),
    ).toBe('bad_manifest');
  });
});
