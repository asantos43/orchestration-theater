// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DAEMON_EVENT_DEFINITIONS } from './events.js';
import {
  TelemetryBatchRejectedPayloadSchema,
  TelemetryReceiverStartedPayloadSchema,
  TelemetryRedactedPayloadSchema,
  TelemetryStoreResetPayloadSchema,
} from './telemetry-events.js';

describe('telemetry.store_reset', () => {
  const ok = {
    reason: 'corrupt',
    outcome: 'recreated',
    brokenFile: 'telemetry.sqlite.broken-20261121-153000',
    resets: 1,
  };

  it('is in the event catalog at schemaVersion 1', () => {
    const def = DAEMON_EVENT_DEFINITIONS.find((d) => d.type === 'telemetry.store_reset');
    expect(def?.schemaVersion).toBe(1);
  });

  it('accepts a payload without content', () => {
    expect(TelemetryStoreResetPayloadSchema.parse(ok)).toEqual(ok);
    expect(
      TelemetryStoreResetPayloadSchema.safeParse({
        ...ok,
        brokenFile: null,
        outcome: 'unavailable',
      }).success,
    ).toBe(true);
  });

  it('refuses unknown fields, unknown reasons and negative counts', () => {
    expect(TelemetryStoreResetPayloadSchema.safeParse({ ...ok, error: 'x' }).success).toBe(false);
    expect(TelemetryStoreResetPayloadSchema.safeParse({ ...ok, reason: 'other' }).success).toBe(
      false,
    );
    expect(TelemetryStoreResetPayloadSchema.safeParse({ ...ok, resets: -1 }).success).toBe(false);
  });
});

describe('receiver events (P2)', () => {
  it('are in the event catalog at schemaVersion 1', () => {
    for (const type of [
      'telemetry.receiver_started',
      'telemetry.batch_rejected',
      'telemetry.redacted',
    ]) {
      expect(DAEMON_EVENT_DEFINITIONS.find((d) => d.type === type)?.schemaVersion).toBe(1);
    }
  });

  it('receiver_started carries only a valid port', () => {
    expect(TelemetryReceiverStartedPayloadSchema.safeParse({ port: 4318 }).success).toBe(true);
    expect(TelemetryReceiverStartedPayloadSchema.safeParse({ port: 0 }).success).toBe(false);
    expect(
      TelemetryReceiverStartedPayloadSchema.safeParse({ port: 4318, token: 'x' }).success,
    ).toBe(false);
  });

  it('batch_rejected names the reason and the signal, never the body', () => {
    const ok = { reason: 'token', signal: 'traces', count: 2 };
    expect(TelemetryBatchRejectedPayloadSchema.parse(ok)).toEqual(ok);
    expect(TelemetryBatchRejectedPayloadSchema.safeParse({ ...ok, signal: null }).success).toBe(
      true,
    );
    expect(TelemetryBatchRejectedPayloadSchema.safeParse({ ...ok, reason: 'other' }).success).toBe(
      false,
    );
    expect(TelemetryBatchRejectedPayloadSchema.safeParse({ ...ok, body: '{}' }).success).toBe(
      false,
    );
    expect(TelemetryBatchRejectedPayloadSchema.safeParse({ ...ok, count: 0 }).success).toBe(false);
  });

  it('redacted carries counts and attribute names only', () => {
    const ok = { mode: 'default', count: 5, records: 3, names: ['user.email', 'prompt'] };
    expect(TelemetryRedactedPayloadSchema.parse(ok)).toEqual(ok);
    expect(TelemetryRedactedPayloadSchema.safeParse({ ...ok, mode: 'off' }).success).toBe(false);
    expect(TelemetryRedactedPayloadSchema.safeParse({ ...ok, values: ['a@b.c'] }).success).toBe(
      false,
    );
  });
});
