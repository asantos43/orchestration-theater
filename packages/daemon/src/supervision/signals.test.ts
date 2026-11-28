// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, Script } from '@otheater/core';
import { DEFAULT_SUPERVISION, type SupervisionSettings } from './config.js';
import {
  changedContracts,
  isExpectedFile,
  SignalDetector,
  worktreeRelative,
  type WatchedAttempt,
} from './signals.js';

const WORKTREE = '/work/p1/a';

function watched(patch: Partial<WatchedAttempt> = {}): WatchedAttempt {
  return {
    attemptId: 'p1/a/1',
    playId: 'p1',
    demandId: 'a',
    worktree: WORKTREE,
    startedAt: 1_000,
    expectedFiles: ['a.txt', 'src/'],
    contracts: ['c1'],
    timeoutMs: 10_000,
    ...patch,
  };
}

function settings(patch: Partial<SupervisionSettings['triggers']> = {}): SupervisionSettings {
  return { ...DEFAULT_SUPERVISION, triggers: { ...DEFAULT_SUPERVISION.triggers, ...patch } };
}

let counter = 0;
function event(
  type: string,
  payload: Record<string, unknown>,
  attemptId: string | undefined = 'p1/a/1',
): EventEnvelope {
  counter += 1;
  return {
    id: counter,
    timestamp: counter,
    type,
    schemaVersion: 1,
    payload,
    playId: 'p1',
    attemptId,
  } as EventEnvelope;
}

function asked(...paths: string[]): EventEnvelope {
  return event('permission.asked', { kind: 'edit', paths });
}

function script(
  contracts: readonly { id: string; title?: string; description?: string }[],
): Script {
  return {
    contracts: contracts.map((contract) => ({
      id: contract.id,
      title: contract.title ?? contract.id,
      description: contract.description ?? contract.id,
      kind: 'interface',
    })),
  } as unknown as Script;
}

describe('worktreeRelative', () => {
  it('makes a path inside the worktree relative, with forward slashes', () => {
    expect(worktreeRelative('/work/p1/a/src/x.ts', WORKTREE)).toBe('src/x.ts');
    expect(worktreeRelative('/work/p1/a/src/x.ts', `${WORKTREE}/`)).toBe('src/x.ts');
    expect(worktreeRelative('C:\\work\\p1\\a\\x.ts', 'C:\\work\\p1\\a')).toBe('x.ts');
    expect(worktreeRelative('./src/x.ts', WORKTREE)).toBe('src/x.ts');
  });

  it('drops what is outside the worktree, the repository data and installed packages', () => {
    expect(worktreeRelative('/etc/passwd', WORKTREE)).toBeUndefined();
    expect(worktreeRelative('/work/p1/ab/x.ts', WORKTREE)).toBeUndefined();
    expect(worktreeRelative('../x.ts', WORKTREE)).toBeUndefined();
    expect(worktreeRelative('/work/p1/a/.git/config', WORKTREE)).toBeUndefined();
    expect(worktreeRelative('node_modules/x/index.js', WORKTREE)).toBeUndefined();
    expect(worktreeRelative(WORKTREE, WORKTREE)).toBeUndefined();
  });
});

describe('isExpectedFile', () => {
  it('takes the same file, a directory entry and a glob entry', () => {
    expect(isExpectedFile('a.txt', ['a.txt'])).toBe(true);
    expect(isExpectedFile('src/deep/x.ts', ['src/'])).toBe(true);
    expect(isExpectedFile('src/deep/x.ts', ['src'])).toBe(true);
    expect(isExpectedFile('src/x.ts', ['src/*.ts'])).toBe(true);
    expect(isExpectedFile('src/deep/x.ts', ['src/*.ts'])).toBe(false);
    expect(isExpectedFile('src/deep/x.ts', ['src/**/*.ts'])).toBe(true);
    expect(isExpectedFile('src/x.ts', ['src/**/*.ts'])).toBe(true);
    expect(isExpectedFile('a.txt', ['./a.txt'])).toBe(true);
  });

  it('refuses a file that is not listed, and says nothing for a demand with no expected files', () => {
    expect(isExpectedFile('b.txt', ['a.txt', 'src/'])).toBe(false);
    expect(isExpectedFile('a.txt.bak', ['a.txt'])).toBe(false);
    expect(isExpectedFile('b.txt', [])).toBe(true);
  });
});

describe('changedContracts', () => {
  it('lists the contracts that are new, gone or changed, sorted', () => {
    const before = script([{ id: 'b' }, { id: 'a' }, { id: 'c' }]);
    const after = script([{ id: 'a', description: 'other' }, { id: 'b' }, { id: 'd' }]);
    expect(changedContracts(before, after)).toEqual(['a', 'c', 'd']);
  });

  it('says nothing without a previous script or without a change', () => {
    expect(changedContracts(undefined, script([{ id: 'a' }]))).toEqual([]);
    expect(changedContracts(script([{ id: 'a' }]), script([{ id: 'a' }]))).toEqual([]);
  });
});

describe('SignalDetector: outside_demand', () => {
  it('fires for a permission request that edits a file outside the demand, once per file', () => {
    const detector = new SignalDetector(() => settings());
    detector.add(watched());
    expect(detector.inspect(asked(`${WORKTREE}/a.txt`, `${WORKTREE}/src/x.ts`))).toEqual([]);
    const fired = detector.inspect(asked(`${WORKTREE}/other.txt`, '/etc/hosts'));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      signal: 'outside_demand',
      playId: 'p1',
      demandId: 'a',
      attemptIds: ['p1/a/1'],
    });
    expect(fired[0]?.detail).toContain('other.txt');
    expect(fired[0]?.detail).not.toContain('/etc/hosts');
    expect(detector.inspect(asked(`${WORKTREE}/other.txt`))).toEqual([]);
    expect(detector.inspect(asked(`${WORKTREE}/third.txt`))).toHaveLength(1);
  });

  it('reads the locations of the tool calls of the client, and ignores reads', () => {
    const detector = new SignalDetector(() => settings());
    detector.add(watched());
    const call = event('session.update', {
      update: {
        kind: 'tool_call',
        toolKind: 'edit',
        locations: [{ path: `${WORKTREE}/x.txt` }, { nope: 1 }],
      },
    });
    expect(detector.inspect(call)).toHaveLength(1);
    const read = event('session.update', {
      update: { kind: 'tool_call', toolKind: 'read', locations: [{ path: `${WORKTREE}/y.txt` }] },
    });
    expect(detector.inspect(read)).toEqual([]);
    expect(
      detector.inspect(event('permission.asked', { kind: 'execute', paths: ['z.txt'] })),
    ).toEqual([]);
  });

  it('lists at most five paths and says how many more', () => {
    const detector = new SignalDetector(() => settings());
    detector.add(watched());
    const paths = Array.from({ length: 7 }, (_, i) => `${WORKTREE}/f${String(i)}.txt`);
    const [signal] = detector.inspect(asked(...paths));
    expect(signal?.detail).toContain('and 2 more');
  });

  it('is off with the trigger off, and ignores events of attempts it does not follow', () => {
    const off = new SignalDetector(() => settings({ outside_demand: 'off' }));
    off.add(watched());
    expect(off.inspect(asked(`${WORKTREE}/other.txt`))).toEqual([]);
    const on = new SignalDetector(() => settings());
    on.add(watched());
    expect(
      on.inspect(event('permission.asked', { kind: 'edit', paths: ['x'] }, 'p1/zz/1')),
    ).toEqual([]);
    const bare = {
      ...event('permission.asked', { kind: 'edit', paths: ['x'] }),
      attemptId: undefined,
    };
    expect(on.inspect(bare)).toEqual([]);
  });

  it('does not follow an attempt after remove', () => {
    const detector = new SignalDetector(() => settings());
    detector.add(watched());
    expect(detector.has('p1/a/1')).toBe(true);
    detector.remove('p1/a/1');
    expect(detector.has('p1/a/1')).toBe(false);
    expect(detector.inspect(asked(`${WORKTREE}/other.txt`))).toEqual([]);
  });
});

describe('SignalDetector: test_loop', () => {
  function run(detector: SignalDetector, callId: string, outcome: string, summary = 'unit') {
    detector.inspect(event('tool.called', { tool: 'run_tests', callId, summary }));
    return detector.inspect(event('tool.finished', { tool: 'run_tests', callId, outcome }));
  }

  it('fires at the third failure in a row of the same call', () => {
    const detector = new SignalDetector(() => settings());
    detector.add(watched());
    expect(run(detector, '1', 'failed')).toEqual([]);
    expect(run(detector, '2', 'failed')).toEqual([]);
    const fired = run(detector, '3', 'failed');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ signal: 'test_loop' });
    expect(fired[0]?.detail).toContain('3 times');
    // once only
    expect(run(detector, '4', 'failed')).toEqual([]);
  });

  it('breaks the streak with a pass or another test', () => {
    const detector = new SignalDetector(() => settings());
    detector.add(watched());
    run(detector, '1', 'failed');
    run(detector, '2', 'failed');
    run(detector, '3', 'ok');
    expect(run(detector, '4', 'failed')).toEqual([]);
    run(detector, '5', 'failed', 'other');
    expect(run(detector, '6', 'failed', 'unit')).toEqual([]);
  });

  it('follows the configured number, and is off with off', () => {
    const two = new SignalDetector(() => settings({ test_loop: 2 }));
    two.add(watched());
    run(two, '1', 'failed');
    expect(run(two, '2', 'failed')).toHaveLength(1);
    const off = new SignalDetector(() => settings({ test_loop: 'off' }));
    off.add(watched());
    for (const id of ['1', '2', '3', '4']) expect(run(off, id, 'failed')).toEqual([]);
  });
});

describe('SignalDetector: budget_fraction and contract_changed', () => {
  it('fires once when the fraction of the time of the demand is spent', () => {
    const detector = new SignalDetector(() => settings());
    detector.add(watched({ startedAt: 0, timeoutMs: 1_000 }));
    expect(detector.elapsed(700)).toEqual([]);
    const fired = detector.elapsed(800);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ signal: 'budget_fraction', demandId: 'a' });
    expect(fired[0]?.detail).toContain('80%');
    expect(detector.elapsed(900)).toEqual([]);
  });

  it('is off with off, and skips a demand with no time', () => {
    const off = new SignalDetector(() => settings({ budget_fraction: 'off' }));
    off.add(watched({ startedAt: 0, timeoutMs: 1_000 }));
    expect(off.elapsed(5_000)).toEqual([]);
    const none = new SignalDetector(() => settings());
    none.add(watched({ startedAt: 0, timeoutMs: 0 }));
    expect(none.elapsed(5_000)).toEqual([]);
  });

  it('names the attempts of the play whose demand cites a changed contract', () => {
    const detector = new SignalDetector(() => settings());
    detector.add(watched());
    detector.add(watched({ attemptId: 'p1/b/1', demandId: 'b', contracts: ['c1', 'c2'] }));
    detector.add(watched({ attemptId: 'p1/c/1', demandId: 'c', contracts: ['c9'] }));
    detector.add(watched({ attemptId: 'p2/a/1', playId: 'p2', contracts: ['c1'] }));
    const one = detector.contractChanged('p1', ['c2']);
    expect(one).toMatchObject({
      signal: 'contract_changed',
      demandId: 'b',
      attemptIds: ['p1/b/1'],
    });
    const two = detector.contractChanged('p1', ['c1']);
    expect(two?.demandId).toBeNull();
    expect(two?.attemptIds).toEqual(['p1/a/1', 'p1/b/1']);
    expect(detector.contractChanged('p1', ['zz'])).toBeUndefined();
    expect(detector.contractChanged('p1', [])).toBeUndefined();
  });

  it('is off with the trigger off', () => {
    const detector = new SignalDetector(() => settings({ contract_changed: 'off' }));
    detector.add(watched());
    expect(detector.contractChanged('p1', ['c1'])).toBeUndefined();
  });
});
