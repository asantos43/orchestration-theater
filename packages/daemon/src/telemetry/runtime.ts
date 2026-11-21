// SPDX-License-Identifier: MPL-2.0
import type { SecretVault, TelemetryStore } from '@otheater/core';
import type { DaemonConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { situationText, type SituationSink } from '../situations.js';
import { ClientTelemetry } from './client-telemetry.js';
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
  /** Idempotent: stops the receiver (its last counts are told) and the vault reading. */
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
  if (store === undefined || config.telemetry.enabled === 'off') return undefined;
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
    let stopped: Promise<void> | undefined;
    return {
      receiver,
      clients,
      sessions,
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
