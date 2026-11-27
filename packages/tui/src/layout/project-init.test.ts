// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { initExtra, initOptions, initVerdict } from './project-init.js';

const INIT_MODES = ['ask', 'commit_all', 'empty_commit', 'refuse'] as const;
const EMPTY_MODES = ['ask', 'software', 'empty_repo', 'refuse'] as const;

describe('initVerdict (N332)', () => {
  it('opens a repository and a folder inside one, whatever the modes', () => {
    for (const state of ['repo', 'inside_repo'] as const) {
      for (const initMode of INIT_MODES) {
        for (const emptyMode of EMPTY_MODES) {
          expect(initVerdict({ state, initMode, emptyMode })).toEqual({ action: 'open' });
        }
      }
    }
  });

  it('a folder with files follows projects.init.mode, whatever empty_mode is', () => {
    for (const emptyMode of EMPTY_MODES) {
      const files = (initMode: (typeof INIT_MODES)[number]) =>
        initVerdict({ state: 'files', initMode, emptyMode });
      expect(files('ask')).toEqual({ action: 'ask', kind: 'files' });
      expect(files('commit_all')).toEqual({ action: 'open' });
      expect(files('empty_commit')).toEqual({ action: 'open' });
      expect(files('refuse')).toEqual({ action: 'refuse', kind: 'files' });
    }
  });

  it('an empty or missing folder follows projects.init.empty_mode, whatever mode is', () => {
    for (const initMode of INIT_MODES) {
      for (const state of ['empty', 'missing'] as const) {
        const verdict = (emptyMode: (typeof EMPTY_MODES)[number]) =>
          initVerdict({ state, initMode, emptyMode });
        expect(verdict('ask')).toEqual({ action: 'ask', kind: state });
        // The daemon applies `software` and `empty_repo` on its own when the folder is opened.
        expect(verdict('software')).toEqual({ action: 'open' });
        expect(verdict('empty_repo')).toEqual({ action: 'open' });
        expect(verdict('refuse')).toEqual({ action: 'refuse', kind: 'empty' });
      }
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
