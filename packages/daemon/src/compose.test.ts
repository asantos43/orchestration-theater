// SPDX-License-Identifier: MPL-2.0
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  type Adapter,
  type Sandbox,
  type SandboxAvailability,
} from '@otheater/core';
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

/** A sandbox that answers `availability` and counts what the daemon asks of it. */
function fakeSandbox(availability: SandboxAvailability): Sandbox & {
  asked: number;
  closed: number;
} {
  return {
    id: 'fake-sandbox',
    implements: { port: 'Sandbox', range: '^0.1.0' },
    asked: 0,
    closed: 0,
    capabilities() {
      return availability.ok ? { fields: ['writeScope', 'network'] } : { fields: [] };
    },
    available() {
      this.asked += 1;
      return Promise.resolve(availability);
    },
    wrap: () => Promise.reject(new AdapterUnavailable('not used here')),
    close() {
      this.closed += 1;
      return Promise.resolve();
    },
  };
}

describe('compose: layer 3 (the sandbox)', () => {
  async function composed(config: string, sandbox: Sandbox | 'none') {
    const tmp = await makeTempDataDir();
    const clock = new FakeClock(1000);
    const composition = await compose(parseConfig(config), {
      dataDir: tmp.dir,
      overrides: {
        clock,
        store: new InMemoryStore({ clock }),
        vault: new InMemorySecretVault(),
        sandbox,
      },
    });
    return { composition, dispose: tmp.dispose };
  }

  it('wires an available sandbox: capabilities for guarantee(), and closes it with the daemon', async () => {
    const sandbox = fakeSandbox({ ok: true });
    const { composition, dispose } = await composed('', sandbox);
    try {
      expect(composition.sandbox?.capabilities).toEqual({ fields: ['writeScope', 'network'] });
      await composition.close();
      expect(sandbox.closed).toBe(1);
    } finally {
      await dispose();
    }
  });

  it('runs without layer 3 when the sandbox says it does not work here', async () => {
    const sandbox = fakeSandbox({ ok: false, reason: 'no bubblewrap' });
    const { composition, dispose } = await composed('', sandbox);
    try {
      expect(composition.sandbox).toBeUndefined();
    } finally {
      await composition.close();
      await dispose();
    }
  });

  it('does not even ask the sandbox when sandbox.mode is off or the override is none', async () => {
    const sandbox = fakeSandbox({ ok: true });
    const off = await composed('sandbox:\n  mode: off\n', sandbox);
    const none = await composed('', 'none');
    try {
      expect(off.composition.sandbox).toBeUndefined();
      expect(none.composition.sandbox).toBeUndefined();
      expect(sandbox.asked).toBe(0);
    } finally {
      await off.composition.close();
      await none.composition.close();
      await off.dispose();
      await none.dispose();
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
