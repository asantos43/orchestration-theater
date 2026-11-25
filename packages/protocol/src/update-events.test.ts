// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { API_ROUTES } from './api/registry.js';
import {
  applyUpdate,
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
      { ...found, phase: 'swapping' },
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

describe('the notices of the managed ACP adapters (P13)', () => {
  it('have their own kinds', () => {
    for (const kind of [
      'adapter_installing',
      'adapter_installed',
      'adapter_install_failed',
      'adapter_missing',
      'adapter_fallback',
    ]) {
      expect(DAEMON_NOTICE_KINDS).toContain(kind);
      const notice = { kind, subject: 'codex-acp', detail: '2.6.0' };
      expect(validateEventPayload('daemon.notice', 1, notice)).toEqual(notice);
    }
  });
});

describe('the notices of the code host (Phase 11, P13)', () => {
  it('have their own kinds', () => {
    for (const kind of [
      'delivery_without_pr',
      'code_host_unavailable',
      'issue_tracker_unavailable',
    ]) {
      expect(DAEMON_NOTICE_KINDS).toContain(kind);
      const notice = { kind, subject: 'play/p1/integration', detail: 'adapters.code_host is none' };
      expect(validateEventPayload('daemon.notice', 1, notice)).toEqual(notice);
    }
  });
});

describe('the /v1/updates routes', () => {
  it('are in the registry, with the methods and paths', () => {
    expect(Object.values(UPDATE_ROUTES).map((r) => [r.id, r.method, r.path])).toEqual([
      ['getUpdateStatus', 'GET', '/v1/updates'],
      ['checkUpdates', 'POST', '/v1/updates/check'],
      ['applyUpdate', 'POST', '/v1/updates/apply'],
    ]);
    expect(Object.values(API_ROUTES)).toContain(getUpdateStatus);
    expect(Object.values(API_ROUTES)).toContain(checkUpdates);
  });

  it('the status is a strict object', () => {
    const status = {
      mode: 'auto',
      effectiveMode: 'auto',
      channel: 'stable',
      source: 'github',
      installKind: 'own',
      currentVersion: '0.5.0',
      platform: 'linux-x64',
      keyState: 'valid',
      notes: ['no_public_key'],
      checkedAt: null,
      nextCheckAt: null,
      lastResult: null,
      found: null,
      ready: null,
      lastReason: null,
      apply: {
        when: 'idle',
        rollback: 'auto',
        state: 'none',
        version: null,
        since: null,
        askAt: null,
        last: null,
      },
    };
    expect(ApiUpdateStatusSchema.parse(status)).toEqual(status);
    expect(() => ApiUpdateStatusSchema.parse({ ...status, token: 'x' })).toThrow();
    expect(() => ApiUpdateStatusSchema.parse({ ...status, notes: ['other'] })).toThrow();
    expect(() =>
      ApiUpdateStatusSchema.parse({ ...status, apply: { ...status.apply, when: 'never' } }),
    ).toThrow();
    const last = {
      outcome: 'rolled_back',
      version: '0.6.0',
      reason: 'health',
      at: '2026-11-22T10:00:00-03:00',
    };
    expect(
      ApiUpdateStatusSchema.parse({ ...status, apply: { ...status.apply, last } }).apply.last,
    ).toEqual(last);
  });

  it('applyUpdate takes how (default when absent) and refuses the rest', () => {
    expect(applyUpdate.body.parse({})).toEqual({ how: 'default' });
    expect(applyUpdate.body.parse({ how: 'park' })).toEqual({ how: 'park' });
    expect(() => applyUpdate.body.parse({ how: 'now' })).toThrow();
    expect(() => applyUpdate.body.parse({ how: 'wait', x: 1 })).toThrow();
  });
});

describe('the notices of the application of a version', () => {
  it('have their own kinds', () => {
    for (const kind of [
      'update_applied',
      'update_rolled_back',
      'update_failed',
      'update_ask',
      'update_no_expiry',
      'update_untrusted_journal',
    ]) {
      expect(DAEMON_NOTICE_KINDS).toContain(kind);
      const notice = { kind, subject: '0.6.0', detail: 'x' };
      expect(validateEventPayload('daemon.notice', 1, notice)).toEqual(notice);
    }
  });
});

describe('daemon.backup', () => {
  it('takes the trigger update', () => {
    const payload = {
      ok: true,
      trigger: 'update',
      path: '/x/backup',
      removed: [],
    };
    expect(validateEventPayload('daemon.backup', 1, payload)).toEqual(payload);
    expect(() => validateEventPayload('daemon.backup', 1, { ...payload, trigger: 'x' })).toThrow();
  });
});
