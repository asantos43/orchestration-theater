// SPDX-License-Identifier: MPL-2.0
import { UiOverviewConfigSchema, UiUsageConfigSchema } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERVIEW_SETTINGS,
  DEFAULT_USAGE_SETTINGS,
  parseOverviewSettings,
  parseUsageSettings,
} from './settings.js';

describe('the settings of the Overview and Usage tabs', () => {
  it('repeat the defaults of the schemas of the daemon', () => {
    expect(DEFAULT_OVERVIEW_SETTINGS).toEqual(UiOverviewConfigSchema.parse({}));
    expect(DEFAULT_USAGE_SETTINGS).toEqual(UiUsageConfigSchema.parse({}));
    expect(parseOverviewSettings(undefined)).toEqual(DEFAULT_OVERVIEW_SETTINGS);
    expect(parseUsageSettings(undefined)).toEqual(DEFAULT_USAGE_SETTINGS);
  });

  it('read valid values and keep the defaults for the rest', () => {
    expect(parseOverviewSettings({ confirm: 'off', recentEvents: 3 })).toEqual({
      confirm: 'off',
      recentEvents: 3,
      hiddenEvents: ['session.update'],
    });
    expect(parseOverviewSettings({ hiddenEvents: [] }).hiddenEvents).toEqual([]);
    expect(parseUsageSettings({ groupBy: 'executor' })).toEqual({ groupBy: 'executor' });
  });

  it('never throw on invalid values', () => {
    expect(parseOverviewSettings({ confirm: 'maybe', recentEvents: 0, hiddenEvents: [1] })).toEqual(
      DEFAULT_OVERVIEW_SETTINGS,
    );
    expect(parseOverviewSettings('text')).toEqual(DEFAULT_OVERVIEW_SETTINGS);
    expect(parseUsageSettings({ groupBy: 4 })).toEqual(DEFAULT_USAGE_SETTINGS);
  });
});
