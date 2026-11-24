// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { defaultLayout } from './api/layout.js';
import { LayoutAdjustedPayloadSchema, LayoutChangedPayloadSchema } from './layout-events.js';
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

describe('layout.changed', () => {
  const changed = { interface: 'web', origin: 'client-1', layout: defaultLayout('web') };

  it('takes the whole record and the client that wrote it, or no client', () => {
    expect(LayoutChangedPayloadSchema.parse(changed)).toEqual(changed);
    expect(validateEventPayload('layout.changed', 1, { ...changed, origin: null })).toEqual({
      ...changed,
      origin: null,
    });
    for (const bad of [
      { ...changed, interface: 'ios' },
      { ...changed, origin: '' },
      { ...changed, origin: 'a b' },
      { ...changed, origin: 'x'.repeat(65) },
      { ...changed, layout: { ...changed.layout, chatWidth: 0 } },
      { ...changed, layout: { ...changed.layout, version: 3 } },
      { ...changed, extra: 1 },
      { interface: 'web', layout: changed.layout },
    ]) {
      expect(LayoutChangedPayloadSchema.safeParse(bad).success).toBe(false);
    }
  });
});
