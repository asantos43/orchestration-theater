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
      version: 2,
      sidebarCollapsed: true,
      chatWidth: 80,
      openTabs: ['overview', 'usage'],
      collapsedSections: ['scenarios'],
    };
    expect(LayoutPreferencesSchema.parse(good)).toEqual(good);
    expect(LayoutPreferencesSchema.parse({ ...good, sidebarWidth: 36 })).toEqual({
      ...good,
      sidebarWidth: 36,
    });
    for (const bad of [
      { ...good, version: 1 },
      { ...good, version: 3 },
      { ...good, chatWidth: 0 },
      { ...good, chatWidth: 1.5 },
      { ...good, sidebarWidth: 0 },
      { ...good, sidebarWidth: 30.5 },
      { ...good, sidebarWidth: '30' },
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
    version: 2,
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
      [{ ...good, version: 3 }, 'newer_version', 3],
      [{ ...good, version: 0 }, 'invalid', null],
      [{ ...good, version: 1.5 }, 'invalid', null],
      [{ ...good, chatWidth: 0 }, 'invalid', 2],
      [{ ...good, extra: true }, 'invalid', 2],
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

  it('has one step today: 1 to 2 (N277), which adds the optional width of the side bar', () => {
    expect(LAYOUT_VERSION).toBe(2);
    expect(Object.keys(LAYOUT_MIGRATIONS)).toEqual(['1']);
  });

  it('migrates a version 1 record: every field is kept, the width of the side bar stays absent', () => {
    const { version: _version, ...fields } = good;
    const old = { version: 1, ...fields };
    const reading = readLayout('tui', old);
    expect(reading).toEqual({
      outcome: 'migrated',
      layout: { ...fields, version: 2 },
      fromVersion: 1,
    });
    expect(reading.layout.sidebarWidth).toBeUndefined();
    expect(readLayoutText('web', JSON.stringify(old))).toMatchObject({
      outcome: 'migrated',
      fromVersion: 1,
    });
  });

  it('migrates a version 1 record that is not valid to the default, as old_version', () => {
    const { version: _version, ...fields } = good;
    expect(readLayout('tui', { version: 1, ...fields, chatWidth: 0 })).toEqual({
      outcome: 'replaced',
      layout: defaultLayout('tui'),
      reason: 'old_version',
      fromVersion: 1,
    });
  });

  it('keeps the width of the side bar when it is there, and refuses one that does not fit', () => {
    expect(readLayout('tui', { ...good, sidebarWidth: 44 })).toEqual({
      outcome: 'ok',
      layout: { ...good, sidebarWidth: 44 },
    });
    expect(readLayout('tui', { ...good, sidebarWidth: 0 })).toMatchObject({ outcome: 'replaced' });
  });

  it('has no width of the side bar in the default of any interface', () => {
    for (const layoutInterface of LAYOUT_INTERFACES) {
      expect(defaultLayout(layoutInterface).sidebarWidth).toBeUndefined();
    }
  });
});
