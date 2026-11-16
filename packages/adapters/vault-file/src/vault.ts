// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  assertSecretKey,
  InvalidInput,
  isOTheaterError,
  PermissionDenied,
  Secret,
  VaultLocked,
  type SecretVault,
} from '@otheater/core';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import {
  EncryptedFileVaultConfigSchema,
  type EncryptedFileVaultConfig,
  type EncryptedFileVaultConfigInput,
  type ScryptParams,
} from './config.js';
import { decryptFile, deriveKey, encryptFile, newSalt, parseFile } from './format.js';
import { ensureDirectory, readVaultFile, writeFileAtomic } from './files.js';

/** Everything that exists only while the vault is unlocked. */
interface Unlocked {
  readonly key: Buffer;
  readonly salt: Buffer;
  readonly kdf: ScryptParams;
  /** Replaced (never mutated) by each successful write. Values are zero-able buffers. */
  secrets: Map<string, Buffer>;
}

function wipe(state: Unlocked): void {
  state.key.fill(0);
  for (const value of state.secrets.values()) value.fill(0);
  state.secrets.clear();
}

/**
 * `SecretVault` backed by one file encrypted with a master password (architecture 5.6: fallback
 * for Linux without Secret Service). AES-256-GCM, key derived with scrypt; see `format.ts`.
 *
 * Lifecycle: the vault starts **locked**. `unlock(password)` opens the file, or creates it when
 * it does not exist. While locked every operation rejects `VaultLocked`. `lock()` drops the
 * derived key and the secrets from memory (buffers are zeroed; JS strings made from them are
 * out of reach and wait for the garbage collector). The password is never kept: only the derived
 * key is, so writes do not pay scrypt again. Nothing is ever written in clear.
 *
 * Writes are serialized inside the process (one queue for every call, so a `get` after a `set`
 * sees it). Memory changes only after the file was replaced, so a failed write (disk full) leaves
 * both as they were. [proposta] One process owns the file: the content is read at `unlock` and
 * is not re-read, and two processes on the same file would overwrite each other.
 */
export class EncryptedFileVault implements SecretVault {
  readonly #path: string;
  readonly #config: EncryptedFileVaultConfig;
  #state: Unlocked | undefined;
  #tail: Promise<unknown> = Promise.resolve();

  /** Throws `InvalidInput` when the config does not pass its schema. */
  constructor(config: EncryptedFileVaultConfigInput) {
    const parsed = EncryptedFileVaultConfigSchema.safeParse(config);
    if (!parsed.success) {
      const where = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new InvalidInput(`Invalid encrypted-file vault config (${where})`);
    }
    this.#config = parsed.data;
    this.#path = resolve(parsed.data.path);
  }

  /** `true` until `unlock` succeeds, and again after `lock`. */
  get isLocked(): boolean {
    return this.#state === undefined;
  }

  /**
   * Opens the vault with the master password, or creates the file when it does not exist.
   *
   * - Wrong password (or a file that was modified): `PermissionDenied`; the vault stays as it was.
   * - Corrupted file, unknown version, unreadable file: `AdapterUnavailable`; nothing is touched.
   * - Empty password: `InvalidInput`.
   * - Already unlocked: only checks the password against the one in use (no state change).
   */
  unlock(password: Secret): Promise<void> {
    return this.#enqueue(async () => {
      const bytes = Buffer.from(password.reveal(), 'utf8');
      try {
        if (bytes.length === 0) throw new InvalidInput('The master password must not be empty');
        const current = this.#state;
        if (current !== undefined) {
          const key = await deriveKey(bytes, current.salt, current.kdf);
          const same = timingSafeEqual(key, current.key);
          key.fill(0);
          if (!same) throw new PermissionDenied('Wrong master password.');
          return;
        }
        this.#state = await this.#open(bytes);
      } catch (error) {
        throw isOTheaterError(error) ? error : unreadable(error);
      } finally {
        bytes.fill(0);
      }
    });
  }

  /** Drops the key and the secrets from memory. Pending operations finish first. */
  lock(): Promise<void> {
    return this.#enqueue(() => {
      if (this.#state !== undefined) wipe(this.#state);
      this.#state = undefined;
      return Promise.resolve();
    });
  }

  get(key: string): Promise<Secret | undefined> {
    return this.#enqueue(() => {
      const state = this.#unlocked();
      assertSecretKey(key);
      const value = state.secrets.get(key);
      return Promise.resolve(value === undefined ? undefined : new Secret(value.toString('utf8')));
    });
  }

  set(key: string, value: Secret): Promise<void> {
    return this.#enqueue(async () => {
      const state = this.#unlocked();
      assertSecretKey(key);
      const added = Buffer.from(value.reveal(), 'utf8');
      const next = new Map(state.secrets);
      const replaced = next.get(key);
      next.set(key, added);
      try {
        await this.#persist(state, next);
      } catch (error) {
        added.fill(0);
        throw error;
      }
      replaced?.fill(0);
    });
  }

  delete(key: string): Promise<boolean> {
    return this.#enqueue(async () => {
      const state = this.#unlocked();
      assertSecretKey(key);
      const removed = state.secrets.get(key);
      if (removed === undefined) return false;
      const next = new Map(state.secrets);
      next.delete(key);
      await this.#persist(state, next);
      removed.fill(0);
      return true;
    });
  }

  list(prefix = ''): Promise<readonly string[]> {
    return this.#enqueue(() => {
      const state = this.#unlocked();
      // Default sort() compares UTF-16 code units, the order the port asks for.
      return Promise.resolve([...state.secrets.keys()].filter((k) => k.startsWith(prefix)).sort());
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  #unlocked(): Unlocked {
    if (this.#state === undefined) throw new VaultLocked('The secret vault is locked');
    return this.#state;
  }

  /** Writes the new map; only after the file is replaced does memory switch to it. */
  async #persist(state: Unlocked, next: Map<string, Buffer>): Promise<void> {
    const text = encryptFile(state.key, state.salt, state.kdf, next);
    try {
      await writeFileAtomic(this.#path, text);
    } catch (error) {
      throw unreadable(error, 'write');
    }
    state.secrets = next;
  }

  /** Reads the file and derives the key; creates the file when it does not exist. */
  async #open(password: Buffer): Promise<Unlocked> {
    let text: string | undefined;
    try {
      text = await readVaultFile(this.#path);
    } catch (error) {
      throw unreadable(error, 'read');
    }

    if (text !== undefined) {
      const file = parseFile(text);
      const key = await deriveKey(password, file.salt, file.kdf);
      try {
        return { key, salt: file.salt, kdf: file.kdf, secrets: decryptFile(file, key) };
      } catch (error) {
        key.fill(0);
        throw error;
      }
    }

    const salt = newSalt();
    const kdf = this.#config.scrypt;
    const state: Unlocked = {
      key: await deriveKey(password, salt, kdf),
      salt,
      kdf,
      secrets: new Map(),
    };
    try {
      await ensureDirectory(this.#path);
      await writeFileAtomic(this.#path, encryptFile(state.key, salt, kdf, state.secrets));
    } catch (error) {
      wipe(state);
      throw unreadable(error, 'create');
    }
    return state;
  }
}

/** I/O failures become `AdapterUnavailable`; the message names the step, never any content. */
function unreadable(error: unknown, step = 'open'): AdapterUnavailable {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? ` (${error.code})`
      : '';
  return new AdapterUnavailable(`Could not ${step} the vault file${code}`, { cause: error });
}
