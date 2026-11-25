// SPDX-License-Identifier: MPL-2.0
import type { ClientAdapter } from '@otheater/core';
import { FakeClientAdapter, FakeProcessLauncher } from '@otheater/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ClientRedetector, type ClientRedetectorOptions } from './client-redetect.js';
import type { ClientSelection } from './clients.js';
import type { ClientId } from './config.js';

function adapterOf(id: string): ClientAdapter {
  return new FakeClientAdapter({
    id,
    launcher: new FakeProcessLauncher(),
    baseEnv: {},
    adapterVersion: '1.0.0',
    command: { cmd: id, args: [] },
    processModel: 'process-per-session',
  });
}

function selection(id: ClientId, reason: ClientSelection['reason']): ClientSelection {
  return { id, enabled: reason !== 'not_found' && reason !== 'disabled', reason, executable: id };
}

/** A pool in memory and a build that answers what the test says is installed now. */
function rig(start: readonly string[] = []) {
  const pool = new Map<string, ClientAdapter>(start.map((id) => [id, adapterOf(id)]));
  const installed = new Set<ClientId>();
  const records: { type: string; payload: unknown }[] = [];
  const skips: ReadonlySet<ClientId>[] = [];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const wire = vi.fn((adapter: ClientAdapter) => Promise.resolve(adapter));
  let builds = 0;
  const build: ClientRedetectorOptions['build'] = async (skip, report) => {
    builds += 1;
    skips.push(skip);
    await Promise.resolve();
    const ids = (['claude-code', 'codex', 'opencode'] as const).filter((id) => !skip.has(id));
    report(ids.map((id) => selection(id, installed.has(id) ? 'found_in_path' : 'not_found')));
    return ids.filter((id) => installed.has(id)).map(adapterOf);
  };
  const redetector = new ClientRedetector({
    pool: {
      has: (client) => pool.has(client),
      addClient: (adapter) => {
        pool.set(adapter.id, adapter);
      },
    },
    build,
    wire,
    logger,
    situations: {
      record: (type, payload) => {
        records.push({ type, payload });
      },
    },
  });
  return { pool, installed, records, skips, logger, wire, redetector, builds: () => builds };
}

describe('ClientRedetector (P18, N321)', () => {
  it('adds a client installed after the start, wires it and tells it', async () => {
    const r = rig(['claude-code']);
    expect(await r.redetector.redetect()).toEqual({ added: [] });
    expect(r.redetector.reasonOf('codex')).toBe('not_found');

    r.installed.add('opencode');
    r.installed.add('codex');
    expect(await r.redetector.redetect()).toEqual({ added: ['codex', 'opencode'] });
    expect([...r.pool.keys()].sort()).toEqual(['claude-code', 'codex', 'opencode']);
    expect(r.wire).toHaveBeenCalledTimes(2);
    expect(r.redetector.reasonOf('codex')).toBe('found_in_path');
    expect(r.records).toEqual([
      {
        type: 'daemon.notice',
        payload: { kind: 'client_added', subject: 'codex', detail: 'found_in_path' },
      },
      {
        type: 'daemon.notice',
        payload: { kind: 'client_added', subject: 'opencode', detail: 'found_in_path' },
      },
    ]);
    // The clients the pool has are not built again.
    expect([...(r.skips.at(-1) ?? [])]).toEqual(['claude-code']);
  });

  it('does not build when the pool has every client', async () => {
    const r = rig(['claude-code', 'codex', 'opencode']);
    expect(await r.redetector.redetect()).toEqual({ added: [] });
    expect(r.builds()).toBe(0);
  });

  it('shares one search between calls that come together', async () => {
    const r = rig();
    r.installed.add('codex');
    const [a, b] = await Promise.all([r.redetector.redetect(), r.redetector.redetect()]);
    expect(a).toEqual({ added: ['codex'] });
    expect(b).toBe(a);
    expect(r.builds()).toBe(1);
    // A later call searches again.
    await r.redetector.redetect();
    expect(r.builds()).toBe(2);
  });

  it('drops what a build gives for a client the pool has, or one it does not know', async () => {
    const pool = new Map<string, ClientAdapter>([['codex', adapterOf('codex')]]);
    const redetector = new ClientRedetector({
      pool: { has: (c) => pool.has(c), addClient: (a) => void pool.set(a.id, a) },
      build: () => Promise.resolve([adapterOf('codex'), adapterOf('stranger')]),
      wire: (adapter) => Promise.resolve(adapter),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(await redetector.redetect()).toEqual({ added: [] });
    expect([...pool.keys()]).toEqual(['codex']);
  });

  it('keeps the reasons of the first build and lets a failed search reach the caller', async () => {
    const redetector = new ClientRedetector({
      pool: { has: () => false, addClient: () => undefined },
      build: () => Promise.reject(new Error('boom')),
      wire: (adapter) => Promise.resolve(adapter),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    redetector.note([selection('opencode', 'adapter_missing')]);
    expect(redetector.reasonOf('opencode')).toBe('adapter_missing');
    expect(redetector.reasonOf('codex')).toBeUndefined();
    await expect(redetector.redetect()).rejects.toThrow('boom');
    // The failed search is not kept: the next call tries again.
    await expect(redetector.redetect()).rejects.toThrow('boom');
  });
});
