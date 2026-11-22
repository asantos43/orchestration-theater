// SPDX-License-Identifier: MPL-2.0
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_PROJECT_DIR_ENV, pluginProjectDirectory } from './environment.js';

describe('pluginProjectDirectory', () => {
  const project = resolve('/projects/one');

  it('is the variable of the daemon when it is set', () => {
    expect(
      pluginProjectDirectory({ [PLUGIN_PROJECT_DIR_ENV]: project }, resolve('/elsewhere')),
    ).toBe(project);
  });

  it('falls back to the working directory, for a plugin started by hand', () => {
    expect(pluginProjectDirectory({}, resolve('/elsewhere'))).toBe(resolve('/elsewhere'));
  });

  it('refuses an empty or relative value instead of guessing', () => {
    expect(() => pluginProjectDirectory({ [PLUGIN_PROJECT_DIR_ENV]: '' })).toThrow(/absolute/);
    expect(() => pluginProjectDirectory({ [PLUGIN_PROJECT_DIR_ENV]: 'here/there' })).toThrow(
      /absolute/,
    );
  });
});
