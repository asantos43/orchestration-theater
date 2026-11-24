// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, Conflict, DiskFull, Transient } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { openRawDatabase } from './driver.js';
import { toStoreError } from './errors.js';
import { DRIVERS, makeTempDir } from './test-helpers.js';
import { join } from 'node:path';

describe('toStoreError', () => {
  it('leaves unrelated errors and non-errors untouched', () => {
    const plain = new Error('nope');
    expect(toStoreError(plain)).toBe(plain);
    expect(toStoreError('text')).toBe('text');
    const typed = new Conflict('already typed');
    expect(toStoreError(typed)).toBe(typed);
  });

  it('maps better-sqlite3 style codes', () => {
    const make = (code: string): Error => Object.assign(new Error('x'), { code });
    expect(toStoreError(make('SQLITE_BUSY'))).toBeInstanceOf(Transient);
    expect(toStoreError(make('SQLITE_BUSY_SNAPSHOT'))).toBeInstanceOf(Transient);
    expect(toStoreError(make('SQLITE_LOCKED'))).toBeInstanceOf(Transient);
    expect(toStoreError(make('SQLITE_CONSTRAINT_UNIQUE'))).toBeInstanceOf(Conflict);
    expect(toStoreError(make('SQLITE_CORRUPT'))).toBeInstanceOf(AdapterUnavailable);
    expect(toStoreError(make('SQLITE_READONLY'))).toBeInstanceOf(AdapterUnavailable);
    expect(toStoreError(make('SQLITE_CANTOPEN'))).toBeInstanceOf(AdapterUnavailable);
    expect(toStoreError(make('SQLITE_FULL'))).toBeInstanceOf(DiskFull);
    expect(toStoreError(make('SQLITE_ERROR'))).toMatchObject({ code: 'SQLITE_ERROR' });
  });

  it('maps node:sqlite style extended result codes', () => {
    const make = (errcode: number): Error => Object.assign(new Error('x'), { errcode });
    expect(toStoreError(make(5))).toBeInstanceOf(Transient);
    expect(toStoreError(make(517))).toBeInstanceOf(Transient); // SQLITE_BUSY_SNAPSHOT
    expect(toStoreError(make(2067))).toBeInstanceOf(Conflict); // SQLITE_CONSTRAINT_UNIQUE
    expect(toStoreError(make(26))).toBeInstanceOf(AdapterUnavailable); // SQLITE_NOTADB
    expect(toStoreError(make(13))).toBeInstanceOf(DiskFull); // SQLITE_FULL
    expect(toStoreError(make(13 | (2 << 8)))).toBeInstanceOf(DiskFull);
  });

  it('maps an ENOSPC of the file system to DiskFull, and keeps it as the cause', () => {
    const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    const mapped = toStoreError(enospc);
    expect(mapped).toBeInstanceOf(DiskFull);
    expect((mapped as DiskFull).code).toBe('DISK_FULL');
    expect((mapped as DiskFull).cause).toBe(enospc);
    expect(toStoreError(Object.assign(new Error('x'), { errno: -28 }))).toBeInstanceOf(DiskFull);
  });

  it('keeps the original error as the cause', () => {
    const original = Object.assign(new Error('x'), { code: 'SQLITE_BUSY' });
    expect((toStoreError(original) as Error).cause).toBe(original);
  });

  describe.each(DRIVERS)('with the real errors of %s', (driver) => {
    it('maps a write past max_page_count (SQLITE_FULL) to DiskFull', async () => {
      const { dir, dispose } = await makeTempDir();
      const db = await openRawDatabase(driver, join(dir, 'f.db'), {
        readonly: false,
        busyTimeoutMs: 100,
      });
      try {
        db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body BLOB)');
        db.exec('PRAGMA max_page_count = 8');
        let full: unknown;
        try {
          for (let i = 0; i < 64; i += 1) {
            db.prepare('INSERT INTO t (body) VALUES (?)').run([Buffer.alloc(4096, 1)]);
          }
        } catch (error) {
          full = error;
        }
        expect(full).toBeInstanceOf(Error);
        expect(toStoreError(full)).toBeInstanceOf(DiskFull);
      } finally {
        db.close();
        await dispose();
      }
    });

    it('maps a UNIQUE violation to Conflict and a syntax error to a plain error', async () => {
      const { dir, dispose } = await makeTempDir();
      const db = await openRawDatabase(driver, join(dir, 'e.db'), {
        readonly: false,
        busyTimeoutMs: 100,
      });
      try {
        db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
        db.prepare('INSERT INTO t (id) VALUES (?)').run([1]);
        let unique: unknown;
        try {
          db.prepare('INSERT INTO t (id) VALUES (?)').run([1]);
        } catch (error) {
          unique = error;
        }
        expect(toStoreError(unique)).toBeInstanceOf(Conflict);

        let syntax: unknown;
        try {
          db.prepare('SELEC nothing').all([]);
        } catch (error) {
          syntax = error;
        }
        expect(syntax).toBeInstanceOf(Error);
        expect(toStoreError(syntax)).toBe(syntax);
      } finally {
        db.close();
        await dispose();
      }
    });
  });
});
