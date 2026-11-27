// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { initExtra, initOptions, initVerdict } from './project-init.js';

describe('initVerdict (N332)', () => {
  it('opens a repository and a folder inside one, whatever the mode', () => {
    for (const state of ['repo', 'inside_repo'] as const) {
      for (const initMode of ['ask', 'commit_all', 'empty_commit', 'refuse'] as const) {
        expect(initVerdict({ state, initMode })).toEqual({ action: 'open' });
      }
    }
  });

  it('a folder with files follows projects.init.mode', () => {
    expect(initVerdict({ state: 'files', initMode: 'ask' })).toEqual({
      action: 'ask',
      kind: 'files',
    });
    expect(initVerdict({ state: 'files', initMode: 'commit_all' })).toEqual({ action: 'open' });
    expect(initVerdict({ state: 'files', initMode: 'empty_commit' })).toEqual({ action: 'open' });
    expect(initVerdict({ state: 'files', initMode: 'refuse' })).toEqual({ action: 'refuse' });
  });

  it('an empty or missing folder asks, whatever the mode', () => {
    for (const initMode of ['ask', 'commit_all', 'empty_commit', 'refuse'] as const) {
      expect(initVerdict({ state: 'empty', initMode })).toEqual({ action: 'ask', kind: 'empty' });
      expect(initVerdict({ state: 'missing', initMode })).toEqual({
        action: 'ask',
        kind: 'missing',
      });
    }
  });
});

describe('the options of the question (N332)', () => {
  it('has three options in each question, and cancel is the last', () => {
    expect(initOptions('files')).toEqual(['commit_all', 'empty_commit', 'cancel']);
    expect(initOptions('empty')).toEqual(['software', 'empty_repo', 'cancel']);
    expect(initOptions('missing')).toEqual(initOptions('empty'));
  });

  it('asks the daemon for init, or for the software model as newProject', () => {
    expect(initExtra('commit_all')).toEqual({ init: 'commit_all' });
    expect(initExtra('empty_commit')).toEqual({ init: 'empty_commit' });
    expect(initExtra('empty_repo')).toEqual({ init: 'empty_repo' });
    expect(initExtra('software')).toEqual({ newProject: true });
  });
});
