// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { InvalidInput } from '../errors.js';
import type { Secret } from '../secret.js';

/** Semver of the `SecretVault` port contract. */
export const SECRET_VAULT_PORT_VERSION = '0.1.0';

/**
 * Key of a secret: a path-like name such as `profile/minimax-main/api-key`. Letters, digits and
 * `. _ : / -`, starting with a letter or digit, case-sensitive. The key is not secret and may
 * appear in logs; the value must not.
 */
export const SECRET_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const SecretKeySchema = z.string().max(256).regex(SECRET_KEY_PATTERN);

/**
 * Vault of secrets (architecture 5.6 and 5.21). Every secret in the daemon goes through this
 * port, never through an environment variable read directly. Default adapter: the OS keyring.
 *
 * Contract (checked by `describeSecretVaultConformance` in `@otheater/sdk`):
 * - Values travel as {@link Secret}: opaque, redacted in `String()`, template strings, JSON and
 *   `console.log`. Only `reveal()` returns the plain text.
 * - An invalid key rejects with `InvalidInput`. Keys are case-sensitive.
 * - A vault that cannot be read now (locked keyring) rejects with `VaultLocked`.
 */
export interface SecretVault {
  /** The secret, or `undefined` when the key does not exist. */
  get(key: string): Promise<Secret | undefined>;

  /** Creates or replaces. */
  set(key: string, value: Secret): Promise<void>;

  /** `true` if the key existed. Deleting a missing key is not an error. */
  delete(key: string): Promise<boolean>;

  /** Keys (never values), ascending by UTF-16 code unit order, optionally limited to a prefix. */
  list(prefix?: string): Promise<readonly string[]>;
}

/**
 * Optional capability of a `SecretVault` that guards its content with a master password (the
 * encrypted-file vault, architecture 5.6). It is **not** part of the `SecretVault` port: adding
 * it there would change the contract, and `SECRET_VAULT_PORT_VERSION` (`0.1.0`) would no longer
 * satisfy the `^0.1.0` range the adapters declare. The daemon asks with
 * {@link isLockableSecretVault} and prompts for the password only when this applies.
 *
 * - While locked, every `SecretVault` operation rejects with `VaultLocked`.
 * - `unlock` with a wrong password rejects with `PermissionDenied` and leaves the vault locked.
 * - `lock` drops the key and the secrets from memory. [proposta] It may be asynchronous (the file
 *   vault queues it behind pending operations), so callers `await` the result.
 */
export interface LockableSecretVault {
  readonly isLocked: boolean;
  unlock(password: Secret): Promise<void>;
  lock(): void | Promise<void>;
}

/** Type guard for the optional {@link LockableSecretVault} capability of a vault. */
export function isLockableSecretVault(
  vault: SecretVault,
): vault is SecretVault & LockableSecretVault {
  const candidate = vault as Partial<Record<keyof LockableSecretVault, unknown>>;
  return (
    typeof candidate.isLocked === 'boolean' &&
    typeof candidate.unlock === 'function' &&
    typeof candidate.lock === 'function'
  );
}

/** Validates a key; throws `InvalidInput`. For adapter authors. */
export function assertSecretKey(key: string): void {
  if (!SecretKeySchema.safeParse(key).success) {
    // The key is not secret, but it may be huge: do not echo it back.
    throw new InvalidInput(
      'Invalid secret key: 1-256 chars of A-Z a-z 0-9 . _ : / -, starting alphanumeric',
    );
  }
}
