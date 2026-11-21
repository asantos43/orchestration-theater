// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  otelBaseEnv,
  type ClientOtel,
  type OtelLaunch,
  type Profile,
  type RolePolicy,
  type TelemetryBatch,
  type TelemetryLogRecord,
  type TelemetryMetricPoint,
  type TelemetrySpan,
  type TelemetryStore,
} from '@otheater/core';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { makeRepo } from '../execution/attempt-fixture.js';
import type { AttemptSpec } from '../execution/attempt-runner.js';
import { itWithLauncher } from '../launcher-fixture.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir, TEST_PROFILE } from '../test-helpers.js';

/**
 * Phase 8, P2, the acceptance test: the fake agent (over the real ACP stdio transport, started by
 * the daemon's real launcher) exports its telemetry to the daemon's REAL receiver, and what it
 * sent lands in the telemetry store tied to the play, the attempt and the session. The client is
 * the compiled `dist/cli.js`, so `pnpm build` comes first (as for `simulated-acp.test.ts`).
 */

const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

const CONFIG = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
`);

const WRITING: RolePolicy = {
  nativeTools: ['read', 'search', 'edit', 'write'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

/** The fake client, now exporting its telemetry through the standard variables (as the real ones do). */
class ExportingFake extends FakeClientAdapter {
  protected override otelLaunch(_profile: Profile, otel: ClientOtel): Promise<OtelLaunch> {
    return Promise.resolve({ env: otelBaseEnv(otel) });
  }
}

/** Keeps what the receiver writes; the reads are not used here. */
class RecordingStore implements TelemetryStore {
  readonly spans: TelemetrySpan[] = [];
  readonly metrics: TelemetryMetricPoint[] = [];
  readonly logs: TelemetryLogRecord[] = [];
  write(batch: TelemetryBatch) {
    this.spans.push(...(batch.spans ?? []));
    this.metrics.push(...(batch.metrics ?? []));
    this.logs.push(...(batch.logs ?? []));
    return {
      accepted:
        (batch.spans?.length ?? 0) + (batch.metrics?.length ?? 0) + (batch.logs?.length ?? 0),
      dropped: 0,
    };
  }
  flush() {
    return Promise.resolve();
  }
  readSpans() {
    return Promise.resolve(this.spans);
  }
  readMetrics() {
    return Promise.resolve(this.metrics);
  }
  readLogs() {
    return Promise.resolve(this.logs);
  }
  deleteOlderThan() {
    return Promise.resolve({ spans: 0, metrics: 0, logs: 0 });
  }
  health() {
    return Promise.resolve({
      state: 'ok' as const,
      queued: 0,
      written: 0,
      droppedOverflow: 0,
      discarded: 0,
      resets: 0,
      fileBytes: null,
    });
  }
  close() {
    return Promise.resolve();
  }
}

beforeAll(() => {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
});
afterAll(disposeTestGitIsolation);

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('the telemetry did not arrive in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('the fake agent exporting to the real receiver of the daemon', () => {
  itWithLauncher(
    'lands in the store tied to the play, the attempt and the session of each attempt',
    async () => {
      const tmp = await makeTempDataDir();
      const real = defaultLauncher();
      if (real === undefined) throw new Error('this platform has no process launcher');
      const store = new RecordingStore();
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        config: CONFIG,
        overrides: {
          clock: new FakeClock(),
          vault: new InMemorySecretVault(),
          launcher: real,
          telemetry: store,
        },
        clients: (parts) => [
          ...productionClients(CONFIG)(parts),
          new ExportingFake({
            launcher: parts.launcher,
            baseEnv: {},
            adapterVersion: '1.0.0',
            command: { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
          }),
        ],
        logger: createSilentLogger(),
        version: '0.0.0-test',
      });
      const { repo, dispose } = await makeRepo();
      try {
        // Loopback only, on a port of its own.
        expect(daemon.telemetryUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
        const runner = daemon.execution?.runner;
        if (runner === undefined) throw new Error('the daemon has no execution');
        const spec = (playId: string, prompt: string): AttemptSpec => ({
          playId,
          demandId: 'stage-a',
          attempt: 1,
          repo,
          base: 'main',
          profile: TEST_PROFILE,
          executor: { model: 'fake-model' },
          policy: WRITING,
          prompt,
        });
        // Two attempts one after the other (the fake agent numbers its sessions per process).
        const first = await runner.run(
          spec('play-one', '#script:write-file {"path":"a.txt","content":"a\\n"}\nedit'),
        );
        expect(first.state).toBe('completed');
        await until(
          () => store.spans.length >= 1 && store.metrics.length >= 1 && store.logs.length >= 1,
        );
        const second = await runner.run(
          spec('play-two', '#script:write-file {"path":"b.txt","content":"b\\n"}\nedit'),
        );
        expect(second.state).toBe('completed');
        await until(() => store.spans.length >= 2);

        const spans = store.spans.filter((span) => span.name === 'fake_agent.turn');
        expect(spans).toHaveLength(2);
        const byPlay = (playId: string) => spans.find((span) => span.playId === playId);
        const one = byPlay('play-one');
        const two = byPlay('play-two');
        expect(one).toMatchObject({
          attemptId: first.attemptId,
          sessionId: 'fake-session-1',
          scenarioId: null,
          status: 'ok',
        });
        expect(one?.resource).toMatchObject({
          'otheater.client': 'fake',
          'otheater.play_id': 'play-one',
          'otheater.attempt_id': first.attemptId,
        });
        expect(two).toMatchObject({ attemptId: second.attemptId, sessionId: 'fake-session-1' });

        // The metric and the logs of the attempt carry the same correlation.
        const metric = store.metrics.find((point) => point.playId === 'play-one');
        expect(metric).toMatchObject({
          name: 'fake_agent.token.usage',
          attemptId: first.attemptId,
          sessionId: 'fake-session-1',
        });
        const logs = store.logs.filter((record) => record.playId === 'play-one');
        expect(logs.length).toBeGreaterThan(0);
        expect(logs.every((record) => record.attemptId === first.attemptId)).toBe(true);

        // Nothing arrived uncorrelated, and the token never reached the store.
        for (const record of [...store.spans, ...store.metrics, ...store.logs]) {
          expect(record.playId).not.toBeNull();
          expect(
            JSON.stringify(record, (_key, value: unknown) =>
              typeof value === 'bigint' ? String(value) : value,
            ),
          ).not.toMatch(/Bearer /u);
        }
      } finally {
        await dispose();
        await daemon.stop();
        await tmp.dispose();
      }
    },
    90_000,
  );

  itWithLauncher(
    'with telemetry.enabled: off there is no receiver and no port',
    async () => {
      const tmp = await makeTempDataDir();
      const config = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
telemetry:
  enabled: off
`);
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        config,
        overrides: { clock: new FakeClock(), vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
        version: '0.0.0-test',
      });
      try {
        expect(daemon.telemetryUrl).toBeUndefined();
      } finally {
        await daemon.stop();
        await tmp.dispose();
      }
    },
    30_000,
  );
});
