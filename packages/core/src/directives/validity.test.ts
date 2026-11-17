// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { directiveStateAt } from '../ports/directives.js';
import { FakeClock } from '../testing/fake-clock.js';
import { renderContinuationOrders } from './continuation.js';
import type { DirectiveRecord } from '../ports/directives.js';
import {
  directiveTransitions,
  expiringNoticeAt,
  formatInTimezone,
  isDirectiveActive,
  isKnownTimezone,
  nextBoundary,
  parseDirectiveInstant,
  validitiesOverlap,
  zonedTimeToEpoch,
} from './validity.js';

const HOUR = 3_600_000;

describe('directiveStateAt, driven by a FakeClock', () => {
  it('goes scheduled, active, expired as the clock moves, with no timer involved', async () => {
    const clock = new FakeClock(1_000_000);
    const window = {
      startsAt: clock.now() + HOUR,
      endsAt: clock.now() + 3 * HOUR,
      revokedAt: null,
    };
    expect(directiveStateAt(window, clock.now())).toBe('scheduled');
    await clock.advance(HOUR - 1);
    expect(directiveStateAt(window, clock.now())).toBe('scheduled');
    await clock.advance(1);
    expect(directiveStateAt(window, clock.now())).toBe('active');
    await clock.advance(2 * HOUR - 1);
    expect(directiveStateAt(window, clock.now())).toBe('active');
    await clock.advance(1);
    expect(directiveStateAt(window, clock.now())).toBe('expired');
  });

  it('keeps a revoked directive revoked whatever the clock says', async () => {
    const clock = new FakeClock(0);
    const window = { startsAt: 0, endsAt: HOUR, revokedAt: 10 };
    expect(directiveStateAt(window, clock.now())).toBe('revoked');
    await clock.advance(5 * HOUR);
    expect(directiveStateAt(window, clock.now())).toBe('revoked');
    expect(isDirectiveActive(window, clock.now())).toBe(false);
  });

  it('has no end when endsAt is null', async () => {
    const clock = new FakeClock(0);
    const window = { startsAt: 0, endsAt: null, revokedAt: null };
    await clock.advance(10_000 * HOUR);
    expect(directiveStateAt(window, clock.now())).toBe('active');
    expect(nextBoundary(window, clock.now())).toBeUndefined();
  });
});

describe('directiveTransitions', () => {
  const base = { id: 'O1', startsAt: 100, endsAt: 200, revokedAt: null };

  it('reports each boundary with its real time, not the time it was noticed', () => {
    expect(directiveTransitions(base, 0, 150)).toEqual([
      { directiveId: 'O1', from: 'scheduled', to: 'active', effectiveAt: 100 },
    ]);
    expect(directiveTransitions(base, 150, 999)).toEqual([
      { directiveId: 'O1', from: 'active', to: 'expired', effectiveAt: 200 },
    ]);
  });

  it('reports both when the daemon was stopped across the whole validity', () => {
    expect(directiveTransitions(base, 0, 999).map((t) => [t.to, t.effectiveAt])).toEqual([
      ['active', 100],
      ['expired', 200],
    ]);
  });

  it('does not report a boundary twice: the start is excluded, the end of the window is included', () => {
    expect(directiveTransitions(base, 100, 200).map((t) => t.to)).toEqual(['expired']);
    expect(directiveTransitions(base, 200, 300)).toEqual([]);
    expect(directiveTransitions(base, 150, 150)).toEqual([]);
  });

  it('reports nothing past a revocation', () => {
    expect(directiveTransitions({ ...base, revokedAt: 150 }, 0, 999).map((t) => t.to)).toEqual([
      'active',
    ]);
    expect(directiveTransitions({ ...base, revokedAt: 50 }, 0, 999)).toEqual([]);
  });

  it('reports no end for a directive without one', () => {
    expect(directiveTransitions({ ...base, endsAt: null }, 0, 999).map((t) => t.to)).toEqual([
      'active',
    ]);
  });
});

describe('notice and boundaries', () => {
  it('places the notice before the end, never before the start', () => {
    expect(expiringNoticeAt({ startsAt: 0, endsAt: 100 * HOUR }, 24 * HOUR)).toBe(76 * HOUR);
    expect(expiringNoticeAt({ startsAt: 90 * HOUR, endsAt: 100 * HOUR }, 24 * HOUR)).toBe(
      90 * HOUR,
    );
    expect(expiringNoticeAt({ startsAt: 0, endsAt: null }, 24 * HOUR)).toBeUndefined();
  });

  it('finds the next boundary after now', () => {
    const window = { startsAt: 100, endsAt: 200, revokedAt: null };
    expect(nextBoundary(window, 50)).toBe(100);
    expect(nextBoundary(window, 100)).toBe(200);
    expect(nextBoundary(window, 200)).toBeUndefined();
    expect(nextBoundary({ ...window, revokedAt: 1 }, 50)).toBeUndefined();
  });

  it('decides overlap with an exclusive end and an open end', () => {
    expect(validitiesOverlap({ startsAt: 0, endsAt: 10 }, { startsAt: 10, endsAt: 20 })).toBe(
      false,
    );
    expect(validitiesOverlap({ startsAt: 0, endsAt: 11 }, { startsAt: 10, endsAt: 20 })).toBe(true);
    expect(validitiesOverlap({ startsAt: 0, endsAt: null }, { startsAt: 500, endsAt: 600 })).toBe(
      true,
    );
    expect(validitiesOverlap({ startsAt: 30, endsAt: 40 }, { startsAt: 0, endsAt: 30 })).toBe(
      false,
    );
  });
});

describe('time zones', () => {
  it('formats an instant in the zone of the directive', () => {
    const at = Date.UTC(2026, 10, 20, 21, 0);
    expect(formatInTimezone(at, 'America/Sao_Paulo')).toBe('2026-11-20 18:00');
    expect(formatInTimezone(at, 'UTC')).toBe('2026-11-20 21:00');
  });

  it('falls back to UTC for a zone the runtime does not know', () => {
    expect(isKnownTimezone('Mars/Olympus')).toBe(false);
    expect(formatInTimezone(Date.UTC(2026, 0, 1, 12, 5), 'Mars/Olympus')).toBe('2026-01-01 12:05');
  });

  it('reads a wall time in a zone back to epoch ms', () => {
    const wall = { year: 2026, month: 11, day: 20, hour: 18, minute: 0 };
    expect(zonedTimeToEpoch(wall, 'America/Sao_Paulo')).toBe(Date.UTC(2026, 10, 20, 21, 0));
    expect(zonedTimeToEpoch(wall, 'UTC')).toBe(Date.UTC(2026, 10, 20, 18, 0));
    const roundTrip = zonedTimeToEpoch({ ...wall, month: 1, day: 5 }, 'America/Sao_Paulo');
    expect(formatInTimezone(roundTrip, 'America/Sao_Paulo')).toBe('2026-01-05 18:00');
  });
});

describe('parseDirectiveInstant', () => {
  it('reads a date, a date with time and a date with an offset', () => {
    const sp = 'America/Sao_Paulo';
    expect(parseDirectiveInstant('2026-11-20', sp)).toBe(Date.UTC(2026, 10, 20, 3, 0));
    expect(parseDirectiveInstant('2026-11-20 18:00', sp)).toBe(Date.UTC(2026, 10, 20, 21, 0));
    expect(parseDirectiveInstant('2026-11-20T18:00:30', sp)).toBe(
      Date.UTC(2026, 10, 20, 21, 0, 30),
    );
    expect(parseDirectiveInstant('2026-11-20T18:00', 'UTC')).toBe(Date.UTC(2026, 10, 20, 18, 0));
  });

  it('lets an explicit offset win over the time zone', () => {
    const sp = 'America/Sao_Paulo';
    expect(parseDirectiveInstant('2026-11-20T18:00:00Z', sp)).toBe(Date.UTC(2026, 10, 20, 18, 0));
    expect(parseDirectiveInstant('2026-11-20T18:00:00-03:00', 'UTC')).toBe(
      Date.UTC(2026, 10, 20, 21, 0),
    );
    expect(parseDirectiveInstant('2026-11-20T18:00+0530', sp)).toBe(Date.UTC(2026, 10, 20, 12, 30));
  });

  it('refuses text that is not a date, a date that does not exist and an unknown zone', () => {
    expect(parseDirectiveInstant('tomorrow', 'UTC')).toBeUndefined();
    expect(parseDirectiveInstant('2026-02-30', 'UTC')).toBeUndefined();
    expect(parseDirectiveInstant('2026-13-01', 'UTC')).toBeUndefined();
    expect(parseDirectiveInstant('2026-11-20 25:00', 'UTC')).toBeUndefined();
    expect(parseDirectiveInstant('2026-11-20 18:61', 'UTC')).toBeUndefined();
    expect(parseDirectiveInstant('2026-11-20', 'Mars/Olympus')).toBeUndefined();
  });
});

describe('renderContinuationOrders', () => {
  const order = (seq: number, extra: Partial<DirectiveRecord> = {}): DirectiveRecord => ({
    id: `O${String(seq)}`,
    seq,
    scope: 'global',
    scenarioId: null,
    kind: 'instruction',
    text: `Order ${String(seq)}`,
    ruleKey: null,
    ruleValue: null,
    suspendsId: null,
    roles: [],
    startsAt: 0,
    endsAt: null,
    timezone: 'America/Sao_Paulo',
    state: 'active',
    origin: 'chat',
    replacesId: null,
    createdAt: 0,
    updatedAt: 0,
    revokedAt: null,
    revokeReason: null,
    ...extra,
  });

  it('writes the orders in force for the role, with the end of the ones that end', () => {
    const text = renderContinuationOrders('actor', [
      order(1),
      order(2, { scope: 'local', scenarioId: 's1', endsAt: Date.UTC(2026, 10, 20, 21, 0) }),
      order(3, { roles: ['critic'] }),
      order(4, { kind: 'rule', ruleKey: 'git.push_after_commit', ruleValue: true }),
    ]);
    expect(text).toContain('## Orders in force now');
    expect(text).toContain('- O1: Order 1');
    expect(text).toContain('- O2 (until 2026-11-20 18:00 America/Sao_Paulo): Order 2');
    expect(text).not.toContain('O3');
    expect(text).not.toContain('O4');
  });

  it('is undefined when no order reaches the role', () => {
    expect(renderContinuationOrders('actor', [])).toBeUndefined();
    expect(renderContinuationOrders('actor', [order(1, { roles: ['critic'] })])).toBeUndefined();
  });
});
