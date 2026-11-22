// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { API_ROUTES } from './api/registry.js';
import {
  checkUpdates,
  getUpdateStatus,
  UPDATE_ROUTES,
  ApiUpdateStatusSchema,
} from './api/updates.js';
import { DAEMON_NOTICE_KINDS } from './notice-events.js';
import { UPDATE_PHASES, UPDATE_REASONS } from './update-events.js';
import { validateEventPayload } from './events.js';

/** The event and the routes of the search for a new version (Phase 10, P7). [proposta] */

const found = {
  phase: 'found',
  version: '0.6.0',
  current: '0.5.0',
  channel: 'stable',
  mode: 'auto',
  effectiveMode: 'notify',
  reason: null,
};

describe('daemon.update', () => {
  it('takes every phase and every reason', () => {
    for (const phase of UPDATE_PHASES) {
      expect(validateEventPayload('daemon.update', 1, { ...found, phase })).toEqual({
        ...found,
        phase,
      });
    }
    for (const reason of UPDATE_REASONS) {
      const rejected = { ...found, phase: 'rejected', reason };
      expect(validateEventPayload('daemon.update', 1, rejected)).toEqual(rejected);
    }
  });

  it('the version may be unknown, and the mode off is never written', () => {
    const none = { ...found, phase: 'failed', version: null, reason: 'no_network' };
    expect(validateEventPayload('daemon.update', 1, none)).toEqual(none);
    expect(() => validateEventPayload('daemon.update', 1, { ...found, mode: 'off' })).toThrow();
    expect(() =>
      validateEventPayload('daemon.update', 1, { ...found, effectiveMode: 'off' }),
    ).toThrow();
  });

  it('refuses the strange: a phase, a reason, a channel, an extra field, a long version', () => {
    for (const bad of [
      { ...found, phase: 'applying' },
      { ...found, reason: 'mood' },
      { ...found, channel: 'nightly' },
      { ...found, extra: true },
      { ...found, version: 'x'.repeat(65) },
      { ...found, version: '' },
    ]) {
      expect(() => validateEventPayload('daemon.update', 1, bad), JSON.stringify(bad)).toThrow();
    }
    const withoutReason: Partial<typeof found> = { ...found };
    delete withoutReason.reason;
    expect(() => validateEventPayload('daemon.update', 1, withoutReason)).toThrow();
  });
});

describe('the notice of a refused version', () => {
  it('has its own kind', () => {
    expect(DAEMON_NOTICE_KINDS).toContain('update_rejected');
    const notice = { kind: 'update_rejected', subject: '0.6.0', detail: 'signature' };
    expect(validateEventPayload('daemon.notice', 1, notice)).toEqual(notice);
  });
});

describe('the /v1/updates routes', () => {
  it('are in the registry, with the methods and paths', () => {
    expect(Object.values(UPDATE_ROUTES).map((r) => [r.id, r.method, r.path])).toEqual([
      ['getUpdateStatus', 'GET', '/v1/updates'],
      ['checkUpdates', 'POST', '/v1/updates/check'],
    ]);
    expect(Object.values(API_ROUTES)).toContain(getUpdateStatus);
    expect(Object.values(API_ROUTES)).toContain(checkUpdates);
  });

  it('the status is a strict object', () => {
    const status = {
      mode: 'auto',
      effectiveMode: 'notify',
      channel: 'stable',
      source: 'github',
      installKind: 'own',
      currentVersion: '0.5.0',
      platform: 'linux-x64',
      keyState: 'valid',
      notes: ['auto_acts_as_notify'],
      checkedAt: null,
      nextCheckAt: null,
      lastResult: null,
      found: null,
      ready: null,
      lastReason: null,
    };
    expect(ApiUpdateStatusSchema.parse(status)).toEqual(status);
    expect(() => ApiUpdateStatusSchema.parse({ ...status, token: 'x' })).toThrow();
    expect(() => ApiUpdateStatusSchema.parse({ ...status, notes: ['other'] })).toThrow();
  });
});
