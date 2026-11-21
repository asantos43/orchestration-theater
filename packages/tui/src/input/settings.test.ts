// SPDX-License-Identifier: MPL-2.0
import { UiInputConfigSchema } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_SETTINGS, parseInputSettings } from './settings.js';

describe('the settings of the text box', () => {
  it('repeats the defaults of the schema of the daemon', () => {
    expect(DEFAULT_INPUT_SETTINGS).toEqual(UiInputConfigSchema.parse({}));
    expect(parseInputSettings(undefined)).toEqual(DEFAULT_INPUT_SETTINGS);
  });

  it('reads valid values, in part, and keeps the defaults for the rest', () => {
    const settings = parseInputSettings({
      paste: { mode: 'inline', lines: 3 },
      history: { store: 'memory' },
      editor: 'off',
      image: { tool: 'xclip', timeoutMs: 500 },
    });
    expect(settings.paste).toEqual({ mode: 'inline', lines: 3, chars: 2000 });
    expect(settings.history).toEqual({ store: 'memory', size: 500 });
    expect(settings.editor).toBe('off');
    expect(settings.image.tool).toBe('xclip');
    expect(settings.image.timeoutMs).toBe(500);
    expect(settings.dropPaths).toBe('attach');
  });

  it('never throws on invalid values: each one falls back to the default', () => {
    const settings = parseInputSettings({
      paste: { mode: 'sideways', lines: -1, chars: 'many' },
      history: { size: 0 },
      maxVisibleLines: 1000,
      image: { tool: 7, timeoutMs: 5 },
      dropPaths: null,
    });
    expect(settings).toEqual(DEFAULT_INPUT_SETTINGS);
    expect(parseInputSettings('text')).toEqual(DEFAULT_INPUT_SETTINGS);
    expect(parseInputSettings([1, 2])).toEqual(DEFAULT_INPUT_SETTINGS);
  });
});
