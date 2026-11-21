// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DAEMON_EVENT_DEFINITIONS } from './events.js';
import { TelemetryStoreResetPayloadSchema } from './telemetry-events.js';

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
