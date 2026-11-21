// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_SETTINGS, parseInputSettings, type InputSettings } from './settings.js';
import {
  createBoxState,
  reduceBox,
  type BoxContext,
  type BoxEffect,
  type BoxEvent,
  type BoxState,
} from './state.js';

const CTX: BoxContext = { settings: DEFAULT_INPUT_SETTINGS, homedir: '/home/u', platform: 'linux' };

interface Run {
  state: BoxState;
  effects: BoxEffect[];
}

function run(
  events: readonly BoxEvent[],
  options: { from?: BoxState; settings?: InputSettings } = {},
): Run {
  const ctx = options.settings === undefined ? CTX : { ...CTX, settings: options.settings };
  let state = options.from ?? createBoxState();
  const effects: BoxEffect[] = [];
  for (const event of events) {
    const result = reduceBox(state, event, ctx);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

const type = (value: string): BoxEvent => ({ type: 'text', value });
const act = (id: string): BoxEvent => ({ type: 'action', id: `input.${id}` });
const paste = (text: string): BoxEvent => ({ type: 'paste', text });

describe('the state of the text box', () => {
  describe('sending', () => {
    it('sends the text, clears the box and asks for the history to be saved', () => {
      const { state, effects } = run([type('hello'), act('submit')]);
      expect(state.editor.text).toBe('');
      expect(effects).toEqual([
        { type: 'submit', message: { text: 'hello', attachments: [] } },
        { type: 'saveHistory', text: 'hello' },
      ]);
      expect(state.nav.entries.map((entry) => entry.text)).toEqual(['hello']);
    });

    it('ignores an empty message and one of only spaces', () => {
      expect(run([act('submit')]).effects).toEqual([]);
      expect(run([type('  '), act('submit')]).effects).toEqual([]);
    });

    it('sends only the attachments whose marker is still in the text', () => {
      const long = 'x\n'.repeat(30);
      const pasted = run([paste(long), paste(long.replace(/x/g, 'y'))]);
      expect(pasted.state.drafts).toHaveLength(2);
      // Backspace removes the second marker whole.
      const removed = run([act('backspace'), act('submit')], { from: pasted.state });
      const sent = removed.effects[0];
      expect(sent?.type === 'submit' && sent.message.attachments.map((d) => d.number)).toEqual([1]);
    });

    it('puts the message back when the owner refuses it and the box is empty', () => {
      const first = run([type('hello'), act('submit')]);
      const sent = { text: 'hello', drafts: [] };
      const failed = run([{ type: 'submitFailed', message: 'boom', sent }], { from: first.state });
      expect(failed.state.editor.text).toBe('hello');
      expect(failed.state.status).toEqual({ key: 'input.status.submitFailed', params: { message: 'boom' } });
      // The Producer already started something else: it is not overwritten.
      const typing = run([type('new'), { type: 'submitFailed', message: 'boom', sent }], {
        from: first.state,
      });
      expect(typing.state.editor.text).toBe('new');
    });
  });

  describe('new line and editing', () => {
    it('inserts a new line, and Up and Down move between the lines', () => {
      const lines = run([type('ab'), act('newline'), type('cd')]);
      expect(lines.state.editor.text).toBe('ab\ncd');
      const upOne = run([act('up')], { from: lines.state });
      expect(upOne.state.editor.cursor).toBe(2);
      expect(run([act('down')], { from: upOne.state }).state.editor.cursor).toBe(5);
    });

    it('moves and cuts like readline', () => {
      let r = run([type('hello brave world')]);
      r = run([act('wordLeft'), act('killWordBack')], { from: r.state });
      expect(r.state.editor.text).toBe('hello world');
      r = run([act('yank')], { from: r.state });
      expect(r.state.editor.text).toBe('hello brave world');
      r = run([act('lineStart'), act('killToEnd')], { from: r.state });
      expect(r.state.editor.text).toBe('');
      r = run([act('yank'), act('lineStart'), act('killWordForward')], { from: r.state });
      expect(r.state.editor.text).toBe(' brave world');
      r = run([act('lineEnd'), act('killToStart')], { from: r.state });
      expect(r.state.editor.text).toBe('');
    });

    it('moves by character and deletes forward and backward', () => {
      let r = run([type('abc'), act('left'), act('left'), act('delete')]);
      expect(r.state.editor.text).toBe('ac');
      r = run([act('right'), act('backspace')], { from: r.state });
      expect(r.state.editor.text).toBe('a');
      r = run([act('wordLeft'), act('wordRight')], { from: r.state });
      expect(r.state.editor.cursor).toBe(1);
    });
  });

  describe('the history', () => {
    const history = createBoxState(['first', 'second']);

    it('goes back with Up from the first line and forward with Down, keeping the draft', () => {
      let r = run([type('draft'), act('up')], { from: history });
      expect(r.state.editor.text).toBe('second');
      r = run([act('up')], { from: r.state });
      expect(r.state.editor.text).toBe('first');
      r = run([act('up')], { from: r.state });
      expect(r.state.editor.text).toBe('first');
      r = run([act('down'), act('down')], { from: r.state });
      expect(r.state.editor.text).toBe('draft');
    });

    it('does not take Up on a line that is not the first', () => {
      const r = run([type('a'), act('newline'), type('b'), act('up')], { from: history });
      expect(r.state.editor.text).toBe('a\nb');
    });

    it('does not repeat a message equal to the last one', () => {
      const r = run([type('same'), act('submit'), type('same'), act('submit')]);
      expect(r.state.nav.entries.map((entry) => entry.text)).toEqual(['same']);
    });

    it('keeps the history of the file before the ones sent while it was read', () => {
      const r = run([type('now'), act('submit'), { type: 'historyLoaded', texts: ['old'] }]);
      expect(r.state.nav.entries.map((entry) => entry.text)).toEqual(['old', 'now']);
    });

    it('says when the history could not be saved', () => {
      const r = run([{ type: 'historyFailed', message: 'disk full' }]);
      expect(r.state.status?.key).toBe('input.status.historyFailed');
    });
  });

  describe('the search of Ctrl+R', () => {
    const history = createBoxState(['deploy the app', 'fix the bug', 'deploy again']);

    it('starts at the newest message and narrows with what is typed', () => {
      let r = run([type('wip'), act('historySearch')], { from: history });
      expect(r.state.search?.matches).toBe(3);
      expect(r.state.editor.text).toBe('deploy again');
      r = run([type('bug')], { from: r.state });
      expect(r.state.editor.text).toBe('fix the bug');
      expect(r.state.search?.query).toBe('bug');
    });

    it('goes to older matches with Ctrl+R again and newer ones with Down', () => {
      let r = run([act('historySearch'), type('deploy')], { from: history });
      expect(r.state.editor.text).toBe('deploy again');
      r = run([act('historySearch')], { from: r.state });
      expect(r.state.editor.text).toBe('deploy the app');
      r = run([act('down')], { from: r.state });
      expect(r.state.editor.text).toBe('deploy again');
    });

    it('accepts the match with Enter, without sending it', () => {
      const r = run([act('historySearch'), type('bug'), act('submit')], { from: history });
      expect(r.state.search).toBeUndefined();
      expect(r.state.editor.text).toBe('fix the bug');
      expect(r.effects).toEqual([]);
    });

    it('brings back what was in the box with Esc', () => {
      const r = run([type('wip'), act('historySearch'), type('bug'), act('cancel')], { from: history });
      expect(r.state.search).toBeUndefined();
      expect(r.state.editor.text).toBe('wip');
    });

    it('shows no message when nothing matches, and Backspace edits the query', () => {
      let r = run([type('wip'), act('historySearch'), type('zzz')], { from: history });
      expect(r.state.search?.matches).toBe(0);
      expect(r.state.editor.text).toBe('wip');
      r = run([act('backspace'), act('backspace'), act('backspace')], { from: r.state });
      expect(r.state.search?.query).toBe('');
      expect(r.state.search?.matches).toBe(3);
    });

    it('runs any other action after accepting the match', () => {
      const r = run([act('historySearch'), type('bug'), act('lineStart')], { from: history });
      expect(r.state.search).toBeUndefined();
      expect(r.state.editor.text).toBe('fix the bug');
      expect(r.state.editor.cursor).toBe(0);
    });
  });

  describe('paste', () => {
    it('puts a short paste into the text, with the tabs and control characters cleaned', () => {
      const r = run([paste('a\tb\r\nc\x07')]);
      expect(r.state.editor.text).toBe('a    b\nc');
      expect(r.state.drafts).toEqual([]);
    });

    it('turns a paste of 2,000 lines into a marker and keeps the whole text in the attachment', () => {
      const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
      const text = lines.join('\n');
      const r = run([type('see: '), paste(text)]);
      expect(r.state.editor.text).toBe('see: [Pasted text #1]');
      expect(r.state.drafts).toHaveLength(1);
      expect(r.state.drafts[0]?.body).toEqual({ text, name: 'pasted-text-1.txt' });
      const sent = run([act('submit')], { from: r.state }).effects[0];
      expect(sent?.type === 'submit' && sent.message.attachments).toHaveLength(1);
    });

    it('turns a paste of many characters into a marker too, and numbers the markers in sequence', () => {
      const r = run([paste('x'.repeat(2001)), paste('y\n'.repeat(11))]);
      expect(r.state.editor.text).toBe('[Pasted text #1][Pasted text #2]');
    });

    it('keeps every paste inline with ui.input.paste.mode: inline', () => {
      const text = 'x\n'.repeat(50);
      const r = run([paste(text)], { settings: parseInputSettings({ paste: { mode: 'inline' } }) });
      expect(r.state.editor.text).toBe(text);
      expect(r.state.drafts).toEqual([]);
    });

    it('respects the limits of ui.input.paste', () => {
      const settings = parseInputSettings({ paste: { lines: 2, chars: 10_000 } });
      expect(run([paste('a\nb')], { settings }).state.drafts).toEqual([]);
      expect(run([paste('a\nb\nc')], { settings }).state.drafts).toHaveLength(1);
    });

    it('asks to resolve a pasted path, and attaches the file when it exists', () => {
      const asked = run([paste("'/home/u/my notes.md'")]);
      expect(asked.effects).toEqual([
        { type: 'resolvePaths', paths: ['/home/u/my notes.md'], raw: "'/home/u/my notes.md'" },
      ]);
      const done = run(
        [{ type: 'pathsResolved', raw: 'x', files: ['/home/u/my notes.md', '/home/u/shot.png'] }],
        { from: type0('look: ') },
      );
      expect(done.state.editor.text).toBe('look: [File #1] [Image #2]');
      expect(done.state.drafts.map((d) => d.body)).toEqual([
        { path: '/home/u/my notes.md', mode: 'copy' },
        { path: '/home/u/shot.png', mode: 'copy' },
      ]);
      expect(done.state.status).toEqual({
        key: 'input.status.filesAdded',
        params: { names: 'my notes.md, shot.png' },
      });
    });

    it('pastes a path that is not a file as plain text', () => {
      const r = run([{ type: 'pathsResolved', raw: '/no/such/file', files: undefined }]);
      expect(r.state.editor.text).toBe('/no/such/file');
      expect(r.state.drafts).toEqual([]);
    });

    it('does not look for files with ui.input.dropPaths: text', () => {
      const r = run([paste('/home/u/a.txt')], { settings: parseInputSettings({ dropPaths: 'text' }) });
      expect(r.effects).toEqual([]);
      expect(r.state.editor.text).toBe('/home/u/a.txt');
    });
  });

  describe('Ctrl+V', () => {
    it('asks for the image once, and ignores a second Ctrl+V while it waits', () => {
      const first = run([act('pasteImage')]);
      expect(first.effects).toEqual([{ type: 'readImage' }]);
      expect(first.state.busy).toBe('image');
      expect(first.state.status?.key).toBe('input.status.readingImage');
      expect(run([act('pasteImage')], { from: first.state }).effects).toEqual([]);
    });

    it('attaches the image as a marker with the temporary file', () => {
      const asked = run([act('pasteImage')]);
      const done = run(
        [{ type: 'imageRead', result: { kind: 'image', path: '/tmp/x/clip.png', mime: 'image/png', tool: 'wl-paste' } }],
        { from: asked.state },
      );
      expect(done.state.busy).toBeUndefined();
      expect(done.state.editor.text).toBe('[Image #1]');
      expect(done.state.drafts[0]).toMatchObject({
        kind: 'image',
        body: { path: '/tmp/x/clip.png', mode: 'copy' },
        temporaryPath: '/tmp/x/clip.png',
      });
    });

    it.each([
      [{ kind: 'no_image', tool: 'wl-paste' }, 'noImage', undefined],
      [{ kind: 'off' }, 'imageOff', undefined],
      [{ kind: 'tool_missing', tried: ['wl-paste', 'xclip'] }, 'toolMissing', { tools: 'wl-paste, xclip' }],
      [{ kind: 'timeout', tool: 'xclip', ms: 3000 }, 'toolTimeout', { tool: 'xclip', seconds: 3 }],
      [{ kind: 'too_big', tool: 'xclip', limit: 20 * 1024 * 1024 }, 'imageTooBig', { limit: 20 }],
      [{ kind: 'failed', tool: 'xclip', message: 'no display' }, 'toolFailed', { tool: 'xclip', message: 'no display' }],
    ] as const)('says what happened when the clipboard gives %j', (result, key, params) => {
      const asked = run([act('pasteImage')]);
      const done = run([{ type: 'imageRead', result }], { from: asked.state });
      expect(done.state.busy).toBeUndefined();
      expect(done.state.editor.text).toBe('');
      expect(done.state.status).toEqual({ key: `input.status.${key}`, params });
    });
  });

  describe('Ctrl+G', () => {
    it('hands the text to the editor, and takes back what was saved', () => {
      const asked = run([type('draft'), act('externalEditor')]);
      expect(asked.effects).toEqual([{ type: 'editExternally', text: 'draft' }]);
      expect(asked.state.busy).toBe('editor');
      const done = run([{ type: 'editorDone', result: { kind: 'edited', text: 'rewritten\nin vim' } }], {
        from: asked.state,
      });
      expect(done.state.editor.text).toBe('rewritten\nin vim');
      expect(done.state.editor.cursor).toBe('rewritten\nin vim'.length);
      expect(done.state.busy).toBeUndefined();
    });

    it.each([
      [{ kind: 'off' }, 'editorOff', undefined],
      [{ kind: 'missing' }, 'editorMissing', undefined],
      [{ kind: 'failed', message: 'nope' }, 'editorFailed', { message: 'nope' }],
    ] as const)('says what happened when the editor gives %j', (result, key, params) => {
      const asked = run([type('draft'), act('externalEditor')]);
      const done = run([{ type: 'editorDone', result }], { from: asked.state });
      expect(done.state.editor.text).toBe('draft');
      expect(done.state.status).toEqual({ key: `input.status.${key}`, params });
    });
  });

  it('clears the status with the next key', () => {
    const r = run([{ type: 'imageRead', result: { kind: 'off' } }, type('a')]);
    expect(r.state.status).toBeUndefined();
  });
});

function type0(text: string): BoxState {
  return run([type(text)]).state;
}
