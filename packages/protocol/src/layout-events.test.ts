// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { LayoutAdjustedPayloadSchema } from './layout-events.js';
import { validateEventPayload } from './events.js';

describe('layout.adjusted', () => {
  it('takes a migration and a replacement, and nothing else', () => {
    const migrated = {
      interface: 'tui',
      action: 'migrated',
      reason: null,
      fromVersion: 1,
      kept: false,
    };
    const replaced = {
      interface: 'web',
      action: 'replaced',
      reason: 'invalid',
      fromVersion: null,
      kept: true,
    };
    expect(LayoutAdjustedPayloadSchema.parse(migrated)).toEqual(migrated);
    expect(validateEventPayload('layout.adjusted', 1, replaced)).toEqual(replaced);
    for (const bad of [
      { ...replaced, interface: 'ios' },
      { ...replaced, reason: 'other' },
      { ...replaced, fromVersion: 0 },
      { ...replaced, extra: 1 },
    ]) {
      expect(LayoutAdjustedPayloadSchema.safeParse(bad).success).toBe(false);
    }
  });
});
