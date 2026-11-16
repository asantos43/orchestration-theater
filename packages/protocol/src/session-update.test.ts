// SPDX-License-Identifier: MPL-2.0
import * as core from '@otheater/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as protocol from './index.js';

describe('normalized updates through the protocol', () => {
  it('are the same schemas as in core', () => {
    expect(protocol.NormalizedUpdateSchema).toBe(core.NormalizedUpdateSchema);
    expect(protocol.StopReasonSchema).toBe(core.StopReasonSchema);
    expectTypeOf<protocol.NormalizedUpdate>().toEqualTypeOf<core.NormalizedUpdate>();
  });

  it('parse an update from the protocol entry point', () => {
    const parsed = protocol.NormalizedUpdateSchema.parse({
      kind: 'tool_call_update',
      toolCallId: 't1',
      status: 'failed',
    });
    expect(parsed.kind).toBe('tool_call_update');
  });
});
