// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { applyHotSections, isHotPath, splitByReload } from './config-hot.js';
import { executionSettingsOf } from './execution/settings.js';

describe('hot reload of the configuration (N188)', () => {
  it('knows the hot sections by the head of the path', () => {
    expect(isHotPath('limits.preset')).toBe(true);
    expect(isHotPath('ui.locale')).toBe(true);
    expect(isHotPath('chat.presence')).toBe(true);
    expect(isHotPath('roles.reviewer.executors')).toBe(true);
    expect(isHotPath('pool.max_sessions')).toBe(false);
    expect(isHotPath('api.idempotency_ttl')).toBe(false);
    expect(splitByReload(['limits.preset', 'pool.idle', 'ui.locale'])).toEqual({
      hot: ['limits.preset', 'ui.locale'],
      restart: ['pool.idle'],
    });
  });

  it('copies the hot sections in place and leaves the other ones alone', () => {
    const live = parseConfig('pool:\n  max_sessions: 3\nroles:\n  reviewer:\n    executors: [sonnet-high@claude-code/work, opus-high@claude-code/work]\n');
    const limits = live.limits;
    const next = parseConfig(
      'pool:\n  max_sessions: 9\nlimits:\n  preset: persistent\nroles:\n  reviewer:\n    executors: [opus-high@claude-code/work, sonnet-high@claude-code/work]\n    when_exhausted: wait\n',
    );
    applyHotSections(live, next);
    expect(live.limits.preset).toBe('persistent');
    // The very object the services hold changed, not a copy.
    expect(limits.preset).toBe('persistent');
    expect(live.roles.reviewer?.executors).toEqual(['opus-high@claude-code/work', 'sonnet-high@claude-code/work']);
    expect(live.roles.reviewer?.when_exhausted).toBe('wait');
    expect(live.pool.max_sessions).toBe(3);
  });

  it('drops a key the new file no longer has', () => {
    const live = parseConfig('roles:\n  reviewer:\n    when_exhausted: wait\n');
    applyHotSections(live, parseConfig(''));
    expect(live.roles.reviewer).toBeUndefined();
  });

  it('shows in the execution settings the limits that were reloaded', () => {
    const live = parseConfig('');
    const settings = executionSettingsOf(live);
    const before = settings.timeoutMs;
    applyHotSections(live, parseConfig('limits:\n  demand_timeout: 3h\n  demand_timeout_max: 6h\n'));
    expect(settings.timeoutMs).toBe(3 * 60 * 60 * 1000);
    expect(settings.timeoutMs).not.toBe(before);
    expect(settings.timeoutMaxMs).toBe(6 * 60 * 60 * 1000);
  });
});
