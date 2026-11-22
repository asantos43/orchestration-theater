// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { checkoutRoots, locateJobLauncher } from './locate.js';

const has =
  (...present: string[]) =>
  (path: string) =>
    present.includes(path);

describe('locateJobLauncher', () => {
  const execPath = 'C:\\Program Files\\OTheater\\ot.exe';
  const beside = 'C:\\Program Files\\OTheater\\ot-job-launcher.exe';
  const release = 'D:\\src\\ot\\native\\job-launcher\\target\\release\\ot-job-launcher.exe';
  const debug = 'D:\\src\\ot\\native\\job-launcher\\target\\debug\\ot-job-launcher.exe';

  it('prefers the launcher beside the executable', () => {
    expect(
      locateJobLauncher({ execPath, checkoutRoots: ['D:\\src\\ot'], exists: has(beside, release) }),
    ).toEqual({ found: true, path: beside });
  });

  it('then a checkout, release before debug', () => {
    const options = { execPath, checkoutRoots: ['D:\\src\\ot'] };
    expect(locateJobLauncher({ ...options, exists: has(release, debug) })).toEqual({
      found: true,
      path: release,
    });
    expect(locateJobLauncher({ ...options, exists: has(debug) })).toEqual({
      found: true,
      path: debug,
    });
  });

  it('with a configured path, tries only that one', () => {
    const configured = 'E:\\custom\\launcher.exe';
    expect(
      locateJobLauncher({ execPath, configuredPath: configured, exists: has(configured, beside) }),
    ).toEqual({ found: true, path: configured });
    expect(
      locateJobLauncher({ execPath, configuredPath: configured, exists: has(beside) }),
    ).toEqual({
      found: false,
      searched: [configured],
    });
  });

  it('ignores a relative path and lists what it searched when nothing is there', () => {
    expect(
      locateJobLauncher({ execPath, configuredPath: 'launcher.exe', exists: () => true }),
    ).toEqual({ found: false, searched: ['launcher.exe'] });
    expect(
      locateJobLauncher({ execPath, checkoutRoots: ['D:\\src\\ot'], exists: () => false }),
    ).toEqual({
      found: false,
      searched: [beside, release, debug],
    });
  });
});

describe('checkoutRoots', () => {
  it('is empty for a module that has no file (a single executable)', () => {
    expect(checkoutRoots('node:sea')).toEqual([]);
  });

  it('finds this checkout from its own sources', () => {
    expect(checkoutRoots()).toHaveLength(1);
  });
});
