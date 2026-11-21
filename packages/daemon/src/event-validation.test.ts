// SPDX-License-Identifier: MPL-2.0
import {
  hasStoreMaintenance,
  InvalidInput,
  type Store,
  type StoreMaintenance,
} from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { validateEvents, validateEventsOf } from './event-validation.js';
import { buildDaemonRegistries } from './registries.js';
import { captureLogger } from './test-helpers.js';

const registry = buildDaemonRegistries().events;
const GOOD = {
  type: 'daemon.stopped',
  schemaVersion: 1,
  payload: { reason: 'signal', uptimeMs: 5 },
};
const BAD_PAYLOAD = { ...GOOD, payload: { reason: 'nope', uptimeMs: 5 } };
const UNKNOWN = { type: 'test.tick', schemaVersion: 1, payload: { n: 1 } };

function setup(unknownType: 'reject' | 'warn') {
  const store = new InMemoryStore({ clock: new FakeClock(Date.UTC(2026, 10, 17, 12)) });
  const { logger, lines } = captureLogger();
  const validated = validateEventsOf(store, { registry, unknownType, logger });
  return { store, validated, lines };
}

describe('events.unknown_type = reject', () => {
  it('stores a valid event of a registered type', async () => {
    const { store, validated } = setup('reject');
    const stored = await validated.events.append(GOOD);
    expect(stored.id).toBe(1);
    await expect(store.events.lastId()).resolves.toBe(1);
  });

  it('refuses an unknown type and stores nothing', async () => {
    const { store, validated, lines } = setup('reject');
    await expect(validated.events.append(UNKNOWN)).rejects.toThrow(InvalidInput);
    await expect(validated.events.append(UNKNOWN)).rejects.toThrow(/test\.tick/);
    await expect(store.events.lastId()).resolves.toBe(0);
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(0);
  });

  it('refuses an invalid payload and an unsupported schemaVersion', async () => {
    const { store, validated } = setup('reject');
    await expect(validated.events.append(BAD_PAYLOAD)).rejects.toThrow(InvalidInput);
    await expect(validated.events.append({ ...GOOD, schemaVersion: 2 })).rejects.toThrow(
      InvalidInput,
    );
    await expect(store.events.lastId()).resolves.toBe(0);
  });

  it('refuses inside a transaction too, and rolls the whole transaction back', async () => {
    const { store, validated } = setup('reject');
    await expect(
      validated.transaction(async (tx) => {
        await tx.events.append(GOOD);
        await tx.events.append(UNKNOWN);
      }),
    ).rejects.toThrow(InvalidInput);
    await expect(store.events.lastId()).resolves.toBe(0);
  });

  it('commits a transaction whose events are valid', async () => {
    const { store, validated } = setup('reject');
    await validated.transaction(async (tx) => {
      await tx.events.append(GOOD);
    });
    await expect(store.events.lastId()).resolves.toBe(1);
  });

  it('leaves an invalid envelope to the port, which rejects it too', async () => {
    const { validated } = setup('reject');
    await expect(
      validated.events.append({ type: '', schemaVersion: 0, payload: {} }),
    ).rejects.toThrow(InvalidInput);
  });
});

describe('events.unknown_type = warn', () => {
  it('stores an unknown type and logs a warning naming it', async () => {
    const { store, validated, lines } = setup('warn');
    const stored = await validated.events.append(UNKNOWN);
    expect(stored.type).toBe('test.tick');
    await expect(store.events.lastId()).resolves.toBe(1);
    const warns = lines.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain('test.tick');
    expect(warns[0]?.fields).toMatchObject({ type: 'test.tick', reason: 'unknown_type' });
  });

  it('stores an invalid payload and logs the reason', async () => {
    const { store, validated, lines } = setup('warn');
    await validated.events.append(BAD_PAYLOAD);
    await expect(store.events.lastId()).resolves.toBe(1);
    expect(lines.find((l) => l.level === 'warn')?.fields).toMatchObject({
      type: 'daemon.stopped',
      reason: 'invalid_payload',
    });
  });

  it('logs nothing for a valid event', async () => {
    const { validated, lines } = setup('warn');
    await validated.events.append(GOOD);
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(0);
  });

  it('stores an unknown type appended inside a transaction', async () => {
    const { store, validated, lines } = setup('warn');
    await validated.transaction(async (tx) => {
      await tx.events.append(UNKNOWN);
    });
    await expect(store.events.lastId()).resolves.toBe(1);
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1);
  });
});

describe('the validated log and store', () => {
  it('read through to the real log', async () => {
    const { validated } = setup('reject');
    await validated.events.append(GOOD);
    const read = await validated.events.readFrom(0, 10);
    expect(read.map((e) => e.type)).toEqual(['daemon.stopped']);
    await expect(validated.events.lastId()).resolves.toBe(1);
  });

  it('keep the optional maintenance capability of a store that has it', async () => {
    const calls: string[] = [];
    const inner = new InMemoryStore({ clock: new FakeClock(0) });
    const maintained = Object.assign(inner, {
      quickCheck: () => {
        calls.push('quickCheck');
        return Promise.resolve([]);
      },
      backup: () => {
        calls.push('backup');
        return Promise.resolve({
          path: 'dest',
          bytes: 0,
          method: 'test',
          durationMs: 0,
          restarts: 0,
        });
      },
    }) as Store & StoreMaintenance;
    const { logger } = captureLogger();
    const validated = validateEventsOf(maintained, { registry, unknownType: 'reject', logger });
    expect(hasStoreMaintenance(validated)).toBe(true);
    if (hasStoreMaintenance(validated)) {
      await expect(validated.quickCheck()).resolves.toEqual([]);
      await validated.backup('dest');
    }
    expect(calls).toEqual(['quickCheck', 'backup']);
  });

  it('do not report maintenance for a store without it', () => {
    const { validated } = setup('reject');
    expect(hasStoreMaintenance(validated)).toBe(false);
  });

  it('validateEvents decorates a bare log too', async () => {
    const store = new InMemoryStore({ clock: new FakeClock(0) });
    const { logger } = captureLogger();
    const log = validateEvents(store.events, { registry, unknownType: 'reject', logger });
    await expect(log.append(UNKNOWN)).rejects.toThrow(InvalidInput);
  });
});

describe('the config key events.unknown_type', () => {
  it('defaults to reject', () => {
    expect(parseConfig('backup:\n  when: manual\n').events.unknown_type).toBe('reject');
  });

  it('accepts warn and reject', () => {
    expect(parseConfig('events:\n  unknown_type: warn\n').events.unknown_type).toBe('warn');
    expect(parseConfig('events:\n  unknown_type: reject\n').events.unknown_type).toBe('reject');
  });

  it('rejects any other value and any unknown key of the group', () => {
    expect(() => parseConfig('events:\n  unknown_type: ignore\n')).toThrow();
    expect(() => parseConfig('events:\n  other: 1\n')).toThrow();
  });
});

describe('the config keys events.terminal_output and events.terminal_output_max', () => {
  it('default to truncated and 64KB', () => {
    const events = parseConfig('backup:\n  when: manual\n').events;
    expect(events.terminal_output).toBe('truncated');
    expect(events.terminal_output_max).toBe(64 * 1024);
  });

  it('accept the three modes and a size', () => {
    for (const mode of ['on', 'off', 'truncated'] as const) {
      expect(parseConfig(`events:\n  terminal_output: ${mode}\n`).events.terminal_output).toBe(
        mode,
      );
    }
    expect(parseConfig('events:\n  terminal_output_max: 8KB\n').events.terminal_output_max).toBe(
      8 * 1024,
    );
  });

  it('reject another mode, a size that is not one and a size of zero', () => {
    expect(() => parseConfig('events:\n  terminal_output: some\n')).toThrow();
    expect(() => parseConfig('events:\n  terminal_output_max: lots\n')).toThrow();
    expect(() => parseConfig('events:\n  terminal_output_max: 0\n')).toThrow();
  });
});

describe('the config key events.wait_threshold (P15, N222 (a))', () => {
  it('defaults to one second', () => {
    expect(parseConfig('backup:\n  when: manual\n').events.wait_threshold).toBe(1_000);
  });

  it('takes a duration, always (every wait that began) and off (none)', () => {
    const threshold = (value: string) =>
      parseConfig(`events:\n  wait_threshold: ${value}\n`).events.wait_threshold;
    expect(threshold('250ms')).toBe(250);
    expect(threshold('5s')).toBe(5_000);
    expect(threshold('always')).toBe(0);
    expect(threshold('off')).toBeNull();
  });

  it('rejects a value that is neither', () => {
    expect(() => parseConfig('events:\n  wait_threshold: soon\n')).toThrow();
    expect(() => parseConfig('events:\n  wait_threshold: 0\n')).toThrow();
    expect(() => parseConfig('events:\n  wait_threshold: -1s\n')).toThrow();
  });
});
