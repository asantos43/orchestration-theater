// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiRequestError } from '@otheater/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FALLBACK_SCENARIO_TYPES,
  gitRootOf,
  initialRepo,
  newScenarioRequest,
  openFailure,
  resolveRepo,
  startType,
  stepType,
} from './new-project.js';

const made: string[] = [];
afterEach(async () => {
  for (const folder of made.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'otheater-p22-unit-')));
  made.push(folder);
  return folder;
}

describe('resolveRepo', () => {
  it('keeps an absolute path and starts a relative one at the folder of the TUI', () => {
    expect(resolveRepo('/work/app', '/else')).toBe(resolve('/work/app'));
    expect(resolveRepo('../app', '/work/tui')).toBe(resolve('/work/app'));
    expect(resolveRepo('  sub  ', '/work')).toBe(resolve('/work/sub'));
  });

  it('expands the home folder', () => {
    expect(resolveRepo('~', '/work', '/home/x')).toBe('/home/x');
    expect(resolveRepo('~/app', '/work', '/home/x')).toBe(resolve('/home/x/app'));
  });

  it('leaves empty text empty', () => {
    expect(resolveRepo('   ', '/work')).toBe('');
  });
});

describe('initialRepo (ui.newProject.repo)', () => {
  it('starts with the folder of the TUI, with its git root, or with nothing', async () => {
    const root = await temp();
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'deep', 'er'), { recursive: true });
    const inside = join(root, 'deep', 'er');
    expect(initialRepo('cwd', inside)).toBe(inside);
    expect(initialRepo('git_root', inside)).toBe(root);
    expect(initialRepo('empty', inside)).toBe('');
  });

  it('keeps the folder when it is in no repository', async () => {
    const plain = await temp();
    expect(gitRootOf(plain)).toBe(plain);
  });
});

describe('openFailure', () => {
  const t = (key: string, params?: Record<string, string>): string =>
    `${key}|${JSON.stringify(params ?? {})}`;

  it('says the repository is bad when the daemon refused it', () => {
    const error = new ApiRequestError({
      status: 400,
      body: { code: 'invalid_input', message: 'not a repo' },
    });
    expect(openFailure(error, '/x', t)).toBe('layout.newProject.badRepo|{"repo":"/x"}');
  });

  it('carries the message of any other failure', () => {
    expect(openFailure(new Error('boom'), '/x', t)).toBe(
      'layout.newProject.failed|{"message":"boom"}',
    );
    expect(openFailure('plain', '/x', t)).toBe('layout.newProject.failed|{"message":"plain"}');
  });

  it('does not blame a repository when the chat failed (N329)', () => {
    const error = new ApiRequestError({
      status: 400,
      body: { code: 'invalid_input', message: 'bad name' },
    });
    expect(openFailure(error, undefined, t)).toBe(
      `layout.newProject.failed|${JSON.stringify({ message: error.message })}`,
    );
  });
});

describe('the types of the prompt (N329)', () => {
  const all = FALLBACK_SCENARIO_TYPES;

  it('falls back to the three official types, with the task off', () => {
    expect(all).toEqual([
      { id: 'project', creatable: true },
      { id: 'task', creatable: false },
      { id: 'chat', creatable: true },
    ]);
  });

  it('starts on the type asked for, or on the first one that opens', () => {
    expect(startType(all, 'chat')).toBe('chat');
    expect(startType(all, 'project')).toBe('project');
    expect(startType(all, 'task')).toBe('project');
    expect(startType([{ id: 'chat', creatable: false }], 'chat')).toBeUndefined();
    // A type the TUI has no field for is never picked, even when the daemon opens it.
    expect(startType([{ id: 'other', creatable: true }, ...all], 'other')).toBe('project');
  });

  it('moves both ways around the row and skips the types that are off', () => {
    expect(stepType(all, 'project', 1)).toBe('chat');
    expect(stepType(all, 'chat', 1)).toBe('project');
    expect(stepType(all, 'project', -1)).toBe('chat');
    expect(stepType(all, 'chat', -1)).toBe('project');
    const task = [
      { id: 'project', creatable: true },
      { id: 'task', creatable: true },
      { id: 'chat', creatable: true },
    ];
    // The daemon opens the task, but the TUI has no field for it yet: it stays out of the cycle.
    expect(stepType(task, 'project', 1)).toBe('chat');
    expect(stepType([{ id: 'chat', creatable: true }], 'chat', 1)).toBe('chat');
  });
});

describe('newScenarioRequest (N329)', () => {
  it('asks for the repository of a project and resolves it', () => {
    expect(newScenarioRequest('project', '../app', '/work/tui', '/home/x')).toEqual({
      type: 'project',
      repo: resolve('/work/app'),
    });
    expect(newScenarioRequest('project', '  ', '/work')).toEqual({
      missing: 'layout.newProject.noRepo',
    });
  });

  it('opens a chat with or without a name', () => {
    expect(newScenarioRequest('chat', '', '/work')).toEqual({ type: 'chat' });
    expect(newScenarioRequest('chat', '  ideias  ', '/work')).toEqual({
      type: 'chat',
      name: 'ideias',
    });
  });
});
