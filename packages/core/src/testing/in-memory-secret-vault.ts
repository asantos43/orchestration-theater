// SPDX-License-Identifier: MPL-2.0
import { VaultLocked } from '../errors.js';
import { assertSecretKey, type SecretVault } from '../ports/secret-vault.js';
import { Secret } from '../secret.js';

/**
 * `SecretVault` in memory, for tests. `lock()` / `unlock()` simulate a keyring that is locked
 * until the user logs in (architecture 5.21): while locked every operation rejects `VaultLocked`.
 */
export class InMemorySecretVault implements SecretVault {
  readonly #values = new Map<string, string>();
  #locked: boolean;

  constructor(options: { readonly locked?: boolean } = {}) {
    this.#locked = options.locked ?? false;
  }

  lock(): void {
    this.#locked = true;
  }

  unlock(): void {
    this.#locked = false;
  }

  get(key: string): Promise<Secret | undefined> {
    return this.#run(() => {
      assertSecretKey(key);
      const value = this.#values.get(key);
      return value === undefined ? undefined : new Secret(value);
    });
  }

  set(key: string, value: Secret): Promise<void> {
    return this.#run(() => {
      assertSecretKey(key);
      this.#values.set(key, value.reveal());
    });
  }

  delete(key: string): Promise<boolean> {
    return this.#run(() => {
      assertSecretKey(key);
      return this.#values.delete(key);
    });
  }

  list(prefix = ''): Promise<readonly string[]> {
    return this.#run(() =>
      [...this.#values.keys()].filter((k) => k.startsWith(prefix)).sort(compareCodeUnits),
    );
  }

  #run<T>(fn: () => T): Promise<T> {
    try {
      if (this.#locked) throw new VaultLocked('The secret vault is locked');
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
