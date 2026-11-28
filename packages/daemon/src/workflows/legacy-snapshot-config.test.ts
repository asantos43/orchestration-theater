// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { DEFAULT_WORKFLOWS_SETTINGS, WORKFLOW_LEGACY_SNAPSHOT_MODES } from './config.js';

/** `workflows.legacy_snapshot` (Phase 11b, P3; D2/N311): what start-up does with a play of the 1.x. */
describe('workflows.legacy_snapshot', () => {
  it('has the modes reject and cancel, and rejects by default', () => {
    expect([...WORKFLOW_LEGACY_SNAPSHOT_MODES]).toEqual(['reject', 'cancel']);
    expect(DEFAULT_WORKFLOWS_SETTINGS.legacy_snapshot).toBe('reject');
    expect(parseConfig('').workflows.legacy_snapshot).toBe('reject');
  });

  it('takes cancel and refuses any other mode', () => {
    expect(parseConfig('workflows:\n  legacy_snapshot: cancel\n').workflows.legacy_snapshot).toBe(
      'cancel',
    );
    expect(() => parseConfig('workflows:\n  legacy_snapshot: migrate\n')).toThrow();
  });
});
