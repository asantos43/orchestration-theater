// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RELEASE_CONFIG,
  loadReleaseConfig,
  parseReleaseConfig,
  ReleaseConfigError,
} from './config.js';
import { repoRoot } from './resolve.js';

describe('release.config.json', () => {
  it('the file of the repository says the three platforms and no version override', () => {
    const config = loadReleaseConfig(
      path.join(repoRoot(), 'tools', 'release', 'release.config.json'),
    );
    expect(config.targets).toEqual(['linux-x64', 'win32-x64', 'darwin-arm64']);
    expect(config.versionOverride).toBeNull();
    expect(config.notices).toBe('per_platform');
  });

  it('an empty object takes the defaults', () => {
    expect(parseReleaseConfig({})).toEqual(DEFAULT_RELEASE_CONFIG);
  });

  it('takes a list of platforms (duplicates dropped) and a version', () => {
    const config = parseReleaseConfig({
      targets: ['linux-x64', 'linux-x64'],
      versionOverride: '1.2.3-rc.1',
    });
    expect(config).toEqual({
      targets: ['linux-x64'],
      versionOverride: '1.2.3-rc.1',
      notices: 'per_platform',
    });
  });

  it('takes the notices mode', () => {
    expect(parseReleaseConfig({ notices: 'root_only' }).notices).toBe('root_only');
    expect(parseReleaseConfig({ notices: 'per_platform' }).notices).toBe('per_platform');
  });

  it.each([
    ['a list that is not one', { targets: 'linux-x64' }],
    ['an empty list', { targets: [] }],
    ['an unknown platform', { targets: ['linux-arm64'] }],
    ['a version that is not a version', { versionOverride: 'latest' }],
    ['a version that carries a shell word', { versionOverride: '1.0.0; rm -rf /' }],
    ['an unknown key', { target: ['linux-x64'] }],
    ['a notices mode that does not exist', { notices: 'none' }],
    ['a notices mode that is not text', { notices: true }],
    ['something that is not an object', []],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseReleaseConfig(raw)).toThrow(ReleaseConfigError);
  });

  it('says what is wrong with a file that is missing or not JSON', () => {
    expect(() => loadReleaseConfig(path.join(repoRoot(), 'no-such-file.json'))).toThrow(
      /Cannot read/,
    );
    expect(() => loadReleaseConfig(path.join(repoRoot(), 'package.json.nope'))).toThrow(
      ReleaseConfigError,
    );
  });
});
