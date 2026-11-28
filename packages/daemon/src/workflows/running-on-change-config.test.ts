// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { DEFAULT_WORKFLOWS_SETTINGS, WORKFLOW_RUNNING_ON_CHANGE_MODES } from './config.js';

/** `workflows.running_on_change` (Phase 11b, P4; N295): what an open run does when a version is activated. */
describe('workflows.running_on_change', () => {
  it('has the modes pin and migrate_at_safe_point, and pins by default', () => {
    expect([...WORKFLOW_RUNNING_ON_CHANGE_MODES]).toEqual(['pin', 'migrate_at_safe_point']);
    expect(DEFAULT_WORKFLOWS_SETTINGS.running_on_change).toBe('pin');
    expect(parseConfig('').workflows.running_on_change).toBe('pin');
  });

  it('takes migrate_at_safe_point and refuses any other mode', () => {
    expect(
      parseConfig('workflows:\n  running_on_change: migrate_at_safe_point\n').workflows
        .running_on_change,
    ).toBe('migrate_at_safe_point');
    expect(() => parseConfig('workflows:\n  running_on_change: migrate\n')).toThrow();
  });
});
