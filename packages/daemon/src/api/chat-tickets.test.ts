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

  describe('the cap and the epoch (P8b of the phase 11 review)', () => {
    const capped = (maxTickets: number, epoch: { value: number } = { value: 0 }) => {
      const clock = new FakeClock();
      return {
        clock,
        epoch,
        tickets: new ChatTickets({
          ttlMs: 30_000,
          now: () => clock.now(),
          maxTickets,
          epoch: () => epoch.value,
        }),
      };
    };

    it('answers 503 unavailable past api.chat.max_tickets, and the room comes back as tickets are spent', () => {
      const { tickets } = capped(2);
      const first = tickets.issue('s1');
      tickets.issue('s1');
      expect(() => tickets.issue('s1')).toThrow(
        expect.objectContaining({ code: 'unavailable', details: { maxTickets: 2 } }) as Error,
      );
      expect(tickets.redeem(first.ticket, 's1')).toBe(true);
      expect(() => tickets.issue('s1')).not.toThrow();
    });

    it('drops the expired tickets before it counts, so a full map of old tickets is not a refusal', async () => {
      const { clock, tickets } = capped(3);
      for (let i = 0; i < 3; i += 1) tickets.issue('s1');
      await clock.advance(30_000);
      expect(() => tickets.issue('s1')).not.toThrow();
      expect(tickets.size).toBe(1);
    });

    it('purges from the oldest and stops at the first live ticket (the cost is what it removes)', async () => {
      const { clock, tickets } = capped(10_000);
      for (let i = 0; i < 5_000; i += 1) tickets.issue('s1');
      await clock.advance(10_000);
      const live = tickets.issue('s1').ticket;
      await clock.advance(20_000);
      // The first 5000 are expired and go; the one issued 20 s ago is still good.
      expect(tickets.redeem(live, 's1')).toBe(true);
      expect(tickets.size).toBe(0);
    });

    it('refuses to issue for a token that was rotated while the call ran', () => {
      const { tickets, epoch } = capped(10);
      expect(() => tickets.issue('s1', 0)).not.toThrow();
      epoch.value = 1;
      expect(() => tickets.issue('s1', 0)).toThrow(
        expect.objectContaining({ code: 'unauthorized' }) as Error,
      );
      expect(() => tickets.issue('s1', 1)).not.toThrow();
    });

    it('refuses to redeem a ticket asked for under an epoch that is gone', () => {
      const { tickets, epoch } = capped(10);
      const old = tickets.issue('s1').ticket;
      epoch.value = 1;
      expect(tickets.redeem(old, 's1')).toBe(false);
      const fresh = tickets.issue('s1').ticket;
      expect(tickets.redeem(fresh, 's1')).toBe(true);
    });
  });
});
