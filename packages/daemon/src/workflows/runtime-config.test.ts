// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { DEFAULT_WORKFLOW_RUNTIME, workflowRuntimeSettings } from './runtime-config.js';

describe('workflows.runtime', () => {
  it('the defaults of the configuration are the defaults of the engine', () => {
    expect(workflowRuntimeSettings(parseConfig('').workflows)).toEqual(DEFAULT_WORKFLOW_RUNTIME);
  });

  it('reads the durations, `off` and the mode', () => {
    const config = parseConfig(
      [
        'workflows:',
        '  runtime:',
        '    wait_event: { poll: 5s }',
        '    approval: { timeout: 30m, on_timeout: reject }',
        '    call_tool: { timeout: 1m }',
        '',
      ].join('\n'),
    );
    expect(workflowRuntimeSettings(config.workflows)).toEqual({
      waitEventPollMs: 5_000,
      approvalTimeoutMs: 1_800_000,
      approvalOnTimeout: 'reject',
      callToolTimeoutMs: 60_000,
    });
    const off = parseConfig('workflows:\n  runtime:\n    call_tool: { timeout: off }\n');
    expect(workflowRuntimeSettings(off.workflows).callToolTimeoutMs).toBeNull();
  });

  it('rejects an unknown mode and an unknown key', () => {
    expect(() =>
      parseConfig('workflows:\n  runtime:\n    approval: { on_timeout: approve }\n'),
    ).toThrow(/on_timeout/);
    expect(() => parseConfig('workflows:\n  runtime:\n    nothing: 1\n')).toThrow(/nothing/);
  });
});
