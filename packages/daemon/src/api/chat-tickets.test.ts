// SPDX-License-Identifier: MPL-2.0
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { ChatTickets } from './chat-tickets.js';

describe('the tickets of the chat socket (P7)', () => {
  const make = (ttlMs = 30_000) => {
    const clock = new FakeClock();
    return { clock, tickets: new ChatTickets({ ttlMs, now: () => clock.now() }) };
  };

  it('issues a ticket that is long, random and good once', () => {
    const { tickets } = make();
    const a = tickets.issue('s1');
    const b = tickets.issue('s1');
    expect(a.expiresInMs).toBe(30_000);
    expect(a.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.ticket).not.toBe(b.ticket);
    expect(tickets.redeem(a.ticket, 's1')).toBe(true);
    expect(tickets.redeem(a.ticket, 's1')).toBe(false);
    expect(tickets.redeem(b.ticket, 's1')).toBe(true);
  });

  it('refuses a ticket after its time, and takes it up to the last millisecond before', async () => {
    const { clock, tickets } = make();
    const late = tickets.issue('s1').ticket;
    const fine = tickets.issue('s1').ticket;
    await clock.advance(29_999);
    expect(tickets.redeem(fine, 's1')).toBe(true);
    await clock.advance(1);
    expect(tickets.redeem(late, 's1')).toBe(false);
  });

  it('is for one scenario, and a try for another one spends it', () => {
    const { tickets } = make();
    const { ticket } = tickets.issue('s1');
    expect(tickets.redeem(ticket, 's2')).toBe(false);
    expect(tickets.redeem(ticket, 's1')).toBe(false);
  });

  it('refuses what it never issued', () => {
    const { tickets } = make();
    expect(tickets.redeem('', 's1')).toBe(false);
    expect(tickets.redeem('made-up', 's1')).toBe(false);
  });

  it('forgets every ticket when asked (the token was rotated)', () => {
    const { tickets } = make();
    const { ticket } = tickets.issue('s1');
    tickets.clear();
    expect(tickets.size).toBe(0);
    expect(tickets.redeem(ticket, 's1')).toBe(false);
  });

  it('drops the expired tickets nobody redeemed, so the map does not grow', async () => {
    const { clock, tickets } = make();
    for (let i = 0; i < 5; i += 1) tickets.issue('s1');
    expect(tickets.size).toBe(5);
    await clock.advance(30_000);
    tickets.issue('s1');
    expect(tickets.size).toBe(1);
  });
});
