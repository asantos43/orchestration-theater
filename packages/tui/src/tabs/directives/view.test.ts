// SPDX-License-Identifier: MPL-2.0
import type { ApiOrder } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import {
  dateText,
  deadlineOf,
  firstLine,
  groupOrders,
  sectionOf,
  spanText,
  timelineBar,
  visibleOrderIds,
} from './view.js';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const HOUR = 3_600_000;

function order(seq: number, extra: Partial<ApiOrder> = {}): ApiOrder {
  return {
    id: `O${String(seq)}`,
    seq,
    scope: 'global',
    scenarioId: null,
    kind: 'instruction',
    text: `order ${String(seq)}`,
    ruleKey: null,
    ruleValue: null,
    suspendsId: null,
    roles: [],
    startsAt: NOW - HOUR,
    endsAt: null,
    timezone: 'America/Sao_Paulo',
    state: 'active',
    origin: 'cli',
    replacesId: null,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    revokedAt: null,
    revokeReason: null,
    ...extra,
  } as ApiOrder;
}

const names: Record<string, string> = { S1: 'zeta', S2: 'alpha' };
const name = (id: string): string => names[id] ?? id;

describe('the sections of the tab Directives', () => {
  it('puts an order in force, scheduled or ended by the state the store keeps', () => {
    expect(sectionOf({ state: 'active' })).toBe('inForce');
    expect(sectionOf({ state: 'scheduled' })).toBe('scheduled');
    expect(sectionOf({ state: 'expired' })).toBe('ended');
    expect(sectionOf({ state: 'revoked' })).toBe('ended');
  });

  it('groups by scope: the global ones first, then the scenarios by name', () => {
    const sections = groupOrders(
      [
        order(1, { scope: 'local', scenarioId: 'S1' }),
        order(2),
        order(3, { scope: 'local', scenarioId: 'S2' }),
        order(4),
        order(5, { state: 'scheduled' }),
      ],
      name,
    );
    expect(
      sections.inForce.map((group) => [group.scenarioId, group.orders.map((o) => o.id)]),
    ).toEqual([
      [null, ['O2', 'O4']],
      ['S2', ['O3']],
      ['S1', ['O1']],
    ]);
    expect(sections.scheduled).toHaveLength(1);
    expect(sections.ended).toEqual([]);
  });

  it('lists the ended ones latest first', () => {
    const sections = groupOrders(
      [order(1, { state: 'expired' }), order(2, { state: 'revoked' })],
      name,
    );
    expect(sections.ended[0]?.orders.map((o) => o.id)).toEqual(['O2', 'O1']);
  });

  it('lists the ids on the screen, leaving out the folded sections', () => {
    const sections = groupOrders(
      [order(1), order(2, { state: 'scheduled' }), order(3, { state: 'expired' })],
      name,
    );
    expect(visibleOrderIds(sections, new Set())).toEqual(['O1', 'O2', 'O3']);
    expect(visibleOrderIds(sections, new Set(['directives.scheduled']))).toEqual(['O1', 'O3']);
  });
});

describe('time in the tab', () => {
  it('writes a span in the two largest units', () => {
    expect(spanText(0)).toBe('<1m');
    expect(spanText(59_000)).toBe('<1m');
    expect(spanText(42 * 60_000)).toBe('42m');
    expect(spanText(5 * HOUR + 10 * 60_000)).toBe('5h 10m');
    expect(spanText(5 * HOUR)).toBe('5h');
    expect(spanText(51 * HOUR)).toBe('2d 3h');
    expect(spanText(48 * HOUR)).toBe('2d');
    expect(spanText(-5)).toBe('<1m');
  });

  it('writes a date in the time zone of the order, and falls back to UTC for an unknown one', () => {
    expect(dateText(NOW, 'America/Sao_Paulo')).toBe('2026-11-21 09:00');
    expect(dateText(NOW, 'UTC')).toBe('2026-11-21 12:00');
    expect(dateText(NOW, 'Nowhere/Land')).toBe('2026-11-21 12:00');
  });

  it('draws the bar from the start to the end, and a line that goes on with no end', () => {
    const bounded = { startsAt: NOW - HOUR, endsAt: NOW + HOUR, state: 'active' as const };
    expect(timelineBar(bounded, NOW, 10)).toBe('█████░░░░░');
    expect(
      timelineBar(
        { ...bounded, state: 'scheduled', startsAt: NOW + HOUR, endsAt: NOW + 3 * HOUR },
        NOW,
        4,
      ),
    ).toBe('░░░░');
    expect(timelineBar({ ...bounded, state: 'expired' }, NOW, 4)).toBe('████');
    expect(timelineBar({ startsAt: NOW, endsAt: null, state: 'active' }, NOW, 6)).toBe('━━━━━→');
    expect(timelineBar({ startsAt: NOW + HOUR, endsAt: null, state: 'scheduled' }, NOW, 6)).toBe(
      '░░░░░→',
    );
  });

  it('says what the deadline of an order is', () => {
    expect(
      deadlineOf({ state: 'active', startsAt: 0, endsAt: NOW + 3 * HOUR, revokedAt: null }, NOW),
    ).toEqual({
      kind: 'endsIn',
      span: '3h',
    });
    expect(
      deadlineOf({ state: 'active', startsAt: 0, endsAt: null, revokedAt: null }, NOW),
    ).toEqual({
      kind: 'untilRevoked',
    });
    expect(
      deadlineOf({ state: 'scheduled', startsAt: NOW + HOUR, endsAt: null, revokedAt: null }, NOW),
    ).toEqual({
      kind: 'startsIn',
      span: '1h',
    });
    expect(
      deadlineOf({ state: 'expired', startsAt: 0, endsAt: NOW - 2 * HOUR, revokedAt: null }, NOW),
    ).toEqual({
      kind: 'endedAgo',
      span: '2h',
    });
    expect(
      deadlineOf(
        { state: 'revoked', startsAt: 0, endsAt: null, revokedAt: NOW - 30 * 60_000 },
        NOW,
      ),
    ).toEqual({
      kind: 'revokedAgo',
      span: '30m',
    });
  });

  it('takes the first line of a text', () => {
    expect(firstLine('  first  \nsecond')).toBe('first');
  });
});
