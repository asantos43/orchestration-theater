// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  keyringIndexSource,
  PLAYWRIGHT_STUB_SOURCE,
  sqliteBindingSource,
  yogaSource,
} from './plugins.js';

describe('the modules that stand for what a single file cannot carry', () => {
  it('better-sqlite3 loads its addon from the asset, with the hash of the build', () => {
    const source = sqliteBindingSource('native/better_sqlite3.node', 'abc123');
    expect(source).toContain('__otSeaNative.load("native/better_sqlite3.node", "abc123")');
    expect(source).toContain('exports.getBinding');
    // No path to a file of the machine the executable was built on.
    expect(source).not.toMatch(/node_modules|prebuilds/);
  });

  it('the keyring loads its addon from the asset and keeps its exports', () => {
    const source = keyringIndexSource('native/keyring.node', 'def456');
    expect(source).toContain('__otSeaNative.load("native/keyring.node", "def456")');
    for (const name of ['AsyncEntry', 'Entry', 'findCredentials']) {
      expect(source).toContain(`module.exports.${name}`);
    }
  });

  it('yoga re-exports the enums and takes the engine the entry started', () => {
    const source = yogaSource('/x/YGEnums.js');
    expect(source).toContain('export * from "/x/YGEnums.js"');
    expect(source).toContain('globalThis.__otYoga');
  });

  it('the playwright stub has what the browser adapter imports and says why it cannot work', async () => {
    const stub = (await import(
      `data:text/javascript,${encodeURIComponent(PLAYWRIGHT_STUB_SOURCE)}`
    )) as {
      chromium: { executablePath(): string; connectOverCDP(): Promise<unknown> };
      errors: { TimeoutError: new () => Error };
    };
    expect(new stub.errors.TimeoutError()).toBeInstanceOf(Error);
    expect(stub.chromium.executablePath()).toContain('not part of the single executable');
    await expect(stub.chromium.connectOverCDP()).rejects.toThrow(
      /not part of the single executable/,
    );
  });
});
