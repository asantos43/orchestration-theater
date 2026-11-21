// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { buildDaemonEvent, validateEventPayload } from './events.js';

describe('atif events', () => {
  const exported = {
    unit: 'play',
    attemptId: null,
    on: 'play_end',
    content: 'full',
    path: 'trajectories/P1.json',
    bytes: 1200,
    steps: 7,
    attempts: 2,
  } as const;

  it('atif.exported: the file, its size and what is in it, and no content', () => {
    expect(validateEventPayload('atif.exported', 1, exported)).toEqual(exported);
    expect(buildDaemonEvent('atif.exported', exported).type).toBe('atif.exported');
    expect(() =>
      validateEventPayload('atif.exported', 1, { ...exported, unit: 'play_files' }),
    ).toThrow();
    expect(() => validateEventPayload('atif.exported', 1, { ...exported, text: 'x' })).toThrow();
    expect(() => validateEventPayload('atif.exported', 1, { ...exported, bytes: -1 })).toThrow();
  });

  it('atif.export_failed: a reason and a short detail', () => {
    const failed = {
      unit: 'play_files',
      attemptId: null,
      on: 'manual',
      reason: 'write_failed',
      detail: null,
    } as const;
    expect(validateEventPayload('atif.export_failed', 1, failed)).toEqual(failed);
    expect(() =>
      validateEventPayload('atif.export_failed', 1, { ...failed, reason: 'x' }),
    ).toThrow();
    expect(() =>
      validateEventPayload('atif.export_failed', 1, { ...failed, detail: 'x'.repeat(513) }),
    ).toThrow();
  });
});
