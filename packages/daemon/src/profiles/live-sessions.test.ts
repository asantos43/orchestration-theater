// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { liveProfileSessions } from './live-sessions.js';

function fakes(state: { attempts: number; leased: number; pool: number }) {
  const calls: string[] = [];
  const sessions = liveProfileSessions({
    pool: {
      sessionsOf: () => state.pool,
      endProcessesOf: (id) => {
        calls.push(`end:${id}`);
        return Promise.resolve(1);
      },
    },
    runner: {
      attemptsOf: () => state.attempts,
      leasedOn: () => state.leased,
      releaseProfile: (id, how) => {
        calls.push(`release:${id}:${how}`);
        return Promise.resolve(state.attempts);
      },
    },
  });
  return { sessions, calls };
}

describe('liveProfileSessions (P21)', () => {
  it('counts an attempt once, and a session the pool holds for nobody else on top', async () => {
    // Two attempts with a lease each, plus a Director lease.
    const { sessions } = fakes({ attempts: 2, leased: 2, pool: 3 });
    expect(await sessions.count('fake/one')).toBe(3);
  });

  it('counts an attempt between two sessions (no lease) as running', async () => {
    const { sessions } = fakes({ attempts: 1, leased: 0, pool: 0 });
    expect(await sessions.count('fake/one')).toBe(1);
  });

  it('is zero when nothing runs, and never negative', async () => {
    expect(await fakes({ attempts: 0, leased: 0, pool: 0 }).sessions.count('fake/one')).toBe(0);
    expect(await fakes({ attempts: 0, leased: 1, pool: 0 }).sessions.count('fake/one')).toBe(0);
  });

  it('handoff only releases the attempts; force ends the processes too', async () => {
    const soft = fakes({ attempts: 2, leased: 2, pool: 2 });
    expect(await soft.sessions.release('fake/one', 'handoff')).toBe(2);
    expect(soft.calls).toEqual(['release:fake/one:handoff']);

    const hard = fakes({ attempts: 1, leased: 1, pool: 1 });
    expect(await hard.sessions.release('fake/one', 'force')).toBe(1);
    expect(hard.calls).toEqual(['release:fake/one:force', 'end:fake/one']);
  });

  it('settle ends the processes the profile still has', async () => {
    const { sessions, calls } = fakes({ attempts: 0, leased: 0, pool: 0 });
    await sessions.settle?.('fake/one');
    expect(calls).toEqual(['end:fake/one']);
  });
});
