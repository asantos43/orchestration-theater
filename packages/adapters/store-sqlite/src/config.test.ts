// SPDX-License-Identifier: MPL-2.0
import { STORE_PORT_VERSION } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { SQLITE_STORE_ADAPTER, SqliteStoreConfigSchema } from './config.js';

describe('SqliteStoreConfigSchema', () => {
  it('fills the defaults: better-sqlite3 (N49), synchronous full', () => {
    expect(SqliteStoreConfigSchema.parse({ path: 'x.db' })).toEqual({
      path: 'x.db',
      driver: 'better-sqlite3',
      synchronous: 'full',
      busyTimeoutMs: 5000,
    });
  });

  it('accepts both drivers and both synchronous modes', () => {
    for (const driver of ['better-sqlite3', 'node-sqlite']) {
      for (const synchronous of ['full', 'normal']) {
        expect(
          SqliteStoreConfigSchema.safeParse({ path: 'x.db', driver, synchronous }).success,
        ).toBe(true);
      }
    }
  });

  it.each([
    ['a missing path', {}],
    ['an empty path', { path: '' }],
    ['an in-memory path', { path: ':memory:' }],
    ['a URI path', { path: 'file:x.db' }],
    ['a NUL in the path', { path: 'x\0.db' }],
    ['an unknown driver', { path: 'x.db', driver: 'sql.js' }],
    ['synchronous off', { path: 'x.db', synchronous: 'off' }],
    ['a negative busy timeout', { path: 'x.db', busyTimeoutMs: -1 }],
    ['an unknown key', { path: 'x.db', walMode: false }],
  ])('rejects %s', (_name, input) => {
    expect(SqliteStoreConfigSchema.safeParse(input).success).toBe(false);
  });
});

describe('SQLITE_STORE_ADAPTER', () => {
  it('identifies as the sqlite Store adapter of the current port version', () => {
    expect(SQLITE_STORE_ADAPTER).toEqual({
      id: 'sqlite',
      implements: { port: 'Store', range: `^${STORE_PORT_VERSION}` },
    });
  });
});
