// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  buildDaemonEvent,
  validateEventPayload,
  type DeliveryCompletedPayload,
  type WorkspaceIntegratedPayload,
  type WorkspaceIntegrationFailedPayload,
} from './events.js';
import {
  DeliveryCompletedPayloadSchema,
  WorkspaceIntegratedPayloadSchema,
  WorkspaceIntegrationFailedPayloadSchema,
} from './workspace-events.js';

const sha = 'a'.repeat(40);

describe('workspace and delivery event payloads (architecture 5.5)', () => {
  it('accepts an integration with its merged attempts', () => {
    const payload = {
      playId: 'play-1',
      branch: 'play/play-1/integration',
      head: sha,
      merged: [{ demandId: 'd1', attempt: 1, branch: 'play/play-1/attempts/d1/1', sha }],
    };
    expect(WorkspaceIntegratedPayloadSchema.parse(payload)).toEqual(payload);
    expect(buildDaemonEvent('workspace.integrated', payload).type).toBe('workspace.integrated');
  });

  it('carries the scenario in the three events of a play, and still reads the ones logged without it (N172)', () => {
    const integrated: WorkspaceIntegratedPayload = {
      playId: 'play-1',
      branch: 'play/play-1/integration',
      head: sha,
      merged: [],
    };
    const failed: WorkspaceIntegrationFailedPayload = {
      playId: 'play-1',
      branch: 'play/play-1/integration',
      cause: 'merge_conflict',
      demandId: 'd2',
      attempt: 2,
      conflictFiles: ['shared.txt'],
      mergedSoFar: [],
    };
    const delivered: DeliveryCompletedPayload = {
      playId: 'play-1',
      mode: 'pr',
      requestedMode: 'pr',
      requestedBy: 'config',
      downgraded: false,
      branch: 'play/play-1/integration',
      base: 'main',
      pushedSha: sha,
    };
    for (const [type, payload] of [
      ['workspace.integrated', integrated],
      ['workspace.integration_failed', failed],
      ['delivery.completed', delivered],
    ] as const) {
      const scoped = { ...payload, scenarioId: 'scn-1' };
      // Same schemaVersion 1: the field is additive.
      expect(validateEventPayload(type, 1, scoped)).toEqual(scoped);
      expect(buildDaemonEvent(type, scoped).payload).toMatchObject({ scenarioId: 'scn-1' });
      // A payload logged before N172 has no `scenarioId` and stays valid.
      expect(validateEventPayload(type, 1, payload)).toEqual(payload);
      expect(() => validateEventPayload(type, 1, { ...scoped, scenarioId: '' })).toThrow();
      expect(() => validateEventPayload(type, 2, scoped)).toThrow();
    }
  });

  it('accepts a merge conflict and rejects any other cause', () => {
    const payload = {
      playId: 'play-1',
      branch: 'play/play-1/integration',
      cause: 'merge_conflict',
      demandId: 'd2',
      attempt: 2,
      conflictFiles: ['shared.txt'],
      mergedSoFar: ['d1'],
    };
    expect(WorkspaceIntegrationFailedPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      WorkspaceIntegrationFailedPayloadSchema.safeParse({ ...payload, cause: 'other' }).success,
    ).toBe(false);
  });

  it('accepts a PR delivery and a direct merge, and records who asked', () => {
    const pr = {
      playId: 'play-1',
      mode: 'pr',
      requestedMode: 'direct_merge',
      requestedBy: 'play',
      downgraded: true,
      reason: 'direct_merge_not_allowed',
      branch: 'play/play-1/integration',
      base: 'main',
      pushedSha: sha,
      pullRequest: { number: 7, url: 'https://example.invalid/pull/7' },
    };
    expect(DeliveryCompletedPayloadSchema.parse(pr)).toEqual(pr);
    const direct = {
      playId: 'play-1',
      mode: 'direct_merge',
      requestedMode: 'direct_merge',
      requestedBy: 'task',
      downgraded: false,
      branch: 'play/play-1/integration',
      base: 'main',
      pushedSha: sha,
      mergeSha: sha,
    };
    expect(DeliveryCompletedPayloadSchema.parse(direct)).toEqual(direct);
  });

  it('rejects unknown fields, "ask" as the outcome and an unknown requester', () => {
    const payload = {
      playId: 'play-1',
      mode: 'pr',
      requestedMode: 'pr',
      requestedBy: 'config',
      downgraded: false,
      branch: 'b',
      base: 'main',
      pushedSha: sha,
    };
    expect(DeliveryCompletedPayloadSchema.safeParse({ ...payload, extra: 1 }).success).toBe(false);
    expect(DeliveryCompletedPayloadSchema.safeParse({ ...payload, mode: 'ask' }).success).toBe(
      false,
    );
    expect(
      DeliveryCompletedPayloadSchema.safeParse({ ...payload, requestedBy: 'someone' }).success,
    ).toBe(false);
    expect(() => validateEventPayload('delivery.completed', 1, { ...payload, extra: 1 })).toThrow();
  });
});
