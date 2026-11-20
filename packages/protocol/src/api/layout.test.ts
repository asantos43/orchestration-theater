// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  defaultLayout,
  getLayout,
  LAYOUT_INTERFACES,
  LAYOUT_VERSION,
  LayoutInterfaceSchema,
  readLayout,
  readLayoutText,
  LAYOUT_MIGRATIONS,
  LayoutPreferencesSchema,
  moveRecordUp,
  putLayout,
} from './layout.js';
import { routePath } from './route.js';

describe('LayoutPreferencesSchema', () => {
  it('round-trips the default of each interface', () => {
    for (const layoutInterface of LAYOUT_INTERFACES) {
      const layout = defaultLayout(layoutInterface);
      expect(layout.version).toBe(LAYOUT_VERSION);
      expect(LayoutPreferencesSchema.parse(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    }
  });

  it('refuses another version, a bad width, a wrong type and extra fields', () => {
    const good = {
      version: 1,
      sidebarCollapsed: true,
      chatWidth: 80,
      openTabs: ['overview', 'usage'],
      collapsedSections: ['scenarios'],
    };
    expect(LayoutPreferencesSchema.parse(good)).toEqual(good);
    for (const bad of [
      { ...good, version: 2 },
      { ...good, chatWidth: 0 },
      { ...good, chatWidth: 1.5 },
      { ...good, sidebarCollapsed: 'yes' },
      { ...good, openTabs: [''] },
      { ...good, extra: 1 },
    ]) {
      expect(LayoutPreferencesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the interface and the routes', () => {
  it('knows tui and web only', () => {
    expect(LayoutInterfaceSchema.safeParse('tui').success).toBe(true);
    expect(LayoutInterfaceSchema.safeParse('web').success).toBe(true);
    expect(LayoutInterfaceSchema.safeParse('android').success).toBe(false);
  });

  it('declares GET and PUT of /v1/layout/:interface', () => {
    expect(getLayout.method).toBe('GET');
    expect(putLayout.method).toBe('PUT');
    expect(routePath(getLayout, { interface: 'tui' })).toBe('/v1/layout/tui');
    expect(putLayout.body).toBe(LayoutPreferencesSchema);
    expect(getLayout.params.safeParse({ interface: 'ios' }).success).toBe(false);
  });
});

describe('readLayout: what a record of any age becomes', () => {
  const good = {
    version: 1,
    sidebarCollapsed: true,
    chatWidth: 80,
    openTabs: ['overview', 'usage'],
    collapsedSections: ['scenarios'],
  };

  it('keeps a valid record of the current version', () => {
    expect(readLayout('tui', good)).toEqual({ outcome: 'ok', layout: good });
    expect(readLayoutText('web', JSON.stringify(good))).toEqual({ outcome: 'ok', layout: good });
  });

  it('replaces by the default of the interface what it cannot use, and says why', () => {
    const cases: [unknown, string, number | null][] = [
      [{ ...good, version: 2 }, 'newer_version', 2],
      [{ ...good, version: 0 }, 'invalid', null],
      [{ ...good, version: 1.5 }, 'invalid', null],
      [{ ...good, chatWidth: 0 }, 'invalid', 1],
      [{ ...good, extra: true }, 'invalid', 1],
      [{ sidebarCollapsed: true }, 'invalid', null],
      [['not', 'a', 'record'], 'invalid', null],
      [null, 'invalid', null],
      ['text', 'invalid', null],
    ];
    for (const [raw, reason, fromVersion] of cases) {
      expect(readLayout('web', raw), JSON.stringify(raw)).toEqual({
        outcome: 'replaced',
        layout: defaultLayout('web'),
        reason,
        fromVersion,
      });
    }
  });

  it('treats text that is not JSON as invalid, never throws', () => {
    for (const text of ['', '{', 'undefined', '{"version":1']) {
      expect(readLayoutText('tui', text)).toMatchObject({
        outcome: 'replaced',
        reason: 'invalid',
        fromVersion: null,
      });
    }
  });

  it('moves a record up one version at a time, with the steps it is given', () => {
    const steps = {
      1: (old: Readonly<Record<string, unknown>>) => ({ ...old, a: 1 }),
      2: (old: Readonly<Record<string, unknown>>) => ({ ...old, b: [old.a] }),
    };
    expect(moveRecordUp({ version: 1 }, 3, steps)).toEqual({
      ok: true,
      record: { version: 3, a: 1, b: [1] },
      fromVersion: 1,
    });
    expect(moveRecordUp({ version: 2, a: 5 }, 3, steps)).toMatchObject({
      ok: true,
      record: { version: 3, b: [5] },
    });
    expect(moveRecordUp({ version: 3 }, 3, steps)).toMatchObject({ ok: true, fromVersion: 3 });
  });

  it('does not move a record with a missing or failing step, or a newer one', () => {
    expect(moveRecordUp({ version: 1 }, 3, { 1: (old) => old })).toEqual({
      ok: false,
      reason: 'old_version',
      fromVersion: 1,
    });
    const throwing = {
      1: () => {
        throw new Error('bad');
      },
    };
    expect(moveRecordUp({ version: 1 }, 2, throwing)).toEqual({
      ok: false,
      reason: 'old_version',
      fromVersion: 1,
    });
    expect(moveRecordUp({ version: 4 }, 3, {})).toEqual({
      ok: false,
      reason: 'newer_version',
      fromVersion: 4,
    });
  });

  it('has no step today: version 1 is the first, so the table is empty', () => {
    expect(LAYOUT_VERSION).toBe(1);
    expect(Object.keys(LAYOUT_MIGRATIONS)).toEqual([]);
  });
});
