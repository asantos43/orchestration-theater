// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_LEGACY_SNAPSHOT_MODES,
  WorkflowSnapshotRejectedPayloadSchema,
} from './workflow-snapshot-events.js';

describe('workflow.snapshot_rejected payload', () => {
  const valid = { flowId: 'play', savedVersion: 1, currentVersion: 2, mode: 'reject' };

  it('takes both modes', () => {
    expect([...WORKFLOW_LEGACY_SNAPSHOT_MODES]).toEqual(['reject', 'cancel']);
    for (const mode of WORKFLOW_LEGACY_SNAPSHOT_MODES) {
      expect(WorkflowSnapshotRejectedPayloadSchema.safeParse({ ...valid, mode }).success).toBe(
        true,
      );
    }
  });

  it('refuses another mode, a missing field, a version below 1 and an extra field', () => {
    const parse = (value: unknown) => WorkflowSnapshotRejectedPayloadSchema.safeParse(value);
    expect(parse({ ...valid, mode: 'migrate' }).success).toBe(false);
    expect(parse({ flowId: 'play', savedVersion: 1, mode: 'reject' }).success).toBe(false);
    expect(parse({ ...valid, savedVersion: 0 }).success).toBe(false);
    expect(parse({ ...valid, flowId: '' }).success).toBe(false);
    expect(parse({ ...valid, extra: true }).success).toBe(false);
  });
});
