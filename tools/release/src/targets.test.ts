// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { hostTarget, isTargetId, TARGET_IDS, targetInfo } from './targets.js';

describe('targets', () => {
  it('knows the three platforms of the plan', () => {
    expect([...TARGET_IDS]).toEqual(['linux-x64', 'win32-x64', 'darwin-arm64']);
    expect(isTargetId('linux-x64')).toBe(true);
    expect(isTargetId('freebsd-x64')).toBe(false);
    expect(isTargetId(undefined)).toBe(false);
  });

  it('names the executable and the addons of each platform', () => {
    expect(targetInfo('win32-x64').executable).toBe('otheater.exe');
    expect(targetInfo('linux-x64').executable).toBe('otheater');
    for (const id of TARGET_IDS) {
      const info = targetInfo(id);
      expect(info.id).toBe(id);
      expect(info.keyringPackage).toMatch(/^@napi-rs\/keyring-/);
      expect(info.keyringFile).toMatch(/\.node$/);
      expect(`${info.platform}-${info.arch}`).toBe(info.sqlitePrebuild);
    }
  });

  it('the host is one of them, or none for a platform the release does not build', () => {
    const host = hostTarget();
    expect(host === undefined || isTargetId(host)).toBe(true);
    expect(hostTarget('linux', 'x64')).toBe('linux-x64');
    expect(hostTarget('win32', 'x64')).toBe('win32-x64');
    expect(hostTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(hostTarget('darwin', 'x64')).toBeUndefined();
  });
});
