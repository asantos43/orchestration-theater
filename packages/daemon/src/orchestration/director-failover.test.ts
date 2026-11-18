// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { AdapterUnavailable, QuotaExhausted, Transient } from '@otheater/core';
import { INTERRUPTION_CAUSES } from '@otheater/protocol';
import { directorFailureOf, failoverApplies } from './director-failover.js';

/** The classification of a failed turn of the Director and the modes of `scenarios.director_failover` (P20). */

describe('directorFailureOf', () => {
  it('reads a limit error as quota_exhausted, with what the error says', () => {
    expect(directorFailureOf(new QuotaExhausted('out of quota'))).toEqual({
      cause: 'quota_exhausted',
      limitHit: { source: 'error:QuotaExhausted' },
    });
    const raw = Object.assign(new Error('limit'), {
      code: -32001,
      data: { kind: 'quota', resetsAt: '2026-11-18T12:00:00.000Z' },
    });
    expect(directorFailureOf(raw)?.cause).toBe('quota_exhausted');
  });

  it('reads a provider error as transient and a drop as client_crash', () => {
    expect(directorFailureOf(new Transient('503'))).toEqual({ cause: 'transient' });
    expect(directorFailureOf(new AdapterUnavailable('the process died'))).toEqual({
      cause: 'client_crash',
    });
  });

  it('leaves out what no new session would help', () => {
    expect(directorFailureOf(new Error('refused'))).toBeUndefined();
    expect(directorFailureOf('boom')).toBeUndefined();
    expect(directorFailureOf(undefined)).toBeUndefined();
  });
});

describe('failoverApplies', () => {
  it('next: every cause the classification gives', () => {
    for (const cause of INTERRUPTION_CAUSES) expect(failoverApplies('next', cause)).toBe(true);
  });

  it('quota_only: the limit and the spending cap only', () => {
    const answered = INTERRUPTION_CAUSES.filter((cause) => failoverApplies('quota_only', cause));
    expect(answered).toEqual(['quota_exhausted', 'spend_cap']);
  });

  it('off: none', () => {
    for (const cause of INTERRUPTION_CAUSES) expect(failoverApplies('off', cause)).toBe(false);
  });
});
