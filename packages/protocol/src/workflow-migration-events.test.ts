// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_MIGRATION_REFUSALS,
  WorkflowMigratedPayloadSchema,
  WorkflowMigrationRefusedPayloadSchema,
} from './workflow-migration-events.js';

const ref = (version: string) => ({ id: 'ticket', version });

describe('workflow.migrated payload', () => {
  const valid = {
    runId: 'run-1',
    from: ref('2.0.0'),
    to: ref('2.1.0'),
    fromState: 'review',
    toState: 'check',
    trigger: 'request',
    droppedLimits: [],
  };

  it('takes a complete payload and refuses a missing field, another trigger and an extra field', () => {
    const parse = (value: unknown) => WorkflowMigratedPayloadSchema.safeParse(value);
    expect(parse(valid).success).toBe(true);
    expect(parse({ ...valid, trigger: 'activation', droppedLimits: ['retries'] }).success).toBe(
      true,
    );
    expect(parse({ ...valid, toState: undefined }).success).toBe(false);
    expect(parse({ ...valid, trigger: 'cron' }).success).toBe(false);
    expect(parse({ ...valid, extra: 1 }).success).toBe(false);
  });
});

describe('workflow.migration_refused payload', () => {
  const valid = {
    runId: 'run-1',
    from: ref('2.0.0'),
    toVersion: '2.1.0',
    trigger: 'activation',
    reason: 'no_mapping',
  };

  it('takes every reason and refuses another one', () => {
    const parse = (value: unknown) => WorkflowMigrationRefusedPayloadSchema.safeParse(value);
    for (const reason of WORKFLOW_MIGRATION_REFUSALS) {
      expect(parse({ ...valid, reason }).success).toBe(true);
    }
    expect(parse({ ...valid, reason: 'because' }).success).toBe(false);
    expect(parse({ ...valid, detail: 'x'.repeat(501) }).success).toBe(false);
    expect(parse({ ...valid, extra: 1 }).success).toBe(false);
  });
});
