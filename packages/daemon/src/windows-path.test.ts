// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { FakeCommandRunner } from './service/service-fixture.js';
import {
  clientSearchEnv,
  expandWindowsVars,
  mergeWindowsPath,
  parseRegQueryPath,
  REGISTRY_PATH_KEYS,
} from './windows-path.js';

const HKLM = REGISTRY_PATH_KEYS[0];
const HKCU = REGISTRY_PATH_KEYS[1];

/** The output of `reg query <key> /v Path`, as Windows prints it. */
function regOutput(key: string, value: string, type = 'REG_EXPAND_SZ'): string {
  return `\r\n${key}\r\n    Path    ${type}    ${value}\r\n\r\n`;
}

describe('parseRegQueryPath', () => {
  it('reads REG_EXPAND_SZ and REG_SZ, the name with no regard to case', () => {
    expect(parseRegQueryPath(regOutput(HKCU, 'C:\\a;%USERPROFILE%\\b'))).toBe(
      'C:\\a;%USERPROFILE%\\b',
    );
    expect(parseRegQueryPath(regOutput(HKCU, 'C:\\x', 'REG_SZ'))).toBe('C:\\x');
    expect(parseRegQueryPath('\n    PATH    REG_SZ    C:\\y\n')).toBe('C:\\y');
  });

  it('gives undefined when there is no Path line', () => {
    expect(parseRegQueryPath('')).toBeUndefined();
    expect(
      parseRegQueryPath('\r\nHKEY_CURRENT_USER\\Environment\r\n    TEMP    REG_SZ    C:\\t\r\n'),
    ).toBeUndefined();
  });
});

describe('expandWindowsVars', () => {
  it('expands %NAME% with no regard to case and keeps a name that is not set', () => {
    expect(
      expandWindowsVars('%userprofile%\\bin;%NOPE%\\x;%SystemRoot%', {
        USERPROFILE: 'C:\\Users\\u',
        SystemRoot: 'C:\\Windows',
      }),
    ).toBe('C:\\Users\\u\\bin;%NOPE%\\x;C:\\Windows');
  });
});

describe('mergeWindowsPath', () => {
  it('keeps the first list in order and adds the new folders, compared as Windows does', () => {
    expect(mergeWindowsPath('C:\\a;C:\\B\\', ['c:\\b;C:\\c;;', 'C:/A;C:\\d'])).toBe(
      ['C:\\a', 'C:\\B\\', 'C:\\c', 'C:\\d'].join(';'),
    );
  });

  it('starts from nothing when the first list is absent', () => {
    expect(mergeWindowsPath(undefined, ['C:\\x;C:\\x'])).toBe('C:\\x');
  });
});

describe('clientSearchEnv', () => {
  it('does nothing off Windows or with mode process', async () => {
    const run = new FakeCommandRunner();
    const env = { PATH: '/usr/bin' };
    expect(await clientSearchEnv(env, { mode: 'merge', platform: 'linux', run: run.run })).toEqual({
      env,
      added: 0,
      failed: [],
    });
    expect(
      await clientSearchEnv(env, { mode: 'process', platform: 'win32', run: run.run }),
    ).toEqual({ env, added: 0, failed: [] });
    expect(run.calls).toEqual([]);
  });

  it('completes Path from the machine key and then the user key, expanded', async () => {
    const run = new FakeCommandRunner()
      .on(HKLM, { stdout: regOutput(HKLM, 'C:\\Windows;C:\\Program Files\\nodejs') })
      .on(HKCU, { stdout: regOutput(HKCU, '%USERPROFILE%\\.local\\bin;C:\\Windows') });
    const result = await clientSearchEnv(
      { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u' },
      { mode: 'merge', platform: 'win32', run: run.run },
    );
    expect(result.env.Path).toBe('C:\\Windows;C:\\Program Files\\nodejs;C:\\Users\\u\\.local\\bin');
    expect(result.added).toBe(2);
    expect(result.failed).toEqual([]);
    expect(run.lines).toEqual([`reg query ${HKLM} /v Path`, `reg query ${HKCU} /v Path`]);
  });

  it('writes into PATH when that is the name the daemon got', async () => {
    const run = new FakeCommandRunner()
      .on(HKLM, { stdout: regOutput(HKLM, 'C:\\m') })
      .on(HKCU, { code: 1, stdout: '' });
    const result = await clientSearchEnv(
      { PATH: 'C:\\p' },
      { mode: 'merge', platform: 'win32', run: run.run },
    );
    expect(result.env).toEqual({ PATH: 'C:\\p;C:\\m' });
    // Code 1 is a key with no Path value: nothing to add, and not a failure.
    expect(result.failed).toEqual([]);
  });

  it('names a key whose read failed and goes on with the others', async () => {
    const run = new FakeCommandRunner()
      .on(HKLM, { code: 5, stdout: '', stderr: 'Access is denied.' })
      .on(HKCU, { stdout: regOutput(HKCU, 'C:\\u') });
    const result = await clientSearchEnv(
      { Path: 'C:\\p' },
      { mode: 'merge', platform: 'win32', run: run.run },
    );
    expect(result.failed).toEqual([HKLM]);
    expect(result.env.Path).toBe('C:\\p;C:\\u');

    const gone = new FakeCommandRunner().on('reg', { code: -1, spawnFailed: true });
    const none = await clientSearchEnv(
      { Path: 'C:\\p' },
      { mode: 'merge', platform: 'win32', run: gone.run },
    );
    expect(none.failed).toEqual([HKLM, HKCU]);
    expect(none.env).toEqual({ Path: 'C:\\p' });
    expect(none.added).toBe(0);
  });

  it('keeps the same env object when the registry adds nothing', async () => {
    const run = new FakeCommandRunner().on('reg', { stdout: regOutput(HKLM, 'c:\\p\\') });
    const env = { Path: 'C:\\p' };
    const result = await clientSearchEnv(env, { mode: 'merge', platform: 'win32', run: run.run });
    expect(result.env).toBe(env);
    expect(result.added).toBe(0);
  });
});
