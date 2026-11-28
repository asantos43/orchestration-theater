// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { DEFAULT_WORKFLOW_PACKAGES_SETTINGS, workflowPackagesSettings } from './config.js';
import { generateTestKey } from './packages.test-support.js';

describe('workflows.packages', () => {
  it('the defaults of the configuration are the defaults of the installer', () => {
    expect(workflowPackagesSettings(parseConfig('').workflows)).toEqual(
      DEFAULT_WORKFLOW_PACKAGES_SETTINGS,
    );
  });

  it('reads the keys of the plan and the durations', () => {
    const key = generateTestKey().publicLine;
    const config = parseConfig(
      [
        'workflows:',
        '  packages:',
        '    sources: git',
        '    signature: require',
        `    trusted_keys: ["${key} author@example.invalid"]`,
        '    unsigned: reject',
        '    activate: always',
        '    fetch_timeout: 30s',
        '    verify_timeout: 5s',
        '    max_workflows: 3',
        '    ssh_keygen: /usr/bin/ssh-keygen',
        '',
      ].join('\n'),
    );
    expect(workflowPackagesSettings(config.workflows)).toEqual({
      sources: ['git'],
      signature: 'require',
      trusted_keys: [`${key} author@example.invalid`],
      unsigned: 'reject',
      activate: 'always',
      fetch_timeout: 30_000,
      verify_timeout: 5_000,
      max_workflows: 3,
      ssh_keygen: '/usr/bin/ssh-keygen',
    });
  });

  it('accepts a list of sources and removes the repeated one', () => {
    const config = parseConfig('workflows:\n  packages:\n    sources: [file, git, file]\n');
    expect(workflowPackagesSettings(config.workflows).sources).toEqual(['file', 'git']);
  });

  it('rejects an unknown mode, a key that is not a public key and an unknown key', () => {
    expect(() => parseConfig('workflows:\n  packages:\n    signature: maybe\n')).toThrow(
      /signature/,
    );
    expect(() => parseConfig('workflows:\n  packages:\n    unsigned: accept\n')).toThrow(
      /unsigned/,
    );
    expect(() => parseConfig('workflows:\n  packages:\n    sources: npm\n')).toThrow(/sources/);
    expect(() => parseConfig('workflows:\n  packages:\n    trusted_keys: ["not a key"]\n')).toThrow(
      /trusted_keys/,
    );
    expect(() => parseConfig('workflows:\n  packages:\n    nothing: 1\n')).toThrow(/nothing/);
  });
});
