// SPDX-License-Identifier: MPL-2.0
import type { TelemetryStore } from '@otheater/core';
import type { TelemetryStatus } from '@otheater/protocol';
import type { DaemonConfig } from '../config.js';
import { destinationOf } from './otlp-exporter.js';
import type { OtlpExporterStats } from './otlp-exporter.js';
import type { TelemetryReceiverStats } from './receiver.js';
import { exportsPrometheus } from './export-config.js';

export interface TelemetryStatusDeps {
  readonly config: Pick<DaemonConfig, 'telemetry'>;
  /** `composition.telemetry`: `undefined` when the base is not open. */
  readonly store: Pick<TelemetryStore, 'health'> | undefined;
  /** Whether the spans of the daemon itself are on (`composition.daemonSpans`). */
  readonly daemonSpans: boolean;
  /** The receiver, or `undefined` when it is off or could not listen. Read at each call. */
  readonly receiver: () =>
    { readonly port: number; readonly stats: TelemetryReceiverStats } | undefined;
  /** The counters of the OTLP exporter, or `undefined` when it does not run. Read at each call. */
  readonly exporter: () => OtlpExporterStats | undefined;
}

/**
 * The state of the telemetry for the interfaces (Phase 8, P10; [proposta]): the receiver and what it
 * refused, the health of the base, and the export. Counters and states only: no telemetry content,
 * no token, no header, and of the OTLP endpoint only its scheme, host and port. A base that cannot
 * be read gives `base: null` (the failure is the base's, not this route's).
 */
export class TelemetryStatusService {
  readonly #deps: TelemetryStatusDeps;

  constructor(deps: TelemetryStatusDeps) {
    this.#deps = deps;
  }

  async read(): Promise<TelemetryStatus> {
    const { config, store } = this.#deps;
    const telemetry = config.telemetry;
    const receiver = this.#deps.receiver();
    const state: TelemetryStatus['state'] =
      telemetry.enabled === 'off'
        ? 'off'
        : store === undefined
          ? 'no_base'
          : receiver === undefined
            ? 'no_receiver'
            : 'on';
    let base: TelemetryStatus['base'] = null;
    if (store !== undefined) {
      try {
        const health = await store.health();
        base = { ...health };
      } catch {
        base = null;
      }
    }
    const exporter = this.#deps.exporter();
    const endpoint = telemetry.otlp.endpoint;
    return {
      state,
      daemonSpans: this.#deps.daemonSpans,
      receiver:
        receiver === undefined
          ? null
          : {
              port: receiver.port,
              accepted: { ...receiver.stats.accepted },
              rejected: { ...receiver.stats.rejected },
            },
      base,
      export: {
        mode: telemetry.export,
        otlp:
          exporter === undefined || endpoint === null
            ? null
            : {
                destination: destinationOf(endpoint),
                exported: exporter.exported,
                dropped: Object.fromEntries(
                  Object.entries(exporter.dropped).filter(
                    (entry): entry is [string, number] => typeof entry[1] === 'number',
                  ),
                ),
              },
        prometheus: exportsPrometheus(telemetry.export),
      },
    };
  }
}
