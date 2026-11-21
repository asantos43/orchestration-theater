// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  UiClipboardConfigSchema,
  UiInputConfigSchema,
  UiKeymapConfigSchema,
  UiMouseModeSchema,
  UiRenderConfigSchema,
  UiRuntimeConfigSchema,
  UiTuiLayoutConfigSchema,
  UiTuiMouseConfigSchema,
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
    expect(UiTuiLayoutConfigSchema.parse({})).toEqual({
      sidebarWidth: 30,
      railWidth: 5,
      minChatWidth: 30,
      minPanelWidth: 30,
      chatStep: 2,
      scrollStep: 'half',
    });
  });

  it('refuses a measure of the layout out of its range and an unknown key', () => {
    expect(UiTuiLayoutConfigSchema.safeParse({ sidebarWidth: 4 }).success).toBe(false);
    expect(UiTuiLayoutConfigSchema.safeParse({ scrollStep: 'all' }).success).toBe(false);
    expect(UiTuiLayoutConfigSchema.safeParse({ chatStep: 0 }).success).toBe(false);
    expect(UiTuiLayoutConfigSchema.safeParse({ color: 'red' }).success).toBe(false);
    expect(UiTuiLayoutConfigSchema.parse({ scrollStep: 'line' }).scrollStep).toBe('line');
  });

  it('takes every mode of the mouse and refuses the rest', () => {
    for (const mode of ['full', 'wheel', 'off']) expect(UiMouseModeSchema.parse(mode)).toBe(mode);
    expect(UiMouseModeSchema.safeParse('some').success).toBe(false);
  });

  it('has the defaults of the mouse block, takes the auto copy mode and refuses what is out of range', () => {
    expect(UiTuiMouseConfigSchema.parse({})).toEqual({ wheelLines: 3, copyMaxBytes: 100_000 });
    expect(UiTuiMouseConfigSchema.safeParse({ wheelLines: 0 }).success).toBe(false);
    expect(UiTuiMouseConfigSchema.safeParse({ copyMaxBytes: 0 }).success).toBe(false);
    expect(UiTuiMouseConfigSchema.safeParse({ speed: 2 }).success).toBe(false);
    expect(UiTuiMouseConfigSchema.parse({ wheelLines: 5 }).wheelLines).toBe(5);
    for (const mode of ['osc52', 'system', 'auto', 'off'])
      expect(UiClipboardConfigSchema.parse({ copy: mode }).copy).toBe(mode);
    expect(UiClipboardConfigSchema.parse({}).copy).toBe('osc52');
    expect(UiClipboardConfigSchema.safeParse({ copy: 'paste' }).success).toBe(false);
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

  it('has the defaults of the text box and refuses what is out of range', () => {
    expect(UiInputConfigSchema.parse({})).toEqual({
      paste: { mode: 'marker', lines: 10, chars: 2000 },
      dropPaths: 'attach',
      history: { store: 'file', size: 500 },
      editor: 'auto',
      maxVisibleLines: 8,
      image: { tool: 'auto', timeoutMs: 3000, maxBytes: 20 * 1024 * 1024 },
    });
    expect(UiInputConfigSchema.parse({ image: { tool: 'wl-paste' } }).image.timeoutMs).toBe(3000);
    expect(UiInputConfigSchema.safeParse({ paste: { mode: 'always' } }).success).toBe(false);
    expect(UiInputConfigSchema.safeParse({ image: { tool: 'gimp' } }).success).toBe(false);
    expect(UiInputConfigSchema.safeParse({ maxVisibleLines: 0 }).success).toBe(false);
    expect(UiInputConfigSchema.safeParse({ speed: 1 }).success).toBe(false);
  });
});
