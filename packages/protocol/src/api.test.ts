// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { BackupManifestSchema, DaemonStatusSchema } from './api.js';

const manifest = {
  formatVersion: 1,
  createdAt: 1_700_000_000_000,
  trigger: 'manual',
  method: 'online_api',
  content: 'without_runs',
  integrity: 'ok',
  storeBytes: 4096,
  otheaterVersion: '0.0.0',
};

describe('DaemonStatusSchema', () => {
  const status = { pid: 1, startedAt: 0, version: '0.0.0', dataDir: '/d', state: 'running' };

  it('accepts every state and rejects an unknown one or an extra field', () => {
    for (const state of ['starting', 'recovering', 'running', 'stopping']) {
      expect(DaemonStatusSchema.safeParse({ ...status, state }).success, state).toBe(true);
    }
    expect(DaemonStatusSchema.safeParse({ ...status, state: 'idle' }).success).toBe(false);
    expect(DaemonStatusSchema.safeParse({ ...status, extra: 1 }).success).toBe(false);
  });
});

describe('BackupManifestSchema', () => {
  it('accepts a finished copy', () => {
    expect(BackupManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('rejects another format version, a failed integrity, a bad content and extra fields', () => {
    for (const bad of [
      { ...manifest, formatVersion: 2 },
      { ...manifest, integrity: 'failed' },
      { ...manifest, content: 'everything' },
      { ...manifest, createdAt: -1 },
      { ...manifest, extra: true },
    ]) {
      expect(BackupManifestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
