// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  defaultLayout,
  getLayout,
  LAYOUT_INTERFACES,
  LAYOUT_VERSION,
  LayoutInterfaceSchema,
  LayoutPreferencesSchema,
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
