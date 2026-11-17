// SPDX-License-Identifier: MPL-2.0
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionOutcome } from '@otheater/core';
import { PERMISSION_EVENT_MAX_PATHS } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { permissionEventsOf, resolveExistingPath } from './permission-log.js';

const scope = { sessionId: 'sess-1', playId: 'play-1', demandId: 'demand-1', attemptId: 'att-1' };

function outcome(overrides: Partial<PermissionOutcome> = {}): PermissionOutcome {
  return {
    request: {
      toolCallId: 'call-1',
      toolKind: 'edit',
      toolName: 'Write',
      title: 'Write secret-token-123 to file',
      locations: ['docs/a.md'],
      options: [],
    },
    answered: 'allow',
    rule: 'docs-edit',
    reason: 'rule',
    answer: { outcome: 'selected', optionId: 'allow' },
    ...overrides,
  } as PermissionOutcome;
}

describe('permissionEventsOf', () => {
  it('tells asked first and answered second, with the scope in both', () => {
    const [asked, answered] = permissionEventsOf(outcome(), scope);
    expect(asked.type).toBe('permission.asked');
    expect(answered.type).toBe('permission.answered');
    for (const event of [asked, answered]) {
      expect(event.payload).toMatchObject({
        sessionId: 'sess-1',
        toolCallId: 'call-1',
        tool: 'Write',
        kind: 'edit',
        paths: ['docs/a.md'],
        pathCount: 1,
        playId: 'play-1',
        demandId: 'demand-1',
        attemptId: 'att-1',
      });
    }
    expect(asked.payload).not.toHaveProperty('answer');
    expect(answered.payload).toMatchObject({ answer: 'allow', rule: 'docs-edit', reason: 'rule' });
  });

  it('never carries the title of the call or the command line', () => {
    const [asked, answered] = permissionEventsOf(
      outcome({
        request: {
          toolCallId: 'c',
          toolKind: 'execute',
          title: 'curl -H "Authorization: secret-token-123"',
          command: 'curl -H "Authorization: secret-token-123"',
          options: [],
        },
        reason: 'native_shell',
        answered: 'reject',
        rule: 'none',
      }),
      scope,
    );
    expect(JSON.stringify([asked, answered])).not.toContain('secret-token-123');
    expect(answered.payload).toMatchObject({ tool: 'execute', reason: 'native_shell' });
  });

  it('falls back to the kind, then to "unknown", for the tool name', () => {
    const base = { toolCallId: 'c', options: [] };
    const named = (request: object) =>
      permissionEventsOf(outcome({ request: { ...base, ...request } }), scope)[0].payload;
    expect(named({ toolKind: 'fetch' })).toMatchObject({ tool: 'fetch', kind: 'fetch' });
    expect(named({})).toMatchObject({ tool: 'unknown' });
    expect(named({})).not.toHaveProperty('kind');
    expect(named({ toolCallId: '' })).not.toHaveProperty('toolCallId');
  });

  it('lists at most the limit of paths and keeps the real count', () => {
    const locations = Array.from({ length: 25 }, (_, i) => `f${String(i)}.txt`);
    const [asked] = permissionEventsOf(
      outcome({ request: { toolCallId: 'c', toolKind: 'edit', locations, options: [] } }),
      scope,
    );
    const payload = asked.payload as { paths: string[]; pathCount: number };
    expect(payload.paths).toHaveLength(PERMISSION_EVENT_MAX_PATHS);
    expect(payload.pathCount).toBe(25);
  });

  it('keeps only the host of an address, in lower case, and drops what is not an address', () => {
    const host = (url: string) =>
      permissionEventsOf(
        outcome({ request: { toolCallId: 'c', toolKind: 'fetch', url, options: [] } }),
        scope,
      )[0].payload as { host?: string };
    expect(host('https://Example.COM/a/b?token=secret-token-123').host).toBe('example.com');
    expect(JSON.stringify(host('https://example.com/p?token=secret-token-123'))).not.toContain(
      'secret-token-123',
    );
    expect(host('not a url')).not.toHaveProperty('host');
  });

  it('carries the rule N99 overruled', () => {
    const [, answered] = permissionEventsOf(
      outcome({
        answered: 'reject',
        rule: 'none',
        reason: 'write_outside_worktree',
        overruledRule: 'any-edit',
      }),
      scope,
    );
    expect(answered.payload).toMatchObject({ overruledRule: 'any-edit', rule: 'none' });
  });
});

describe('resolveExistingPath', () => {
  const dirs: string[] = [];
  const temp = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'otheater-perm-')));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a link that points out of the folder, even for a file that does not exist yet', () => {
    const worktree = temp();
    const outside = temp();
    symlinkSync(outside, join(worktree, 'link'));
    expect(resolveExistingPath(join(worktree, 'link', 'new', 'file.txt'))).toBe(
      join(outside, 'new', 'file.txt'),
    );
  });

  it('leaves a path inside the folder where it is, existing or not', () => {
    const worktree = temp();
    mkdirSync(join(worktree, 'docs'));
    expect(resolveExistingPath(join(worktree, 'docs', 'a.md'))).toBe(
      join(worktree, 'docs', 'a.md'),
    );
    expect(resolveExistingPath(join(worktree, 'docs'))).toBe(join(worktree, 'docs'));
  });

  it('returns a path of which nothing exists as it is', () => {
    const ghost = join(temp(), 'a', 'b', 'c.txt');
    expect(resolveExistingPath(ghost)).toBe(ghost);
  });
});
