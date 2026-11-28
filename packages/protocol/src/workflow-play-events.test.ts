// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_PLAY_CANCEL_OUTCOMES,
  WorkflowPlayCancelledPayloadSchema,
} from './workflow-play-events.js';

describe('workflow.play.cancelled payload', () => {
  const valid = { runId: 'run-1', node: 'work', play: 'play-1a2b3c4d', outcome: 'cancelled' };
  const parse = (value: unknown) => WorkflowPlayCancelledPayloadSchema.safeParse(value);

  it('takes every outcome and an optional detail', () => {
    for (const outcome of WORKFLOW_PLAY_CANCEL_OUTCOMES) {
      expect(parse({ ...valid, outcome }).success).toBe(true);
    }
    expect(parse({ ...valid, outcome: 'failed', detail: 'the runner is gone' }).success).toBe(true);
  });

  it('refuses a missing field, another outcome, a long detail and an extra field', () => {
    expect(parse({ ...valid, play: undefined }).success).toBe(false);
    expect(parse({ ...valid, outcome: 'ignored' }).success).toBe(false);
    expect(parse({ ...valid, detail: 'x'.repeat(501) }).success).toBe(false);
    expect(parse({ ...valid, extra: 1 }).success).toBe(false);
  });
});
