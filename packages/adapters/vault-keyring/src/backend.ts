// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable } from '@otheater/core';

/**
 * What the vault needs from a keyring, by service and account. A plain string in, a plain string
 * out: encoding, validation and error mapping stay in `KeyringVault`, so the vault can be tested
 * against an in-memory backend, and the library can be swapped without touching it.
 * Backends throw whatever their library throws; `KeyringVault` maps it (`errors.ts`).
 */
export interface KeyringBackend {
  /** The stored text, or `undefined` when there is no entry. */
  get(service: string, account: string): Promise<string | undefined>;
  set(service: string, account: string, value: string): Promise<void>;
  /** `true` if an entry was removed. */
  delete(service: string, account: string): Promise<boolean>;
  /** Accounts of every entry stored under `service`, in no particular order. */
  accounts(service: string): Promise<readonly string[]>;
}

/** The slice of `@napi-rs/keyring` this adapter uses (what tests replace by a fake). */
export interface NativeEntry {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export interface NativeKeyring {
  AsyncEntry: new (
    service: string,
    username: string,
    options?: { linux?: { store?: 'secret-service' | 'keyutils' } } | null,
  ) => NativeEntry;
  findCredentialsAsync(service: string): Promise<readonly { account: string }[]>;
}

export interface NativeBackendOptions {
  /** See `KeyringVaultConfig.linuxStore`. */
  readonly linuxStore: 'secret-service' | 'auto';
  /** Loads the library. Defaults to `import('@napi-rs/keyring')`; tests inject a fake. */
  readonly load?: () => Promise<NativeKeyring>;
  /** Defaults to `process.platform`; tests inject another. */
  readonly platform?: NodeJS.Platform;
}

/** Account name of the entry used only to ask the store "are you there?". It is never written. */
const PROBE_ACCOUNT = '.otheater-availability-probe';

async function loadNative(): Promise<NativeKeyring> {
  // Dynamic on purpose [proposta]: the package has no JS fallback, and its `require` throws when
  // the binary for this platform was not installed (an optional dependency). Loading on first use
  // turns that into `AdapterUnavailable` instead of a crash when the adapter is merely imported.
  return import('@napi-rs/keyring');
}

/** `KeyringBackend` over `@napi-rs/keyring` (async API: calls run on the libuv thread pool). */
export class NativeKeyringBackend implements KeyringBackend {
  readonly #options: NativeBackendOptions;
  #native: Promise<NativeKeyring> | undefined;

  constructor(options: NativeBackendOptions) {
    this.#options = options;
  }

  async get(service: string, account: string): Promise<string | undefined> {
    const entry = await this.#entry(service, account);
    return (await entry.getPassword()) ?? undefined;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    await (await this.#entry(service, account)).setPassword(value);
  }

  async delete(service: string, account: string): Promise<boolean> {
    return (await this.#entry(service, account)).deleteCredential();
  }

  async accounts(service: string): Promise<readonly string[]> {
    const native = await this.#library();
    // The search function takes no store option: on Linux it would silently look in the kernel
    // keyring when the Secret Service is down, and report an empty vault. A read of an entry
    // pinned to the Secret Service fails loudly in that case, so do that first.
    if (this.#pinsSecretService()) {
      await (await this.#entry(service, PROBE_ACCOUNT)).getPassword();
    }
    return (await native.findCredentialsAsync(service)).map((credential) => credential.account);
  }

  #pinsSecretService(): boolean {
    return (
      (this.#options.platform ?? process.platform) === 'linux' &&
      this.#options.linuxStore === 'secret-service'
    );
  }

  async #entry(service: string, account: string): Promise<NativeEntry> {
    const native = await this.#library();
    return new native.AsyncEntry(
      service,
      account,
      this.#pinsSecretService() ? { linux: { store: 'secret-service' } } : undefined,
    );
  }

  #library(): Promise<NativeKeyring> {
    this.#native ??= (this.#options.load ?? loadNative)().catch((error: unknown) => {
      this.#native = undefined; // a later call may try again
      throw new AdapterUnavailable(
        'The native keyring library could not be loaded (no binary for this platform?). Use the encrypted-file vault.',
        { cause: error },
      );
    });
    return this.#native;
  }
}
