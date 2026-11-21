// SPDX-License-Identifier: MPL-2.0
import { type ClientOtel, type OtelLaunch, type Profile, type SessionSetup } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { ClientTelemetry } from '../telemetry/client-telemetry.js';
import { TelemetrySessions } from '../telemetry/sessions.js';
import { TEST_POLICY, TEST_PROFILE } from '../test-helpers.js';
import { SessionPool } from './pool.js';

/** A client that records what the pool hands to the two telemetry hooks. */
class Recording extends FakeClientAdapter {
  readonly launched: ClientOtel[] = [];
  readonly setups: ClientOtel[] = [];
  protected override otelLaunch(_profile: Profile, otel: ClientOtel): Promise<OtelLaunch> {
    this.launched.push(otel);
    return Promise.resolve({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: otel.endpoint } });
  }
  protected override otelSetup(setup: SessionSetup, otel: ClientOtel): SessionSetup {
    this.setups.push(otel);
    return setup;
  }
}

function setup(shared: boolean, withTelemetry = true) {
  const launcher = new FakeProcessLauncher();
  const sessions = new TelemetrySessions();
  const transport = new FakeSessionTransport();
  const adapter = new Recording({
    launcher,
    baseEnv: {},
    adapterVersion: '1.0.0',
    command: { cmd: 'fake-client', args: [] },
    processModel: shared ? 'multi-session' : 'process-per-session',
  });
  const telemetry = new ClientTelemetry({
    endpoint: 'http://127.0.0.1:4318',
    token: 'tok-0123456789',
    config: parseConfig('').telemetry,
    sessions,
    logger: { warn: () => undefined },
  });
  const pool = new SessionPool({
    clients: [adapter],
    launcher,
    transport: () => transport,
    clock: new FakeClock(),
    settings: { sessionsPerProcess: 2, maxSessions: 10, idleMs: 60_000, sharedCancel: 'escalate' },
    ...(withTelemetry ? { telemetry } : {}),
  });
  const request = (attemptId: string) => ({
    client: 'fake',
    profile: TEST_PROFILE,
    policy: TEST_POLICY,
    cwd: '/work/one',
    telemetry: { playId: 'play-1', stageId: 'stage-a', attemptId },
  });
  return { launcher, sessions, adapter, pool, request };
}

describe('SessionPool telemetry (Phase 8, P2)', () => {
  it('gives a process-per-session client the whole resource at launch and registers the session', async () => {
    const { adapter, pool, sessions, request } = setup(false);
    const lease = await pool.acquire(request('play-1/stage-a/1'));
    expect(adapter.launched).toHaveLength(1);
    expect(adapter.launched[0]?.resource).toMatchObject({
      'otheater.client': 'fake',
      'otheater.play_id': 'play-1',
      'otheater.attempt_id': 'play-1/stage-a/1',
    });
    expect(adapter.launched[0]?.headers).toEqual({ Authorization: 'Bearer tok-0123456789' });
    expect(sessions.get(lease.session.sessionId)).toMatchObject({
      attemptId: 'play-1/stage-a/1',
      playId: 'play-1',
    });
    await lease.release();
    // The grace period keeps the entry for the last records of a closed session.
    expect(sessions.get(lease.session.sessionId)).toBeDefined();
  });

  it('keeps sessions of different attempts in one process: only the stable resource is process-level', async () => {
    const { adapter, launcher, pool, sessions, request } = setup(true);
    const a = await pool.acquire(request('play-1/stage-a/1'));
    const b = await pool.acquire(request('play-1/stage-b/1'));
    expect(launcher.launched).toHaveLength(1);
    for (const otel of adapter.launched) {
      expect(otel.resource['otheater.attempt_id']).toBeUndefined();
      expect(otel.resource['otheater.client']).toBe('fake');
    }
    // The session level carries the attempt, and the table ties each session to its own.
    expect(adapter.setups.map((otel) => otel.resource['otheater.attempt_id'])).toEqual([
      'play-1/stage-a/1',
      'play-1/stage-b/1',
    ]);
    expect(sessions.get(a.session.sessionId)?.attemptId).toBe('play-1/stage-a/1');
    expect(sessions.get(b.session.sessionId)?.attemptId).toBe('play-1/stage-b/1');
    await a.release();
    await b.release();
  });

  it('with no telemetry configured, calls the client as before', async () => {
    const { adapter, pool, sessions, request } = setup(false, false);
    const lease = await pool.acquire(request('play-1/stage-a/1'));
    expect(adapter.launched).toHaveLength(0);
    expect(adapter.setups).toHaveLength(0);
    expect(sessions.size).toBe(0);
    await lease.release();
  });
});
