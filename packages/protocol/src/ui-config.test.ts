// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  UiClipboardConfigSchema,
  UiKeymapConfigSchema,
  UiMouseModeSchema,
  UiRenderConfigSchema,
  UiRuntimeConfigSchema,
} from './ui-config.js';

describe('ui.* schemas of the terminal', () => {
  it('has the defaults of architecture 5.13', () => {
    expect(UiKeymapConfigSchema.parse({})).toEqual({
      preset: 'agents',
      environment: 'auto',
      overrides: {},
    });
    expect(UiClipboardConfigSchema.parse({})).toEqual({ copy: 'osc52' });
    expect(UiRenderConfigSchema.parse({})).toEqual({
      keyRender: 'flush',
      maxFps: 30,
      coalesceMs: 16,
      memo: true,
      inkPatches: ['cache', 'grid'],
      historyWindow: 0,
    });
    expect(UiRuntimeConfigSchema.parse({})).toEqual({ maxSemiSpaceMB: 2 });
  });

  it('takes every mode of the mouse and refuses the rest', () => {
    for (const mode of ['full', 'wheel', 'off']) expect(UiMouseModeSchema.parse(mode)).toBe(mode);
    expect(UiMouseModeSchema.safeParse('some').success).toBe(false);
  });

  it('refuses a shortcut that is not a key combination, and unknown keys', () => {
    expect(UiKeymapConfigSchema.safeParse({ overrides: { 'tabs.add': 'Alt+Foo' } }).success).toBe(
      false,
    );
    expect(
      UiKeymapConfigSchema.safeParse({ overrides: { 'tabs.add': ['Alt+T', 'F2'] } }).success,
    ).toBe(true);
    expect(UiKeymapConfigSchema.safeParse({ overrides: { 'tabs.add': [] } }).success).toBe(true);
    expect(UiKeymapConfigSchema.safeParse({ preset: 'vim' }).success).toBe(false);
    expect(UiRenderConfigSchema.safeParse({ speed: 1 }).success).toBe(false);
    expect(UiRenderConfigSchema.safeParse({ maxFps: 0 }).success).toBe(false);
    expect(UiRenderConfigSchema.safeParse({ inkPatches: ['grid', 'grid'] }).success).toBe(false);
    expect(UiRenderConfigSchema.safeParse({ inkPatches: [] }).success).toBe(true);
    expect(UiRuntimeConfigSchema.safeParse({ maxOldSpaceMB: 0 }).success).toBe(false);
    expect(UiRuntimeConfigSchema.parse({ maxOldSpaceMB: 512 }).maxOldSpaceMB).toBe(512);
  });
});
