// SPDX-License-Identifier: MPL-2.0
import { createServer, type Server } from 'node:net';
import type { TelemetryStore } from '@otheater/core';
import { InMemorySecretVault } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import type { SituationSink } from '../situations.js';
import { startTelemetry, type TelemetryRuntime } from './runtime.js';

const STORE: TelemetryStore = {
  write: () => ({ accepted: 0, dropped: 0 }),
  flush: () => Promise.resolve(),
  readSpans: () => Promise.resolve([]),
  readMetrics: () => Promise.resolve([]),
  readLogs: () => Promise.resolve([]),
  readCursor: () => Promise.resolve(null),
  writeCursor: () => Promise.resolve(),
  deleteOlderThan: () => Promise.resolve({ spans: 0, metrics: 0, logs: 0 }),
  replaceRollupDay: () => Promise.resolve(),
  readRollups: () => Promise.resolve([]),
  readRollupsReadyThrough: () => Promise.resolve(null),
  markRollupsReady: () => Promise.resolve(),
  deleteRollupsBefore: () => Promise.resolve(0),
  health: () =>
    Promise.resolve({
      state: 'ok',
      queued: 0,
      written: 0,
      droppedOverflow: 0,
      discarded: 0,
      resets: 0,
      fileBytes: null,
    }),
  close: () => Promise.resolve(),
};

function sink(): SituationSink & { readonly seen: { type: string; payload: unknown }[] } {
  const seen: { type: string; payload: unknown }[] = [];
  return {
    seen,
    record(type, payload) {
      seen.push({ type, payload });
    },
  };
}

const started: TelemetryRuntime[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(
    blockers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => {
            done();
          });
        }),
    ),
  );
});

function input(yaml: string, withStore = true) {
  const situations = sink();
  return {
    situations,
    args: {
      config: parseConfig(yaml),
      store: withStore ? STORE : undefined,
      vault: new InMemorySecretVault(),
      logger: createSilentLogger(),
      situations,
      scenarioOf: () => Promise.resolve(null),
    },
  };
}

describe('startTelemetry', () => {
  it('starts the receiver and the client side, and stop is idempotent', async () => {
    const { args, situations } = input('');
    const runtime = await startTelemetry(args);
    if (runtime === undefined) throw new Error('expected a runtime');
    started.push(runtime);
    expect(runtime.receiver.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(situations.seen.map((entry) => entry.type)).toContain('telemetry.receiver_started');
    await runtime.stop();
    await runtime.stop();
  });

  it('starts nothing with telemetry.enabled: off, or with no base', async () => {
    expect(await startTelemetry(input('telemetry:\n  enabled: off\n').args)).toBeUndefined();
    expect(await startTelemetry(input('', false).args)).toBeUndefined();
  });

  it('a port already in use leaves the daemon going, with a notice and no telemetry', async () => {
    const blocker = createServer();
    blockers.push(blocker);
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        const address = blocker.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
    const { args, situations } = input(`telemetry:\n  receiver:\n    port: ${String(port)}\n`);
    expect(await startTelemetry(args)).toBeUndefined();
    expect(situations.seen).toEqual([
      {
        type: 'daemon.notice',
        payload: expect.objectContaining({ kind: 'telemetry_receiver_unavailable' }) as unknown,
      },
    ]);
  });
});
