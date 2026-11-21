// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths } from '../paths.js';
import { makeTempDataDir, NO_CLIENTS } from '../test-helpers.js';
import { PROMETHEUS_CONTENT_TYPE } from './prometheus.js';

/** `GET /metrics` on the API of the daemon (Phase 8, P7, N218): the same access rules, off by default. */

async function withDaemon(
  telemetry: string,
  body: (daemon: DaemonHandle, token: string) => Promise<void>,
): Promise<void> {
  const tmp = await makeTempDataDir();
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    clientSearch: NO_CLIENTS,
    config: parseConfig(`backup:\n  when: manual\ntelemetry:\n${telemetry}`),
    overrides: { clock: new FakeClock(), vault: new InMemorySecretVault() },
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  try {
    const token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
    await body(daemon, token);
  } finally {
    await daemon.stop();
    await tmp.dispose();
  }
}

const scrape = (daemon: DaemonHandle, token: string | null): Promise<Response> =>
  fetch(`${daemon.api.url}/metrics`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

describe('GET /metrics', () => {
  it.each(['prometheus', 'both'])(
    'answers the text format 0.0.4 with the metrics of N218 when export is %s',
    async (mode) => {
      // `both` sends OTLP too: the endpoint is a port nobody listens on, and the daemon is not
      // bothered by it (the exporter waits for a clock that never moves here).
      const otlp = mode === 'both' ? '  otlp:\n    endpoint: http://127.0.0.1:9\n' : '';
      await withDaemon(`  export: ${mode}\n${otlp}`, async (daemon, token) => {
        const response = await scrape(daemon, token);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const text = await response.text();
        expect(text.endsWith('\n')).toBe(true);
        for (const name of [
          'otheater_scheduler_queue_depth',
          'otheater_attempts_total',
          'otheater_telemetry_dropped_total',
          'otheater_waits_active',
          'otheater_waits_total',
          'otheater_wait_seconds_total',
          'otheater_telemetry_batches_rejected_total',
        ]) {
          expect(text).toContain(`# HELP ${name} `);
          expect(text).toContain(`# TYPE ${name} `);
        }
        // Nothing of an account is a label: no e-mail, no account id.
        expect(text).not.toMatch(/@\w+\.\w+/u);
      });
    },
  );

  it('shows the batches the receiver refused, by reason (Phase 9, P2)', async () => {
    await withDaemon('  export: prometheus\n', async (daemon, token) => {
      const before = await (await scrape(daemon, token)).text();
      expect(before).toContain('otheater_telemetry_batches_rejected_total{reason="token"} 0');
      // The receiver has a token of its own: a request without it is refused with the reason `token`.
      const refused = await fetch(`${daemon.telemetryUrl ?? ''}/v1/logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(refused.status).toBe(401);
      const after = await (await scrape(daemon, token)).text();
      expect(after).toContain('otheater_telemetry_batches_rejected_total{reason="token"} 1');
      expect(after).toContain('otheater_telemetry_batches_rejected_total{reason="format"} 0');
      expect(after).toContain('otheater_waits_active{kind="pool_admission"} 0');
      expect(after).toContain('otheater_waits_active{kind="prompt_queue"} 0');
    });
  });

  it('asks for the token, like every route of the API', async () => {
    await withDaemon('  export: prometheus\n', async (daemon) => {
      expect((await scrape(daemon, null)).status).toBe(401);
      expect((await scrape(daemon, 'not-the-token')).status).toBe(401);
    });
  });

  it.each(['off', 'otlp'])('is not there when export is %s', async (mode) => {
    const otlp = mode === 'otlp' ? '  otlp:\n    endpoint: http://127.0.0.1:9\n' : '';
    await withDaemon(`  export: ${mode}\n${otlp}`, async (daemon, token) => {
      expect((await scrape(daemon, token)).status).toBe(404);
    });
  });

  it('is off by default', async () => {
    await withDaemon('  enabled: on\n', async (daemon, token) => {
      expect((await scrape(daemon, token)).status).toBe(404);
    });
  });

  it('answers with the telemetry off, since the metrics come from the stores of the daemon', async () => {
    await withDaemon('  enabled: off\n  export: prometheus\n', async (daemon, token) => {
      const response = await scrape(daemon, token);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('# TYPE otheater_scheduler_queue_depth gauge');
    });
  });
});
