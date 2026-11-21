// SPDX-License-Identifier: MPL-2.0
import type { Clock, SecretVault, TelemetryStore } from '@otheater/core';
import type { DaemonConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { situationText, type SituationSink } from '../situations.js';
import { ClientTelemetry } from './client-telemetry.js';
import { exportsOtlp } from './export-config.js';
import { OtlpExporter } from './otlp-exporter.js';
import { TelemetryReceiver } from './receiver.js';
import { Redactor } from './redaction.js';
import { TelemetrySessions } from './sessions.js';
import { VaultValues } from './vault-values.js';

/** What the daemon holds while telemetry is on (Phase 8, P2): the receiver and what feeds it. */
export interface TelemetryRuntime {
  readonly receiver: TelemetryReceiver;
  /** Builds the `ClientOtel` of each session; the session pool uses it. */
  readonly clients: ClientTelemetry;
  readonly sessions: TelemetrySessions;
  /** The OTLP exporter (P7), or `undefined` when `telemetry.export` does not send OTLP. Started. */
  readonly exporter: OtlpExporter | undefined;
  /**
   * The last pass of the exporter and its end (P7). The daemon calls it after the last spans are in
   * the base and before the base closes; the receiver is not touched. Idempotent, never rejects.
   */
  stopExporter(): Promise<void>;
  /**
   * Idempotent: stops the receiver (its last counts are told) and the vault reading. The exporter
   * is not stopped here: it must send the last spans, so {@link stopExporter} comes later.
   */
  stop(): Promise<void>;
}

export interface TelemetryRuntimeInput {
  readonly config: DaemonConfig;
  /** `composition.telemetry`: `undefined` when `telemetry.enabled` is `off` or no base is open. */
  readonly store: TelemetryStore | undefined;
  readonly vault: SecretVault;
  readonly logger: Logger;
  readonly situations: SituationSink;
  /** The scenario of a play, for the resource of the sessions that only know the play. */
  readonly scenarioOf: (playId: string) => Promise<string | null | undefined>;
  /** Extra resource attributes by session (P4 puts `otheater.trace_id` here). */
  /** The clock of the exporter's waits (P7). With none, `telemetry.export` cannot send OTLP. */
  readonly clock?: Clock;
  readonly resourceExtras?: ConstructorParameters<typeof ClientTelemetry>[0]['resourceExtras'];
}

/**
 * Starts the OTLP receiver and the pieces around it, or returns `undefined` when telemetry is off.
 * A receiver that cannot listen does not stop the daemon: the clients start with no telemetry, the
 * log has a warning and the situation `daemon.notice` (`telemetry_receiver_unavailable`) is written
 * (no token, no content). [proposta]
 */
export async function startTelemetry(
  input: TelemetryRuntimeInput,
): Promise<TelemetryRuntime | undefined> {
  const { config, store, logger, situations } = input;
  if (store === undefined || config.telemetry.enabled === 'off') {
    if (exportsOtlp(config.telemetry.export)) {
      logger.warn(
        'telemetry.export asks for OTLP, but there is no telemetry base: nothing is sent',
      );
    }
    return undefined;
  }
  const values = new VaultValues(input.vault, logger);
  const sessions = new TelemetrySessions();
  try {
    await values.start();
    const receiver = await TelemetryReceiver.start({
      store,
      sessions,
      redactor: new Redactor({
        mode: config.telemetry.redaction,
        secrets: () => values.values(),
      }),
      port: config.telemetry.receiver.port,
      maxBody: config.telemetry.receiver.max_body,
      logger,
      situations,
    });
    const clients = new ClientTelemetry({
      endpoint: receiver.url,
      token: receiver.token,
      config: config.telemetry,
      sessions,
      logger,
      scenarioOf: input.scenarioOf,
      ...(input.resourceExtras === undefined ? {} : { resourceExtras: input.resourceExtras }),
    });
    const exporter = startExporter(input, store);
    let stopped: Promise<void> | undefined;
    let exporterStopped: Promise<void> | undefined;
    return {
      receiver,
      clients,
      sessions,
      exporter,
      stopExporter: () =>
        (exporterStopped ??= (async () => {
          if (exporter === undefined) return;
          try {
            await store.flush();
            await exporter.finish();
          } catch (error) {
            logger.debug({ err: situationText(error, 200) }, 'the last OTLP pass failed');
          }
          await exporter.stop();
        })()),
      stop: () =>
        (stopped ??= (async () => {
          await receiver.stop();
          values.stop();
        })()),
    };
  } catch (error) {
    values.stop();
    logger.warn(
      { err: situationText(error, 200) },
      'the telemetry receiver could not start; the clients send nothing',
    );
    situations.record('daemon.notice', {
      kind: 'telemetry_receiver_unavailable',
      subject: 'receiver',
      detail: situationText(error),
    });
    return undefined;
  }
}

/**
 * The OTLP exporter (P7), started when `telemetry.export` sends OTLP and there is an endpoint. A
 * constructor that refuses (no endpoint: the config refuses that too) leaves the daemon with no
 * export and a warning; the daemon is never stopped by it.
 */
function startExporter(
  input: TelemetryRuntimeInput,
  store: TelemetryStore,
): OtlpExporter | undefined {
  const { config, logger, clock } = input;
  if (!exportsOtlp(config.telemetry.export)) return undefined;
  if (clock === undefined) {
    logger.warn('the OTLP export has no clock; nothing is sent');
    return undefined;
  }
  try {
    const exporter = new OtlpExporter({
      telemetry: store,
      config: config.telemetry.otlp,
      vault: input.vault,
      clock,
      logger,
      situations: input.situations,
    });
    exporter.start();
    return exporter;
  } catch (error) {
    logger.warn({ err: situationText(error, 200) }, 'the OTLP exporter could not start');
    return undefined;
  }
}
