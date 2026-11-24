// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  AdapterUnavailable,
  Cancelled,
  Conflict,
  DiskFull,
  ERROR_CODES,
  InvalidInput,
  NotFound,
  OTHEATER_ERROR_BRAND,
  OTheaterError,
  PermissionDenied,
  QuotaExhausted,
  Transient,
  VaultLocked,
  hasErrorCode,
  isOTheaterError,
  type KnownOTheaterError,
} from './errors.js';

const samples: KnownOTheaterError[] = [
  new QuotaExhausted('q'),
  new AdapterUnavailable('a'),
  new PermissionDenied('p'),
  new Transient('t'),
  new NotFound('n'),
  new Conflict('c'),
  new VaultLocked('v'),
  new Cancelled('x'),
  new InvalidInput('i'),
  new DiskFull('d'),
];

describe('typed errors', () => {
  it('each class has a stable code, name and message', () => {
    expect(samples.map((e) => [e.name, e.code])).toEqual([
      ['QuotaExhausted', 'QUOTA_EXHAUSTED'],
      ['AdapterUnavailable', 'ADAPTER_UNAVAILABLE'],
      ['PermissionDenied', 'PERMISSION_DENIED'],
      ['Transient', 'TRANSIENT'],
      ['NotFound', 'NOT_FOUND'],
      ['Conflict', 'CONFLICT'],
      ['VaultLocked', 'VAULT_LOCKED'],
      ['Cancelled', 'CANCELLED'],
      ['InvalidInput', 'INVALID_INPUT'],
      ['DiskFull', 'DISK_FULL'],
    ]);
    expect(samples[0]?.message).toBe('q');
  });

  it('covers every code in ERROR_CODES, each exactly once', () => {
    expect(samples.map((e) => e.code).sort()).toEqual(Object.values(ERROR_CODES).sort());
  });

  it('are Errors with a stack, and instances of OTheaterError', () => {
    for (const error of samples) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(OTheaterError);
      expect(typeof error.stack).toBe('string');
    }
  });

  it('keep the cause, and have none when none is given', () => {
    const root = new Error('root');
    expect(new Transient('t', { cause: root }).cause).toBe(root);
    expect('cause' in new Transient('t')).toBe(false);
  });

  it('a switch on code narrows the union exhaustively', () => {
    const label = (e: KnownOTheaterError): string => {
      switch (e.code) {
        case 'QUOTA_EXHAUSTED':
        case 'TRANSIENT':
        case 'DISK_FULL':
          return 'retry-later';
        case 'ADAPTER_UNAVAILABLE':
        case 'VAULT_LOCKED':
          return 'unavailable';
        case 'PERMISSION_DENIED':
        case 'NOT_FOUND':
        case 'CONFLICT':
        case 'CANCELLED':
        case 'INVALID_INPUT':
          return 'final';
        default:
          return e satisfies never;
      }
    };
    expect(samples.map(label)).toHaveLength(samples.length);
    expect(label(new Transient('t'))).toBe('retry-later');
  });
});

describe('isOTheaterError / hasErrorCode', () => {
  it('recognise OTheater errors and reject everything else', () => {
    expect(isOTheaterError(new QuotaExhausted('q'))).toBe(true);
    for (const other of [
      new Error('plain'),
      new TypeError('plain'),
      { code: 'QUOTA_EXHAUSTED' },
      'QUOTA_EXHAUSTED',
      null,
      undefined,
      42,
    ]) {
      expect(isOTheaterError(other)).toBe(false);
    }
  });

  it('recognise an error by brand even when it comes from another copy of the module', () => {
    class Foreign extends Error {
      readonly code = 'QUOTA_EXHAUSTED';
      readonly [OTHEATER_ERROR_BRAND] = true;
    }
    expect(isOTheaterError(new Foreign('from another copy'))).toBe(true);
    expect(hasErrorCode(new Foreign('x'), 'QUOTA_EXHAUSTED')).toBe(true);
  });

  it('hasErrorCode decides by code, never by message', () => {
    const quota = new QuotaExhausted('this message says TRANSIENT');
    expect(hasErrorCode(quota, 'QUOTA_EXHAUSTED')).toBe(true);
    expect(hasErrorCode(quota, 'TRANSIENT')).toBe(false);
    expect(hasErrorCode(new Error('QUOTA_EXHAUSTED'), 'QUOTA_EXHAUSTED')).toBe(false);
  });

  it('allows adapter-defined subclasses with their own codes', () => {
    class RateLimited extends OTheaterError<'ADAPTER_RATE_LIMITED'> {
      constructor(message: string) {
        super('ADAPTER_RATE_LIMITED', message);
      }
    }
    const error = new RateLimited('slow down');
    expect(isOTheaterError(error)).toBe(true);
    expect(hasErrorCode(error, 'ADAPTER_RATE_LIMITED')).toBe(true);
    expect(error.name).toBe('RateLimited');
  });
});
