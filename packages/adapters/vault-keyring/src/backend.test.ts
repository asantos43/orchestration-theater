// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { NativeKeyringBackend, type NativeKeyring } from './index.js';

/** Fake of the library: records how it is called. It never touches a real keyring. */
function fakeNative() {
  const calls: { service: string; account: string; options: unknown }[] = [];
  const store = new Map<string, string>();
  const native: NativeKeyring = {
    AsyncEntry: class {
      readonly #id: string;
      constructor(
        readonly service: string,
        readonly account: string,
        options?: unknown,
      ) {
        this.#id = `${service}\u0000${account}`;
        calls.push({ service, account, options });
      }
      getPassword(): Promise<string | null> {
        return Promise.resolve(store.get(this.#id) ?? null);
      }
      setPassword(password: string): Promise<void> {
        store.set(this.#id, password);
        return Promise.resolve();
      }
      deleteCredential(): Promise<boolean> {
        return Promise.resolve(store.delete(this.#id));
      }
    },
    findCredentialsAsync(service: string) {
      return Promise.resolve(
        [...store.keys()]
          .filter((id) => id.startsWith(`${service}\u0000`))
          .map((id) => ({ account: id.slice(service.length + 1) })),
      );
    },
  };
  return { native, calls, store };
}

describe('NativeKeyringBackend (fake library)', () => {
  it('maps null to undefined and round-trips set/get/delete/accounts', async () => {
    const { native } = fakeNative();
    const backend = new NativeKeyringBackend({
      linuxStore: 'auto',
      platform: 'darwin',
      load: () => Promise.resolve(native),
    });
    expect(await backend.get('svc', 'a')).toBeUndefined();
    await backend.set('svc', 'a', 'one');
    await backend.set('svc', 'b', 'two');
    await backend.set('other', 'c', 'three');
    expect(await backend.get('svc', 'a')).toBe('one');
    expect([...(await backend.accounts('svc'))].sort()).toEqual(['a', 'b']);
    expect(await backend.delete('svc', 'a')).toBe(true);
    expect(await backend.delete('svc', 'a')).toBe(false);
  });

  it('pins the Secret Service on Linux and probes before listing', async () => {
    const { native, calls } = fakeNative();
    const backend = new NativeKeyringBackend({
      linuxStore: 'secret-service',
      platform: 'linux',
      load: () => Promise.resolve(native),
    });
    await backend.set('svc', 'a', 'v');
    expect(calls.at(-1)).toMatchObject({ options: { linux: { store: 'secret-service' } } });

    calls.length = 0;
    await backend.accounts('svc');
    // One read of the probe entry (never written), pinned like the rest.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      service: 'svc',
      account: '.otheater-availability-probe',
      options: { linux: { store: 'secret-service' } },
    });
  });

  it('does not pin the store (and does not probe) on other platforms or in auto mode', async () => {
    for (const [platform, linuxStore] of [
      ['darwin', 'secret-service'],
      ['win32', 'secret-service'],
      ['linux', 'auto'],
    ] as const) {
      const { native, calls } = fakeNative();
      const backend = new NativeKeyringBackend({
        linuxStore,
        platform,
        load: () => Promise.resolve(native),
      });
      await backend.set('svc', 'a', 'v');
      await backend.accounts('svc');
      expect(calls.map((c) => c.options)).toEqual([undefined]);
    }
  });

  it('a library that cannot be loaded is ADAPTER_UNAVAILABLE, and the next call tries again', async () => {
    const { native } = fakeNative();
    let attempts = 0;
    const backend = new NativeKeyringBackend({
      linuxStore: 'auto',
      load: () => {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error('Cannot find native binding'))
          : Promise.resolve(native);
      },
    });
    await expect(backend.get('svc', 'a')).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    expect(await backend.get('svc', 'a')).toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('loads the real library lazily, only when first used (importing it touches no keyring)', async () => {
    // Only the constructor: nothing is loaded and no entry is accessed.
    expect(() => new NativeKeyringBackend({ linuxStore: 'secret-service' })).not.toThrow();
    const real = (await import('@napi-rs/keyring')) as unknown as NativeKeyring;
    expect(typeof real.AsyncEntry).toBe('function');
    expect(typeof real.findCredentialsAsync).toBe('function');
  });
});
