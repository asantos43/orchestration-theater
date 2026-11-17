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
});
