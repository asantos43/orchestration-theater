// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { DEFAULT_WORKFLOW_TRIGGERS_SETTINGS, workflowTriggersSettings } from './config.js';

describe('workflows.triggers', () => {
  it('the defaults of the configuration are the defaults of the triggers', () => {
    expect(workflowTriggersSettings(parseConfig('').workflows)).toEqual(
      DEFAULT_WORKFLOW_TRIGGERS_SETTINGS,
    );
  });

  it('opens with the closed choices: the allowlist, declared plugin events, a poll of 5m', () => {
    const settings = workflowTriggersSettings(parseConfig('').workflows);
    expect(settings.authors).toBe('allowlist');
    expect(settings.authors_list).toEqual([]);
    expect(settings.plugin_events).toBe('declared');
    expect(settings.poll).toMatchObject({ mode: 'loop', interval: 300_000, on_error: 'backoff' });
  });

  it('reads every key', () => {
    const config = parseConfig(
      [
        'workflows:',
        '  triggers:',
        '    authors: collaborators',
        '    authors_list: [ana, Bob-Dev]',
        '    plugin_events: off',
        '    poll:',
        '      mode: off',
        '      interval: 2m',
        '      on_error: pause_binding',
        '      backoff_max: 30m',
        '      limit: 10',
        '    event_poll: 500ms',
        '',
      ].join('\n'),
    );
    expect(workflowTriggersSettings(config.workflows)).toEqual({
      authors: 'collaborators',
      authors_list: ['ana', 'Bob-Dev'],
      plugin_events: 'off',
      poll: {
        mode: 'off',
        interval: 120_000,
        on_error: 'pause_binding',
        backoff_max: 1_800_000,
        limit: 10,
      },
      event_poll: 500,
    });
  });

  it('turns the event poll off', () => {
    const config = parseConfig('workflows:\n  triggers:\n    event_poll: off\n');
    expect(workflowTriggersSettings(config.workflows).event_poll).toBeNull();
  });

  it('refuses an interval under 1m, an unknown mode and an unknown key', () => {
    expect(() => parseConfig('workflows:\n  triggers:\n    poll:\n      interval: 30s\n')).toThrow(
      /interval/,
    );
    expect(() => parseConfig('workflows:\n  triggers:\n    authors: nobody\n')).toThrow(/authors/);
    expect(() => parseConfig('workflows:\n  triggers:\n    plugin_events: all\n')).toThrow(
      /plugin_events/,
    );
    expect(() => parseConfig('workflows:\n  triggers:\n    poll:\n      mode: cron\n')).toThrow(
      /mode/,
    );
    expect(() =>
      parseConfig('workflows:\n  triggers:\n    poll:\n      on_error: ignore\n'),
    ).toThrow(/on_error/);
    expect(() => parseConfig('workflows:\n  triggers:\n    poll:\n      limit: 101\n')).toThrow(
      /limit/,
    );
    expect(() => parseConfig('workflows:\n  triggers:\n    event_poll: 10ms\n')).toThrow(
      /event_poll/,
    );
    expect(() => parseConfig('workflows:\n  triggers:\n    webhook: on\n')).toThrow();
  });

  it('refuses a login with a space', () => {
    expect(() => parseConfig('workflows:\n  triggers:\n    authors_list: ["a b"]\n')).toThrow(
      /authors_list/,
    );
  });
});
