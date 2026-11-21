// SPDX-License-Identifier: MPL-2.0
import { TelemetryStatusSchema, TELEMETRY_STATUS_EXPORT_MODES } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { TELEMETRY_EXPORT_MODES } from './export-config.js';
import { TelemetryStatusService } from './status.js';
import { MemoryTelemetryStore } from './telemetry-fixture.js';

const STATS = {
  accepted: { traces: 3, metrics: 2, logs: 1 },
  rejected: { format: 1, size: 0, token: 4 },
};

function make(
  yaml: string,
  over: Partial<ConstructorParameters<typeof TelemetryStatusService>[0]> = {},
): TelemetryStatusService {
  return new TelemetryStatusService({
    config: parseConfig(yaml),
    store: new MemoryTelemetryStore(),
    daemonSpans: true,
    receiver: () => ({ port: 4318, stats: STATS }),
    exporter: () => undefined,
    ...over,
  });
}

describe('TelemetryStatusService', () => {
  it('reports the receiver, the base and the export when everything runs', async () => {
    const status = TelemetryStatusSchema.parse(await make('backup:\n  when: manual\n').read());
    expect(status.state).toBe('on');
    expect(status.receiver).toEqual({ port: 4318, ...STATS });
    expect(status.base?.state).toBe('ok');
    expect(status.export).toEqual({ mode: 'off', otlp: null, prometheus: false });
  });

  it('is off when telemetry is off, with no receiver counters', async () => {
    const status = await make('telemetry:\n  enabled: off\n', {
      receiver: () => undefined,
      store: undefined,
    }).read();
    expect(status.state).toBe('off');
    expect(status.receiver).toBeNull();
    expect(status.base).toBeNull();
  });

  it('tells apart no base and no receiver', async () => {
    expect((await make('backup:\n  when: manual\n', { store: undefined }).read()).state).toBe(
      'no_base',
    );
    expect(
      (await make('backup:\n  when: manual\n', { receiver: () => undefined }).read()).state,
    ).toBe('no_receiver');
  });

  it('gives a null base when the health cannot be read', async () => {
    const store = { health: () => Promise.reject(new Error('gone')) };
    expect((await make('backup:\n  when: manual\n', { store }).read()).base).toBeNull();
  });

  it('shows the OTLP destination without path, credentials or query, and the drops that happened', async () => {
    const status = await make(
      'telemetry:\n  export: both\n  otlp:\n    endpoint: https://user:pw@collector.example:4318/base/path?key=secret\n',
      {
        exporter: () =>
          ({ exported: 7, dropped: { retries_exhausted: 2, queue_full: undefined } }) as never,
      },
    ).read();
    expect(status.export.otlp).toEqual({
      destination: 'https://collector.example:4318',
      exported: 7,
      dropped: { retries_exhausted: 2 },
    });
    expect(status.export.prometheus).toBe(true);
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(JSON.stringify(status)).not.toContain('pw');
  });

  it('has the same export modes as the key of the daemon', () => {
    expect([...TELEMETRY_STATUS_EXPORT_MODES]).toEqual([...TELEMETRY_EXPORT_MODES]);
  });
});
