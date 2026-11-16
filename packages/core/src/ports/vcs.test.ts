// SPDX-License-Identifier: MPL-2.0
import { describe, expect, expectTypeOf, it } from 'vitest';
import { InvalidInput } from '../errors.js';
import type { Adapter } from './adapter.js';
import {
  attemptBranch,
  checkpointMessage,
  integrationBranch,
  isCheckpointMessage,
  playBranch,
  playBranchPrefix,
  VCS_PORT_VERSION,
  type Vcs,
} from './vcs.js';

describe('Vcs contract', () => {
  it('is versioned and is an Adapter', () => {
    expect(VCS_PORT_VERSION).toBe('0.1.0');
    expectTypeOf<Vcs>().toExtend<Adapter>();
    expectTypeOf<Vcs['commitAll']>().returns.resolves.toEqualTypeOf<string | undefined>();
    expectTypeOf<Vcs['headOf']>().returns.resolves.toEqualTypeOf<string>();
  });
});

describe('branch names', () => {
  it('follow architecture 5.5 (N59): everything under play/<id>/', () => {
    expect(playBranchPrefix('p1')).toBe('play/p1/');
    expect(playBranch('p1')).toBe('play/p1/base');
    expect(attemptBranch('p1', 'd-2', 3)).toBe('play/p1/attempts/d-2/3');
    expect(integrationBranch('p1')).toBe('play/p1/integration');
  });

  it('never make one branch name a path prefix of another (git refuses that)', () => {
    const names = [
      playBranch('p1'),
      integrationBranch('p1'),
      attemptBranch('p1', 'base', 1),
      attemptBranch('p1', 'integration', 1),
      attemptBranch('p1', 'attempts', 1),
      attemptBranch('p1', 'd1', 1),
      attemptBranch('p1', 'd1', 2),
      playBranch('p1-2'),
    ];
    for (const a of names) {
      for (const b of names) {
        if (a !== b) expect(b.startsWith(`${a}/`), `${a} / ${b}`).toBe(false);
      }
      expect(a.startsWith('play/p1/') || a.startsWith('play/p1-2/')).toBe(true);
    }
  });

  it('refuse ids outside [a-z0-9-], with path tricks and over 64 characters', () => {
    const badIds = [
      '',
      '..',
      'a..b',
      'a/b',
      'A',
      'a_b',
      'a b',
      'a.',
      '-a',
      'a-',
      'a\0',
      'ação',
      'a~1',
      'a:b',
      'a'.repeat(65),
    ];
    for (const id of badIds) {
      expect(() => playBranch(id), JSON.stringify(id)).toThrow(InvalidInput);
      expect(() => integrationBranch(id), JSON.stringify(id)).toThrow(InvalidInput);
      expect(() => attemptBranch('p1', id, 1), JSON.stringify(id)).toThrow(InvalidInput);
      expect(() => attemptBranch(id, 'd1', 1), JSON.stringify(id)).toThrow(InvalidInput);
    }
    expect(playBranch('a'.repeat(64))).toBe(`play/${'a'.repeat(64)}/base`);
  });

  it('refuse a bad attempt number', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => attemptBranch('p1', 'd1', attempt), String(attempt)).toThrow(InvalidInput);
    }
  });
});

describe('checkpoint messages', () => {
  it('are marked wip(checkpoint) and recognized', () => {
    expect(checkpointMessage('edit batch 4')).toBe('wip(checkpoint): edit batch 4');
    expect(isCheckpointMessage('wip(checkpoint): x')).toBe(true);
    expect(isCheckpointMessage('feat: x')).toBe(false);
  });

  it('refuse empty, multi-line and long labels', () => {
    for (const label of ['', 'a\nb', 'a\rb', 'a\0', 'x'.repeat(201)]) {
      expect(() => checkpointMessage(label), JSON.stringify(label)).toThrow(InvalidInput);
    }
  });
});
