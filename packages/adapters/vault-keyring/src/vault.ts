// SPDX-License-Identifier: MPL-2.0
import {
  assertSecretKey,
  InvalidInput,
  isSecret,
  Secret,
  SECRET_KEY_PATTERN,
  type SecretVault,
} from '@otheater/core';
import { NativeKeyringBackend, type KeyringBackend } from './backend.js';
import {
  KeyringVaultConfigSchema,
  type KeyringVaultConfig,
  type KeyringVaultConfigInput,
} from './config.js';
import { mapKeyringError } from './errors.js';

/**
 * [proposta] Entries are stored as `PREFIX + value`. The prefix versions the encoding, and it
 * makes the stored text never empty: some platforms refuse or lose an empty password, and the
 * port has to round-trip `''`. An entry without the prefix (made by hand, say with a tool of the
 * OS) is read as it is, so a value put in the keyring from outside is still usable.
 */
const VALUE_PREFIX = 'ot1:';

export interface KeyringVaultOptions {
  /** Replaces the OS keyring, for tests. */
  readonly backend?: KeyringBackend;
}

/**
 * `SecretVault` on the operating-system keyring (architecture 5.6): Keychain on macOS, Secret
 * Service on Linux, Credential Manager on Windows, through `@napi-rs/keyring`. One entry per key,
 * `service` = the configured service name, `account` = the key.
 *
 * Errors: a locked store is `VaultLocked`, a missing or broken one `AdapterUnavailable` (the
 * daemon's cue to fall back to `vault-file`), see `mapKeyringError`. The keyring has no lock of
 * its own to drive, so this class has no `lock`/`unlock`.
 */
export class KeyringVault implements SecretVault {
  readonly #config: KeyringVaultConfig;
  readonly #backend: KeyringBackend;

  /** Throws `InvalidInput` when the config does not pass its schema. */
  constructor(config: KeyringVaultConfigInput = {}, options: KeyringVaultOptions = {}) {
    const parsed = KeyringVaultConfigSchema.safeParse(config);
    if (!parsed.success) {
      const where = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new InvalidInput(`Invalid keyring vault config (${where})`);
    }
    this.#config = parsed.data;
    this.#backend =
      options.backend ?? new NativeKeyringBackend({ linuxStore: parsed.data.linuxStore });
  }

  async get(key: string): Promise<Secret | undefined> {
    assertSecretKey(key);
    const stored = await this.#call(() => this.#backend.get(this.#config.service, key));
    return stored === undefined ? undefined : new Secret(decode(stored));
  }

  async set(key: string, value: Secret): Promise<void> {
    assertSecretKey(key);
    if (!isSecret(value)) throw new InvalidInput('The value must be a Secret');
    const stored = VALUE_PREFIX + value.reveal();
    await this.#call(() => this.#backend.set(this.#config.service, key, stored));
  }

  async delete(key: string): Promise<boolean> {
    assertSecretKey(key);
    return this.#call(() => this.#backend.delete(this.#config.service, key));
  }

  async list(prefix = ''): Promise<readonly string[]> {
    const accounts = await this.#call(() => this.#backend.accounts(this.#config.service));
    // Entries under the service that are not valid keys (made by hand) are not part of the vault.
    return accounts
      .filter((account) => SECRET_KEY_PATTERN.test(account) && account.length <= 256)
      .filter((account) => account.startsWith(prefix))
      .sort();
  }

  async #call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapKeyringError(error);
    }
  }
}

function decode(stored: string): string {
  return stored.startsWith(VALUE_PREFIX) ? stored.slice(VALUE_PREFIX.length) : stored;
}
