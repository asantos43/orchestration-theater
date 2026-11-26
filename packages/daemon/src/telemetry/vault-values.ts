// SPDX-License-Identifier: MPL-2.0
import type { SecretVault } from '@otheater/core';
import type { TelemetryVaultWarningMode } from '../config.js';
import type { Logger } from '../logger.js';
import { situationText, type SituationSink } from '../situations.js';

export interface VaultValuesOptions {
  /** `telemetry.vault_warning` (N331): how a vault that cannot be read is told. Default `on_change`. */
  readonly warning?: TelemetryVaultWarningMode;
  /** Where the `daemon.notice` (`telemetry_vault_unreadable`) goes; with none, only the log. */
  readonly situations?: SituationSink;
}

/**
 * The plain values of the SecretVault, kept in memory for the redaction of the telemetry (Phase 8,
 * P2, N212): a client may export a secret it was given (an `env` of a command, a header), and the
 * receiver replaces every value the vault holds with `[redacted]`, whatever attribute it is in.
 * The port has no "all values" call, so they are read with `list` and `get`; the list is refreshed
 * every `refreshMs` and when {@link VaultValues.refresh} is called (a secret added while the daemon
 * runs counts from the next refresh). The values live in this object only, never in a log, an
 * event or the base, and the object is dropped when the daemon stops. [proposta]
 *
 * A vault that cannot be read (a locked one, most often) keeps the last values. How it is told is
 * `telemetry.vault_warning` (N331; [proposta]): `on_change` (default) warns once, and again only
 * when the reason changes, and says so (info) when the vault can be read again; `every` warns at
 * each failed refresh, as before N331; `off` leaves it to the debug log. Each warning is also the
 * `daemon.notice` `telemetry_vault_unreadable`.
 */
export class VaultValues {
  readonly #vault: SecretVault;
  readonly #logger: Pick<Logger, 'warn' | 'info' | 'debug'> | undefined;
  readonly #warning: TelemetryVaultWarningMode;
  readonly #situations: SituationSink | undefined;
  #values: readonly string[] = [];
  #timer: NodeJS.Timeout | undefined;
  /** The reason of the last failed refresh, or `undefined` when the last one read the vault. */
  #failure: string | undefined;

  constructor(
    vault: SecretVault,
    logger?: Pick<Logger, 'warn' | 'info' | 'debug'>,
    options: VaultValuesOptions = {},
  ) {
    this.#vault = vault;
    this.#logger = logger;
    this.#warning = options.warning ?? 'on_change';
    this.#situations = options.situations;
  }

  /** The values as of the last refresh. */
  values(): readonly string[] {
    return this.#values;
  }

  /** Reads the vault again. A failure keeps the last values and is told as `vault_warning` says. */
  async refresh(): Promise<void> {
    let found: string[];
    try {
      found = [];
      for (const key of await this.#vault.list()) {
        const secret = await this.#vault.get(key);
        if (secret !== undefined) found.push(secret.reveal());
      }
    } catch (error) {
      this.#failed(error);
      return;
    }
    this.#values = found;
    if (this.#failure !== undefined && this.#warning === 'on_change') {
      this.#logger?.info('the vault values for the telemetry redaction can be read again');
    }
    this.#failure = undefined;
  }

  #failed(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const changed = reason !== this.#failure;
    this.#failure = reason;
    const message =
      'the vault values for the telemetry redaction could not be read; the last ones stand';
    if (this.#warning === 'off' || (this.#warning === 'on_change' && !changed)) {
      this.#logger?.debug({ err: reason }, message);
      return;
    }
    this.#logger?.warn({ err: reason }, message);
    this.#situations?.record('daemon.notice', {
      kind: 'telemetry_vault_unreadable',
      subject: 'vault',
      detail: situationText(error),
    });
  }

  /** Refreshes now and then every `refreshMs` (the timer does not keep the process alive). */
  async start(refreshMs = 30_000): Promise<void> {
    await this.refresh();
    this.#timer = setInterval(() => {
      void this.refresh();
    }, refreshMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#values = [];
  }
}
