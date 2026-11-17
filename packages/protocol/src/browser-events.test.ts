// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  BrowserActionPayloadSchema,
  BrowserApprovalPayloadSchema,
  BrowserRefusedPayloadSchema,
} from './browser-events.js';
import { buildDaemonEvent } from './events.js';

describe('browser events', () => {
  it('accepts browser.action with the url, the screenshot and the idempotency key', () => {
    const payload = {
      action: 'click' as const,
      role: 'actor',
      callId: 'c1',
      scenarioId: 's1',
      url: 'http://127.0.0.1:1/',
      title: 'Page',
      outcome: 'ok' as const,
      ref: 'f1e6',
      screenshot: 'browser/screenshots/s1/1.png',
      idempotencyKey: 'p1:browser_click:a1:0',
      reused: false,
      durationMs: 12,
      playId: 'p1',
      attemptId: 'a1',
    };
    expect(BrowserActionPayloadSchema.parse(payload)).toEqual(payload);
    expect(buildDaemonEvent('browser.action', payload).type).toBe('browser.action');
  });

  it('refuses an unknown field (the value a fill typed has no place in the event)', () => {
    const base = {
      action: 'fill',
      role: 'actor',
      callId: 'c1',
      scenarioId: 's1',
      url: 'http://127.0.0.1:1/',
      outcome: 'ok',
      durationMs: 1,
    };
    expect(BrowserActionPayloadSchema.safeParse({ ...base, valueChars: 8 }).success).toBe(true);
    expect(BrowserActionPayloadSchema.safeParse({ ...base, value: 'hunter2' }).success).toBe(false);
    expect(BrowserActionPayloadSchema.safeParse({ ...base, action: 'goto' }).success).toBe(false);
  });

  it('accepts browser.refused for a call and for a request of the page', () => {
    for (const kind of ['call', 'request'] as const) {
      const payload = {
        kind,
        scenarioId: 's1',
        url: 'file:///x',
        code: 'secret_path',
        reason: 'no',
      };
      expect(BrowserRefusedPayloadSchema.parse(payload)).toEqual(payload);
    }
    expect(
      BrowserRefusedPayloadSchema.safeParse({
        kind: 'other',
        scenarioId: 's1',
        url: 'x',
        code: 'c',
        reason: 'r',
      }).success,
    ).toBe(false);
  });

  it('accepts browser.approval in its three states', () => {
    for (const state of ['requested', 'granted', 'denied'] as const) {
      const payload = {
        state,
        mode: 'always',
        action: 'click',
        scenarioId: 's1',
        domain: '127.0.0.1',
        url: 'http://127.0.0.1:1/',
        callId: 'c1',
      };
      expect(BrowserApprovalPayloadSchema.parse(payload)).toEqual(payload);
    }
    expect(
      BrowserApprovalPayloadSchema.safeParse({
        state: 'granted',
        mode: 'never',
        action: 'click',
        scenarioId: 's',
        domain: 'd',
        url: 'u',
        callId: 'c',
      }).success,
    ).toBe(false);
  });
});
