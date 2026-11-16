// SPDX-License-Identifier: MPL-2.0
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterUnavailable, InvalidInput, type Adapter } from '@otheater/core';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { checkAdapterRange, compose, composeClock } from './compose.js';
import { parseConfig } from './config.js';
import { makeTempDataDir } from './test-helpers.js';

const adapter = (port: string, range: string): Adapter => ({
  id: 'x',
  implements: { port, range },
});

describe('checkAdapterRange', () => {
  it('accepts a range that covers the port version and reports what it saw', () => {
    expect(checkAdapterRange(adapter('Store', '^0.1.0'), 'Store', '0.1.0')).toEqual({
      port: 'Store',
      id: 'x',
      range: '^0.1.0',
      portVersion: '0.1.0',
    });
  });

  it('rejects an adapter for another port as InvalidInput', () => {
    expect(() => checkAdapterRange(adapter('Clock', '^0.1.0'), 'Store', '0.1.0')).toThrow(
      InvalidInput,
    );
  });

  it('rejects a range that is not semver as InvalidInput', () => {
    expect(() => checkAdapterRange(adapter('Store', 'banana'), 'Store', '0.1.0')).toThrow(
      InvalidInput,
    );
  });

  it('rejects a range that does not cover the version as AdapterUnavailable, naming both', () => {
    const run = (): unknown => checkAdapterRange(adapter('Store', '^0.2.0'), 'Store', '0.1.0');
    expect(run).toThrow(AdapterUnavailable);
    expect(run).toThrow(/Store version 0\.1\.0.*\^0\.2\.0/);
  });
});

describe('compose', () => {
  it('builds the real adapters from the defaults, records them and closes once', async () => {
    const tmp = await makeTempDataDir();
    try {
      const config = parseConfig(
        'adapters:\n  vault: encrypted-file\nvault:\n  scrypt: { N: 16384, r: 8, p: 1 }\nlog:\n  destination: file\n',
      );
      const composition = await compose(config, { dataDir: tmp.dir });
      expect(composition.adapters.map(({ port, id }) => `${port}:${id}`)).toEqual([
        'Clock:system',
        'SecretVault:encrypted-file',
        'Store:sqlite',
      ]);
      await access(join(tmp.dir, 'store.sqlite'));
      await composition.close();
      await composition.close(); // memoized: no second close of the store
    } finally {
      await tmp.dispose();
    }
  });

  it('uses overrides instead of adapters and records them as override', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(1000);
      const store = new InMemoryStore({ clock });
      const closeSpy = vi.spyOn(store, 'close');
      const composition = await compose(parseConfig(''), {
        dataDir: tmp.dir,
        overrides: { clock, store, vault: new InMemorySecretVault() },
      });
      expect(composition.clock).toBe(clock);
      expect(composition.store).toBe(store);
      expect(composition.adapters.map((record) => record.id)).toEqual([
        'override',
        'override',
        'override',
      ]);
      await composition.close();
      await composition.close();
      expect(closeSpy).toHaveBeenCalledTimes(1);
      // An override replaces the adapter completely: no store file was created.
      await expect(access(join(tmp.dir, 'store.sqlite'))).rejects.toThrow();
    } finally {
      await tmp.dispose();
    }
  });

  it('names the full key when an adapter section has an unknown or bad value', async () => {
    const tmp = await makeTempDataDir();
    try {
      await expect(
        compose(parseConfig('store:\n  bogus: 1\n'), { dataDir: tmp.dir }),
      ).rejects.toThrow(/store\.bogus|store\..*bogus/);
      await expect(
        compose(parseConfig('store:\n  driver: nope\n'), { dataDir: tmp.dir }),
      ).rejects.toThrow(/store\.driver/);
    } finally {
      await tmp.dispose();
    }
  });
});

describe('composeClock', () => {
  it('returns the override, or the system clock', () => {
    const fake = new FakeClock(7);
    expect(composeClock({ clock: fake })).toBe(fake);
    expect(Math.abs(composeClock().now() - Date.now())).toBeLessThan(5000);
  });
});
