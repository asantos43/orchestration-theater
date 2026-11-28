// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { DEFAULT_WORKFLOWS_SETTINGS } from './config.js';

describe('the workflows block of the configuration', () => {
  it('has the defaults of DEFAULT_WORKFLOWS_SETTINGS when absent', () => {
    expect(parseConfig('').workflows).toEqual(DEFAULT_WORKFLOWS_SETTINGS);
  });

  it('takes every key', () => {
    const config = parseConfig(
      [
        'workflows:',
        '  default: review-loop',
        '  allowed: [play, review-loop]',
        '  budget:',
        '    on_exhausted: stop',
        '    period: week',
        '  binding:',
        '    concurrency: 3',
        '    on_busy: replace',
        '',
      ].join('\n'),
    );
    expect(config.workflows).toEqual({
      default: 'review-loop',
      allowed: ['play', 'review-loop'],
      budget: { on_exhausted: 'stop', period: 'week' },
      binding: { concurrency: 3, on_busy: 'replace' },
    });
  });

  it('allowed takes all_installed or a non-empty list of workflow ids', () => {
    expect(parseConfig('workflows:\n  allowed: all_installed\n').workflows.allowed).toBe(
      'all_installed',
    );
    expect(() => parseConfig('workflows:\n  allowed: []\n')).toThrow();
    expect(() => parseConfig('workflows:\n  allowed: [Not A Workflow]\n')).toThrow();
    expect(() => parseConfig('workflows:\n  allowed: everything\n')).toThrow();
  });

  it('refuses unknown modes, bad limits and unknown keys', () => {
    expect(() => parseConfig('workflows:\n  budget:\n    on_exhausted: ignore\n')).toThrow();
    expect(() => parseConfig('workflows:\n  budget:\n    period: year\n')).toThrow();
    expect(() => parseConfig('workflows:\n  binding:\n    concurrency: 0\n')).toThrow();
    expect(() => parseConfig('workflows:\n  binding:\n    on_busy: drop\n')).toThrow();
    expect(() => parseConfig('workflows:\n  nothing: 1\n')).toThrow();
  });
});
