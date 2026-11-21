// SPDX-License-Identifier: MPL-2.0
import type { SecretVault } from '@otheater/core';
import type { Logger } from '../logger.js';

/**
 * The plain values of the SecretVault, kept in memory for the redaction of the telemetry (Phase 8,
 * P2, N212): a client may export a secret it was given (an `env` of a command, a header), and the
 * receiver replaces every value the vault holds with `[redacted]`, whatever attribute it is in.
 * The port has no "all values" call, so they are read with `list` and `get`; the list is refreshed
 * every `refreshMs` and when {@link VaultValues.refresh} is called (a secret added while the daemon
 * runs counts from the next refresh). The values live in this object only, never in a log, an
 * event or the base, and the object is dropped when the daemon stops. [proposta]
 */
export class VaultValues {
  readonly #vault: SecretVault;
  readonly #logger: Pick<Logger, 'warn'> | undefined;
  #values: readonly string[] = [];
  #timer: NodeJS.Timeout | undefined;

  constructor(vault: SecretVault, logger?: Pick<Logger, 'warn'>) {
    this.#vault = vault;
    this.#logger = logger;
  }

  /** The values as of the last refresh. */
  values(): readonly string[] {
    return this.#values;
  }

  /** Reads the vault again. A failure keeps the last values and is logged. */
  async refresh(): Promise<void> {
    try {
      const found: string[] = [];
      for (const key of await this.#vault.list()) {
        const secret = await this.#vault.get(key);
        if (secret !== undefined) found.push(secret.reveal());
      }
      this.#values = found;
    } catch (error) {
      this.#logger?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'the vault values for the telemetry redaction could not be read; the last ones stand',
      );
    }
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
