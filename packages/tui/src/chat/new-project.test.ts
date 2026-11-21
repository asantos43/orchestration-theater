// SPDX-License-Identifier: MPL-2.0
import type { ChatServerMessage } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { newProjectLine, openedProjectOf } from './new-project.js';

describe('newProjectLine', () => {
  it('reads the repository after "/new project"', () => {
    expect(newProjectLine('/new project /work/app')).toEqual({ repo: '/work/app' });
    expect(newProjectLine('  /new   project   ../app  ')).toEqual({ repo: '../app' });
  });

  it('gives an empty repository when the line has none', () => {
    expect(newProjectLine('/new project')).toEqual({ repo: '' });
    expect(newProjectLine('/new project   ')).toEqual({ repo: '' });
  });

  it('leaves every other line alone', () => {
    expect(newProjectLine('/new')).toBeUndefined();
    expect(newProjectLine('/new notes')).toBeUndefined();
    expect(newProjectLine('/new projects')).toBeUndefined();
    expect(newProjectLine('hello /new project x')).toBeUndefined();
  });
});

function result(data: unknown, over: Record<string, unknown> = {}): ChatServerMessage {
  return {
    type: 'command_result',
    result: { status: 'done', command: 'new', text: 'ok', data, ...over },
  } as unknown as ChatServerMessage;
}

describe('openedProjectOf', () => {
  it('gives the scenario a /new project opened', () => {
    expect(openedProjectOf(result({ scenarioId: 'p-1', type: 'project' }))).toBe('p-1');
  });

  it('ignores a chat, another command, a failure and other frames', () => {
    expect(openedProjectOf(result({ scenarioId: 'c-1', type: 'chat' }))).toBeUndefined();
    expect(
      openedProjectOf(result({ scenarioId: 'p-1', type: 'project' }, { command: 'help' })),
    ).toBeUndefined();
    expect(
      openedProjectOf(result({ scenarioId: 'p-1', type: 'project' }, { status: 'confirm' })),
    ).toBeUndefined();
    expect(openedProjectOf(result(undefined))).toBeUndefined();
    expect(openedProjectOf(result([]))).toBeUndefined();
    expect(
      openedProjectOf({ type: 'busy', busy: true } as unknown as ChatServerMessage),
    ).toBeUndefined();
  });
});
