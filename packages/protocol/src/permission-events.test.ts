// SPDX-License-Identifier: MPL-2.0
import { PERMISSION_REASONS } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { buildDaemonEvent, validateEventPayload } from './events.js';
import {
  PERMISSION_ANSWERS,
  PERMISSION_EVENT_MAX_PATHS,
  PermissionAnsweredPayloadSchema,
  PermissionAskedPayloadSchema,
} from './permission-events.js';

const asked = {
  sessionId: 'sess-1',
  toolCallId: 'call-1',
  tool: 'Write',
  kind: 'edit',
  paths: ['docs/guide.md'],
  pathCount: 1,
  playId: 'play-1',
  demandId: 'demand-1',
  attemptId: 'attempt-1',
};

const answered = {
  ...asked,
  answer: 'allow' as const,
  rule: 'docs-edit',
  reason: 'rule' as const,
};

describe('permission event payloads (architecture 5.8, layer 2)', () => {
  it('accepts a request and its answer', () => {
    expect(PermissionAskedPayloadSchema.parse(asked)).toEqual(asked);
    expect(PermissionAnsweredPayloadSchema.parse(answered)).toEqual(answered);
    expect(buildDaemonEvent('permission.asked', asked).type).toBe('permission.asked');
    expect(buildDaemonEvent('permission.answered', answered).type).toBe('permission.answered');
  });

  it('keeps the correlation optional: the minimum is the session and the tool', () => {
    const minimal = { sessionId: 'sess-1', tool: 'unknown', paths: [], pathCount: 0 };
    expect(PermissionAskedPayloadSchema.parse(minimal)).toEqual(minimal);
    expect(
      PermissionAnsweredPayloadSchema.parse({
        ...minimal,
        answer: 'cancelled',
        rule: 'none',
        reason: 'on_ask_reject',
      }),
    ).toMatchObject({ answer: 'cancelled', rule: 'none' });
  });

  it('accepts every answer and every reason the engine can give', () => {
    for (const answer of PERMISSION_ANSWERS) {
      expect(PermissionAnsweredPayloadSchema.safeParse({ ...answered, answer }).success).toBe(true);
    }
    for (const reason of PERMISSION_REASONS) {
      expect(PermissionAnsweredPayloadSchema.safeParse({ ...answered, reason }).success).toBe(true);
    }
    expect(
      PermissionAnsweredPayloadSchema.safeParse({ ...answered, answer: 'maybe' }).success,
    ).toBe(false);
    expect(PermissionAnsweredPayloadSchema.safeParse({ ...answered, reason: 'whim' }).success).toBe(
      false,
    );
  });

  it('records the rule that N99 overruled', () => {
    const payload = {
      ...answered,
      answer: 'reject',
      rule: 'none',
      reason: 'write_outside_worktree',
      overruledRule: 'any-edit',
    };
    expect(PermissionAnsweredPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('refuses unknown keys, so a command line or a title cannot slip in', () => {
    expect(PermissionAskedPayloadSchema.safeParse({ ...asked, command: 'rm -rf /' }).success).toBe(
      false,
    );
    expect(PermissionAnsweredPayloadSchema.safeParse({ ...answered, title: 'x' }).success).toBe(
      false,
    );
  });

  it('limits the listed paths and tells the real count apart', () => {
    const many = Array.from({ length: PERMISSION_EVENT_MAX_PATHS }, (_, i) => `f${String(i)}.txt`);
    expect(
      PermissionAskedPayloadSchema.safeParse({ ...asked, paths: many, pathCount: 25 }).success,
    ).toBe(true);
    expect(
      PermissionAskedPayloadSchema.safeParse({ ...asked, paths: [...many, 'extra.txt'] }).success,
    ).toBe(false);
    expect(PermissionAskedPayloadSchema.safeParse({ ...asked, paths: [''] }).success).toBe(false);
    expect(PermissionAskedPayloadSchema.safeParse({ ...asked, pathCount: -1 }).success).toBe(false);
  });

  it('refuses a payload without session or tool', () => {
    const noSession: Partial<typeof asked> = { ...asked };
    delete noSession.sessionId;
    const noTool: Partial<typeof asked> = { ...asked };
    delete noTool.tool;
    expect(PermissionAskedPayloadSchema.safeParse(noSession).success).toBe(false);
    expect(PermissionAskedPayloadSchema.safeParse(noTool).success).toBe(false);
  });

  it('is validated through the registry by event type', () => {
    expect(validateEventPayload('permission.asked', 1, asked)).toEqual(asked);
    expect(() => validateEventPayload('permission.answered', 1, asked)).toThrow();
    expect(() => validateEventPayload('permission.asked', 2, asked)).toThrow();
  });
});
