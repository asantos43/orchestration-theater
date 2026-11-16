// SPDX-License-Identifier: MPL-2.0
import { SECRET_VAULT_PORT_VERSION, Secret } from '@otheater/core';
import { describeSecretVaultConformance } from '@otheater/sdk';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVICE,
  KeyringVault,
  KeyringVaultConfigSchema,
  keyringVaultAdapter,
  mapKeyringError,
  type KeyringBackend,
} from './index.js';

/** In-memory `KeyringBackend`. `failWith` makes every call throw, as a broken keyring would. */
class MemoryBackend implements KeyringBackend {
  readonly entries = new Map<string, string>();
  /** When set, every call throws it. `lock()` sets the message the Secret Service gives. */
  failWith: Error | undefined;

  lock(): void {
    this.failWith = new Error('Secret Service: object locked');
  }

  unlock(): void {
    this.failWith = undefined;
  }

  get(service: string, account: string): Promise<string | undefined> {
    return this.#run(() => this.entries.get(id(service, account)));
  }

  set(service: string, account: string, value: string): Promise<void> {
    return this.#run(() => {
      this.entries.set(id(service, account), value);
    });
  }

  delete(service: string, account: string): Promise<boolean> {
    return this.#run(() => this.entries.delete(id(service, account)));
  }

  accounts(service: string): Promise<readonly string[]> {
    return this.#run(() =>
      [...this.entries.keys()]
        .filter((entry) => entry.startsWith(`${service}\u0000`))
        .map((entry) => entry.slice(service.length + 1)),
    );
  }

  #run<T>(operation: () => T): Promise<T> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(operation());
  }
}

function id(service: string, account: string): string {
  return `${service}\u0000${account}`;
}

describeSecretVaultConformance('KeyringVault (in-memory backend)', () => {
  const backend = new MemoryBackend();
  const vault = new KeyringVault({ service: 'otheater-test' }, { backend });
  return {
    vault,
    lock: () => {
      backend.lock();
    },
    unlock: () => {
      backend.unlock();
    },
  };
});

describe('KeyringVault', () => {
  function setup(service?: string) {
    const backend = new MemoryBackend();
    const vault = new KeyringVault(service === undefined ? {} : { service }, { backend });
    return { backend, vault };
  }

  it('stores one entry per key under the configured service, with the value never bare', async () => {
    const { backend, vault } = setup('svc');
    await vault.set('profile/a/api-key', new Secret('sk-1'));
    expect([...backend.entries.keys()]).toEqual(['svc\u0000profile/a/api-key']);
    expect([...backend.entries.values()]).toEqual(['ot1:sk-1']);
  });

  it('uses the default service name', async () => {
    const { backend, vault } = setup();
    await vault.set('k', new Secret('v'));
    expect([...backend.entries.keys()]).toEqual([`${DEFAULT_SERVICE}\u0000k`]);
    expect(DEFAULT_SERVICE).toBe('otheater');
  });

  it('keeps services apart', async () => {
    const backend = new MemoryBackend();
    const a = new KeyringVault({ service: 'a' }, { backend });
    const b = new KeyringVault({ service: 'b' }, { backend });
    await a.set('k', new Secret('from-a'));
    expect(await b.get('k')).toBeUndefined();
    expect(await b.list()).toEqual([]);
    expect(await a.list()).toEqual(['k']);
  });

  it('round-trips the empty value (stored as a non-empty text)', async () => {
    const { backend, vault } = setup('svc');
    await vault.set('empty', new Secret(''));
    expect(backend.entries.get('svc\u0000empty')).toBe('ot1:');
    expect((await vault.get('empty'))?.reveal()).toBe('');
  });

  it('reads an entry without the prefix as it is (made outside)', async () => {
    const { backend, vault } = setup('svc');
    backend.entries.set('svc\u0000by-hand', 'plain value');
    expect((await vault.get('by-hand'))?.reveal()).toBe('plain value');
  });

  it('a value that itself starts with the prefix survives the round trip', async () => {
    const { vault } = setup();
    await vault.set('k', new Secret('ot1:inner'));
    expect((await vault.get('k'))?.reveal()).toBe('ot1:inner');
  });

  it('list ignores entries of the service that are not valid keys', async () => {
    const { backend, vault } = setup('svc');
    await vault.set('good/key', new Secret('v'));
    backend.entries.set('svc\u0000has space', 'x');
    backend.entries.set('svc\u0000-leading', 'x');
    backend.entries.set('svc\u0000' + 'a'.repeat(300), 'x');
    expect(await vault.list()).toEqual(['good/key']);
  });

  it('validates keys before touching the keyring', async () => {
    const { backend, vault } = setup();
    backend.failWith = new Error('should not be reached');
    await expect(vault.get('bad key')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(vault.set('', new Secret('v'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(vault.delete('/x')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a value that is not a Secret', async () => {
    const { vault } = setup();
    await expect(vault.set('k', 'plain string' as unknown as Secret)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('maps backend failures on every operation and keeps the original as cause', async () => {
    const { backend, vault } = setup();
    const native = new Error('No DBus session or Secret Service provider found');
    backend.failWith = native;
    const calls = [
      () => vault.get('k'),
      () => vault.set('k', new Secret('v')),
      () => vault.delete('k'),
      () => vault.list(),
    ];
    for (const call of calls) {
      const error: unknown = await call().catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'ADAPTER_UNAVAILABLE', cause: native });
    }
  });

  it('an error does not echo the value being stored', async () => {
    const { backend, vault } = setup();
    backend.failWith = new Error('Platform secure storage failure');
    const value = 'sk-do-not-leak-0123';
    const error = await vault.set('k', new Secret(value)).catch((e: unknown) => e);
    expect(String(error)).not.toContain(value);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(value);
  });

  it('declares the SecretVault port with a range that covers its version', () => {
    expect(keyringVaultAdapter).toEqual({
      id: 'keyring',
      implements: { port: 'SecretVault', range: `^${SECRET_VAULT_PORT_VERSION}` },
    });
    expect(keyringVaultAdapter.implements.range).toBe('^0.1.0');
  });
});

describe('mapKeyringError', () => {
  const cases: [string, string][] = [
    ['Secret Service: object locked', 'VAULT_LOCKED'],
    ['Secret Service: unlock prompt was dismissed', 'VAULT_LOCKED'],
    ['SS error: prompt dismissed', 'VAULT_LOCKED'],
    ['No DBus session or Secret Service provider found', 'ADAPTER_UNAVAILABLE'],
    ['no secret service provider or dbus session found', 'ADAPTER_UNAVAILABLE'],
    ['No storage access: denied', 'ADAPTER_UNAVAILABLE'],
    ['Platform secure storage failure: boom', 'ADAPTER_UNAVAILABLE'],
    ['No default store has been set, so cannot search or create entries', 'ADAPTER_UNAVAILABLE'],
    ['Attribute password is too long for this platform', 'INVALID_INPUT'],
    ['something nobody has seen before', 'ADAPTER_UNAVAILABLE'],
  ];

  it.each(cases)('%s -> %s', (message, code) => {
    const original = new Error(message);
    const mapped = mapKeyringError(original);
    expect(mapped.code).toBe(code);
    expect(mapped.cause).toBe(original);
    expect(mapped.message).not.toContain(message); // the library's text stays in `cause`
  });

  it('maps a thrown non-Error', () => {
    expect(mapKeyringError('boom')).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });

  it('passes OTheater errors through untouched', () => {
    const original = mapKeyringError(new Error('Secret Service: object locked'));
    expect(mapKeyringError(original)).toBe(original);
  });
});

describe('config', () => {
  it('defaults the service and pins the Secret Service on Linux', () => {
    expect(KeyringVaultConfigSchema.parse({})).toEqual({
      service: 'otheater',
      linuxStore: 'secret-service',
    });
  });

  it('rejects an empty service, an unknown store and unknown keys', () => {
    for (const bad of [{ service: '' }, { service: '   ' }, { linuxStore: 'keyutils' }, { x: 1 }]) {
      expect(KeyringVaultConfigSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('the constructor reports a bad config as INVALID_INPUT', () => {
    expect(() => new KeyringVault({ service: '' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }) as Error,
    );
  });
});
