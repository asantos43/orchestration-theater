// SPDX-License-Identifier: MPL-2.0
import type { ApiPlay } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import {
  diffLines,
  diffOwners,
  entryLines,
  followedSubject,
  foldedSet,
  isFolded,
  latestDirectId,
  latestPlayId,
  trajectoryOf,
  visibleSections,
  wantedDiffs,
  type Say,
} from './model.js';
import { fakePlayEvents, trajectoryEvent } from './trajectory.test-support.js';

const say: Say = (key, values) =>
  values === undefined ? key : `${key}(${Object.values(values).join(',')})`;

const plays = (...items: [string, string, number][]): Record<string, ApiPlay> =>
  Object.fromEntries(
    items.map(([id, scenarioId, updatedAt]) => [id, { id, scenarioId, updatedAt } as ApiPlay]),
  );

describe('latestPlayId', () => {
  it('is the play of the scenario updated last, with the id breaking a tie', () => {
    const all = plays(['P1', 'S1', 5], ['P2', 'S1', 9], ['P3', 'S2', 99], ['P4', 'S1', 9]);
    expect(latestPlayId(all, 'S1')).toBe('P4');
    expect(latestPlayId(all, 'S2')).toBe('P3');
    expect(latestPlayId(all, 'S9')).toBeUndefined();
    expect(latestPlayId(all, undefined)).toBeUndefined();
  });
});

describe('the sections of the trajectory', () => {
  const trajectory = trajectoryOf('P1', fakePlayEvents());
  const none = new Set<string>();

  it('the fake play is one attempt with two turns, and the demand diff hangs from the attempt', () => {
    expect(trajectory.attempts).toHaveLength(1);
    expect(trajectory.attempts[0]?.turns).toHaveLength(2);
    expect([...diffOwners(trajectory)]).toEqual([[1, 'D1']]);
    expect(trajectoryOf('P1', [])).not.toBe(trajectory);
  });

  it('open: last starts with the last attempt, its last turn and its diff open', () => {
    expect(isFolded('trajectories.a1', 'last', trajectory, none)).toBe(false);
    expect(isFolded('trajectories.a1.t1', 'last', trajectory, none)).toBe(true);
    expect(isFolded('trajectories.a1.t2', 'last', trajectory, none)).toBe(false);
    expect(isFolded('trajectories.a1.diff', 'last', trajectory, none)).toBe(false);
    expect([...foldedSet(trajectory, 'last', none)]).toEqual([
      'trajectories.a1.t1',
      'trajectories.transitions',
    ]);
  });

  it('open: none folds all and open: all folds nothing; what the person toggled flips the start', () => {
    expect(foldedSet(trajectory, 'all', none).size).toBe(0);
    expect(foldedSet(trajectory, 'none', none).size).toBe(5);
    expect(
      isFolded('trajectories.a1.t1', 'last', trajectory, new Set(['trajectories.a1.t1'])),
    ).toBe(false);
    expect(
      isFolded('trajectories.a1.t2', 'last', trajectory, new Set(['trajectories.a1.t2'])),
    ).toBe(true);
  });

  it('the cursor walks what is on screen: a folded attempt hides its turns and its diff', () => {
    expect(visibleSections(trajectory, 'last', none)).toEqual([
      'trajectories.a1',
      'trajectories.a1.t1',
      'trajectories.a1.t2',
      'trajectories.a1.diff',
      'trajectories.transitions',
    ]);
    expect(visibleSections(trajectory, 'none', none)).toEqual([
      'trajectories.a1',
      'trajectories.transitions',
    ]);
    expect(visibleSections(undefined, 'last', none)).toEqual([]);
  });

  it('asks for the diff of a demand only when its section is on screen', () => {
    expect(wantedDiffs(trajectory, 'last', none)).toEqual(['D1']);
    expect(wantedDiffs(trajectory, 'none', none)).toEqual([]);
    expect(wantedDiffs(trajectory, 'last', new Set(['trajectories.a1.diff']))).toEqual([]);
    expect(wantedDiffs(trajectory, 'last', new Set(['trajectories.a1']))).toEqual([]);
  });

  it('the last attempt of a demand owns its diff', () => {
    const two = trajectoryOf('P1', [
      trajectoryEvent(1, 'session.opened', { demandId: 'D1' }, 'P1/a/1'),
      trajectoryEvent(2, 'session.opened', { demandId: 'D1' }, 'P1/a/2'),
      trajectoryEvent(3, 'session.opened', { demandId: 'D2' }, 'P1/a/3'),
    ]);
    expect([...diffOwners(two)]).toEqual([
      [2, 'D1'],
      [3, 'D2'],
    ]);
  });
});

describe('diffLines', () => {
  const diff = ['diff --git a b', '--- a', '+++ b', '@@ -1 +1 @@', '-old', '+new', ' same\n'].join(
    '\n',
  );

  it('classifies the lines and cuts at the limit, saying how many are left', () => {
    const { lines, hidden } = diffLines(diff, 10);
    expect(lines.map((line) => line.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'hunk',
      'remove',
      'add',
      'context',
    ]);
    expect(hidden).toBe(0);
    const cut = diffLines(diff, 3);
    expect(cut.lines).toHaveLength(3);
    expect(cut.hidden).toBe(4);
    expect(diffLines('', 5)).toEqual({ lines: [], hidden: 0 });
  });
});

describe('entryLines', () => {
  const entries = trajectoryOf('P1', fakePlayEvents()).attempts[0]?.turns ?? [];

  it('says a message, a tool call and a permission in one place each', () => {
    const first = entries[0]?.entries ?? [];
    const lines = first.flatMap((entry) => entryLines(entry, 80, say));
    expect(lines.map((line) => line.text)).toEqual([
      'trajectories.entry.message Writing the file',
      'trajectories.entry.toolCall Write notes.txt [edit] completed notes.txt',
      'trajectories.entry.permission run_command -> allow',
    ]);
    expect(lines[2]?.tone).toBe('ok');
  });

  it('wraps a long message and cuts it after the limit of lines', () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${String(i)}`).join(' ');
    const lines = entryLines({ kind: 'message', at: 0, text: long }, 20, say);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.at(-1)?.text.trim()).toMatch(/^trajectories\.more\(\d+\)$/);
  });
});

describe('followedSubject (P27)', () => {
  const direct = (...items: [string, string, number][]) =>
    Object.fromEntries(
      items.map(([sessionId, scenarioId, at]) => [
        sessionId,
        { sessionId, scenarioId, at, closed: true },
      ]),
    );
  const all = plays(['P1', 'S1', 50]);

  it('the latest direct session of the scenario, with the id breaking a tie', () => {
    const sessions = direct(['direct-a', 'S1', 5], ['direct-b', 'S1', 9], ['direct-c', 'S2', 99]);
    expect(latestDirectId(sessions, 'S1')).toBe('direct-b');
    expect(latestDirectId(sessions, 'S3')).toBeUndefined();
    expect(latestDirectId(sessions, undefined)).toBeUndefined();
    expect(latestDirectId(direct(['direct-a', 'S1', 9], ['direct-b', 'S1', 9]), 'S1')).toBe(
      'direct-b',
    );
  });

  it('play follows only plays; direct follows the session, or the play when there is none', () => {
    const sessions = direct(['direct-a', 'S1', 5]);
    expect(followedSubject(all, sessions, 'S1', 'play')).toEqual({ kind: 'play', id: 'P1' });
    expect(followedSubject(all, sessions, 'S1', 'direct')).toEqual({
      kind: 'direct',
      id: 'direct-a',
    });
    expect(followedSubject(all, {}, 'S1', 'direct')).toEqual({ kind: 'play', id: 'P1' });
    expect(followedSubject({}, sessions, 'S1', 'play')).toBeUndefined();
  });

  it('latest follows whichever moved last, the play on a tie', () => {
    expect(followedSubject(all, direct(['direct-a', 'S1', 51]), 'S1', 'latest')).toEqual({
      kind: 'direct',
      id: 'direct-a',
    });
    expect(followedSubject(all, direct(['direct-a', 'S1', 50]), 'S1', 'latest')).toEqual({
      kind: 'play',
      id: 'P1',
    });
    expect(followedSubject({}, direct(['direct-a', 'S1', 1]), 'S1', 'latest')).toEqual({
      kind: 'direct',
      id: 'direct-a',
    });
  });
});

describe('the entries of a direct session turn (P27)', () => {
  it('a prompt of the Producer and a command of the client have their own label', () => {
    const at = 1;
    expect(
      entryLines({ kind: 'prompt', at, text: 'fix it', command: false }, 80, say)[0]?.text,
    ).toBe('trajectories.entry.prompt fix it');
    expect(
      entryLines({ kind: 'prompt', at, text: '/compact', command: true }, 80, say)[0]?.text,
    ).toBe('trajectories.entry.command /compact');
  });
});
