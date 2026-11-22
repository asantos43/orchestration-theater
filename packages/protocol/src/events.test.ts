// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, parseNewEvent } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  buildDaemonEvent,
  DAEMON_EVENT_TYPES,
  isDaemonEventType,
  validateEventPayload,
} from './events.js';

const started = {
  pid: 123,
  version: '0.0.0',
  dataDir: '/data',
  adapters: {
    store: { id: 'sqlite', portVersion: '0.1.0' },
    vault: { id: 'keyring', portVersion: '0.1.0' },
    clock: { id: 'system', portVersion: '0.1.0' },
  },
};

describe('daemon event registry', () => {
  it('lists the daemon and session event types, all at schemaVersion 1 but executor.selected (2, N150)', () => {
    expect(Object.keys(DAEMON_EVENT_TYPES)).toEqual([
      'daemon.started',
      'daemon.stopped',
      'daemon.backup',
      'daemon.recovered',
      'session.opened',
      'session.update',
      'session.prompt_finished',
      'session.interrupted',
      'session.resumed',
      'session.handoff',
      'session.handoff_failed',
      'attempt.reset_wait_started',
      'attempt.reset_wait_ended',
      'session.cancel_escalated',
      'session.processes_left',
      'session.turn_timeout',
      'session.closed',
      'permission.asked',
      'permission.answered',
      'attempt.checkpoint',
      'attempt.checkpoint_failed',
      'attempt.aborted',
      'attempt.submitted',
      'attempt.submit_failed',
      'attempt.paused',
      'attempt.resumed',
      'attempt.cancelled',
      'tool.called',
      'tool.finished',
      'terminal.output',
      'browser.action',
      'browser.refused',
      'browser.approval',
      'workspace.integrated',
      'workspace.integration_failed',
      'delivery.completed',
      'directive.created',
      'directive.activated',
      'directive.validity_changed',
      'directive.expiring',
      'directive.expired',
      'directive.revoked',
      'directive.suspended',
      'idea.added',
      'idea.grouped',
      'idea.play_opened',
      'idea.discarded',
      'idea.deferred',
      'idea.done',
      'idea.returned',
      'idea.queue_held',
      'profile.added',
      'profile.notice_accepted',
      'profile.draining',
      'profile.drained',
      'profile.removed',
      'scenario.created',
      'scenario.attachment_added',
      'scenario.director_slept',
      'scenario.director_woke',
      'scenario.director_switched',
      'scenario.chat_transitioned',
      'scenario.system_message',
      'quota.updated',
      'quota.near_limit',
      'quota.exhausted',
      'quota.restored',
      'budget.restored',
      'budget.warning',
      'budget.exceeded',
      'budget.unknown_cost',
      'usage.recorded',
      'executor.selected',
      'scenario.director_waiting',
      'scenario.director_resumed',
      'demand.waiting',
      'demand.resumed',
      'wait.started',
      'wait.ended',
      'play.notice',
      'quota.probe_failed',
      'quota.signal_dropped',
      'usage.notice',
      'profile.warning',
      'profile.exec.started',
      'profile.exec.ended',
      'profile.shims.synced',
      'profile.shims.rc_changed',
      'profile.login.started',
      'profile.login.completed',
      'profile.login.failed',
      'executor.changed',
      'daemon.notice',
      'recovery.notice',
      'scenario.notice',
      'telemetry.store_reset',
      'telemetry.receiver_started',
      'telemetry.batch_rejected',
      'telemetry.redacted',
      'telemetry.export_failed',
      'telemetry.purged',
      'api.started',
      'api.client_rejected',
      'api.stream_lagged',
      'scenario.decision_answered',
      'config.edited',
      'config.changed',
      'prompt.queued',
      'chat.director_reply',
      'chat.director_silent',
      'chat.ask',
      'chat.ask_closed',
      'chat.shell_command.started',
      'chat.shell_command.finished',
      'direct.session.opened',
      'direct.session.message',
      'direct.session.tool',
      'direct.session.permission',
      'direct.session.command',
      'direct.session.turn_finished',
      'direct.session.closed',
      'direct.session.promoted',
      'direct.session.refused',
      'api.chat_closed',
      'api.chat_message_dropped',
      'layout.adjusted',
      'layout.changed',
      'setup.started',
      'setup.step',
      'setup.back',
      'setup.confirmed',
      'setup.cancelled',
      'decision.created',
      'decision.answered',
      'scenario.archived',
      'demand.transitioned',
      'atif.exported',
      'atif.export_failed',
      'plugin.installed',
      'plugin.removed',
      'plugin.enabled',
      'plugin.disabled',
      'plugin.server_started',
      'plugin.server_stopped',
      'plugin.server_failed',
      'plugin.tool_rejected',
      'plugin.event_rejected',
      'plugin.secret_missing',
    ]);
    for (const [type, entry] of Object.entries(DAEMON_EVENT_TYPES)) {
      expect(entry.schemaVersion).toBe(type === 'executor.selected' ? 2 : 1);
    }
    expect(isDaemonEventType('daemon.started')).toBe(true);
    expect(isDaemonEventType('play.created')).toBe(false);
    expect(isDaemonEventType('toString')).toBe(false);
  });

  it('accepts a valid payload of each type', () => {
    expect(validateEventPayload('daemon.started', 1, started)).toEqual(started);
    expect(validateEventPayload('daemon.stopped', 1, { reason: 'signal', uptimeMs: 5 })).toEqual({
      reason: 'signal',
      uptimeMs: 5,
    });
    const backup = {
      ok: true,
      trigger: 'manual',
      path: '/b/x',
      method: 'online_api',
      durationMs: 1.5,
      bytes: 10,
      restarts: 0,
      integrity: 'ok',
      removed: [],
    };
    expect(validateEventPayload('daemon.backup', 1, backup)).toEqual(backup);
    const recovered = {
      durationMs: 12,
      orphansKilled: 1,
      sessionsInterrupted: 2,
      attemptsInterrupted: 1,
      wipCommits: 1,
      effectsResolved: 1,
      playsResumed: ['play-1'],
      playsRefused: [],
      pending: [{ kind: 'effect', key: 'k', effectType: 'open_pr', playId: 'play-1', reason: 'x' }],
    };
    expect(validateEventPayload('daemon.recovered', 1, recovered)).toEqual(recovered);
    expect(() =>
      validateEventPayload('daemon.recovered', 1, { ...recovered, extra: true }),
    ).toThrow();
    expect(
      validateEventPayload('daemon.backup', 1, {
        ok: false,
        trigger: 'schedule',
        error: { code: 'Transient', message: 'x' },
        removed: [],
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects an unknown type, an unknown schemaVersion and a bad payload with InvalidInput', () => {
    expect(() => validateEventPayload('daemon.other', 1, {})).toThrow(InvalidInput);
    expect(() => validateEventPayload('daemon.started', 2, started)).toThrow(InvalidInput);
    expect(() => validateEventPayload('daemon.started', 1, { ...started, pid: 0 })).toThrow(/pid/);
    expect(() =>
      validateEventPayload('daemon.stopped', 1, { reason: 'crash', uptimeMs: 1 }),
    ).toThrow(InvalidInput);
  });

  it('is strict: an unknown field is an error', () => {
    expect(() => validateEventPayload('daemon.started', 1, { ...started, extra: 1 })).toThrow(
      InvalidInput,
    );
    expect(() =>
      validateEventPayload('daemon.stopped', 1, { reason: 'shutdown', uptimeMs: 1, extra: 1 }),
    ).toThrow(InvalidInput);
    expect(() => validateEventPayload('daemon.backup', 1, { ok: true, trigger: 'manual' })).toThrow(
      /removed/,
    );
  });

  it('builds an event the EventLog port accepts', () => {
    const event = buildDaemonEvent('daemon.started', started);
    expect(event).toMatchObject({ type: 'daemon.started', schemaVersion: 1 });
    expect(parseNewEvent(event)).toEqual(event);
    expect(() =>
      buildDaemonEvent('daemon.stopped', { reason: 'nope', uptimeMs: 1 } as never),
    ).toThrow(InvalidInput);
  });
});
