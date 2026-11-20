// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { FakeClock } from '@otheater/core/testing';
import { ChatPresence } from './presence.js';

describe('who is watching (P15a)', () => {
  const make = (mode: 'poll' | 'always' | 'never') => {
    const clock = new FakeClock();
    return { clock, presence: new ChatPresence({ clock, mode, windowMs: 30_000 }) };
  };

  it('poll: nobody until a chat polls the scenario, then for the window only', async () => {
    const { clock, presence } = make('poll');
    expect(presence.attended('s1')).toBe(false);
    presence.touch('s1');
    expect(presence.attended('s1')).toBe(true);
    expect(presence.attended('s2')).toBe(false);
    await clock.advance(30_000);
    expect(presence.attended('s1')).toBe(true);
    await clock.advance(1);
    expect(presence.attended('s1')).toBe(false);
    presence.touch('s1');
    expect(presence.attended('s1')).toBe(true);
  });

  it('always and never ignore the polls', () => {
    const always = make('always').presence;
    expect(always.attended('s1')).toBe(true);
    const never = make('never').presence;
    never.touch('s1');
    expect(never.attended('s1')).toBe(false);
  });

  it('hold: a scenario with an open socket is watched with no poll, however long it takes', async () => {
    const { clock, presence } = make('poll');
    const release = presence.hold('s1');
    expect(presence.attended('s1')).toBe(true);
    await clock.advance(10 * 60_000);
    expect(presence.attended('s1')).toBe(true);
    expect(presence.attended('s2')).toBe(false);
    release();
    // The last socket to go leaves the scenario watched for the window, like a poll does.
    expect(presence.attended('s1')).toBe(true);
    await clock.advance(30_001);
    expect(presence.attended('s1')).toBe(false);
  });

  it('hold: counts the sockets, and a second release does nothing', () => {
    const { presence } = make('poll');
    const first = presence.hold('s1');
    const second = presence.hold('s1');
    first();
    first();
    expect(presence.attended('s1')).toBe(true);
    second();
    expect(presence.attended('s1')).toBe(true);
  });

  it('never still says nobody watches, with a socket open', () => {
    const { presence } = make('never');
    presence.hold('s1');
    expect(presence.attended('s1')).toBe(false);
  });
});
