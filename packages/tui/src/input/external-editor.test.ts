// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEditorIo,
  editExternally,
  resolveEditorCommand,
  textFromEditor,
  type EditorIo,
} from './external-editor.js';

function fakeIo(
  env: Record<string, string>,
  run: (command: readonly string[], file: string) => Promise<{ code: number | null }>,
  files = new Map<string, string>(),
): { io: EditorIo; files: Map<string, string>; removed: string[] } {
  const removed: string[] = [];
  const io: EditorIo = {
    env,
    platform: 'linux',
    prepare: (text) => {
      files.set('/tmp/fake/message.md', text);
      return Promise.resolve('/tmp/fake/message.md');
    },
    run,
    read: (path) => Promise.resolve(files.get(path) ?? ''),
    cleanup: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
  };
  return { io, files, removed };
}

describe('the external editor', () => {
  it('takes $VISUAL before $EDITOR and splits the command like a shell', () => {
    expect(resolveEditorCommand({ VISUAL: 'code --wait', EDITOR: 'vi' }, 'linux')).toEqual([
      'code',
      '--wait',
    ]);
    expect(resolveEditorCommand({ EDITOR: '"/opt/my editor/ed" -n' }, 'linux')).toEqual([
      '/opt/my editor/ed',
      '-n',
    ]);
    expect(resolveEditorCommand({ VISUAL: '  ', EDITOR: 'nano' }, 'linux')).toEqual(['nano']);
    expect(resolveEditorCommand({}, 'linux')).toBeUndefined();
  });

  it('takes the text back without the newline the editor adds', () => {
    expect(textFromEditor('hello\r\nworld\n')).toBe('hello\nworld');
    expect(textFromEditor('a\n\n')).toBe('a\n');
  });

  it('runs the editor on a file with the message and returns what was saved', async () => {
    const seen: (readonly string[])[] = [];
    const { io, files, removed } = fakeIo({ EDITOR: 'myed -w' }, (command, file) => {
      seen.push([...command, file]);
      files.set(file, 'rewritten\nin the editor\n');
      return Promise.resolve({ code: 0 });
    });
    const result = await editExternally('draft', 'auto', io);
    expect(result).toEqual({ kind: 'edited', text: 'rewritten\nin the editor' });
    expect(seen).toEqual([['myed', '-w', '/tmp/fake/message.md']]);
    expect(removed).toEqual(['/tmp/fake/message.md']);
  });

  it('says so when the editor is off or not set, without running anything', async () => {
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve({ code: 0 });
    };
    expect(await editExternally('x', 'off', fakeIo({ EDITOR: 'vi' }, run).io)).toEqual({
      kind: 'off',
    });
    expect(await editExternally('x', 'auto', fakeIo({}, run).io)).toEqual({ kind: 'missing' });
    expect(runs).toBe(0);
  });

  it('reports an editor that fails or exits with an error, and still cleans up', async () => {
    const crashed = fakeIo({ EDITOR: 'ed' }, () => Promise.reject(new Error('spawn ed ENOENT')));
    expect(await editExternally('x', 'auto', crashed.io)).toEqual({
      kind: 'failed',
      message: 'spawn ed ENOENT',
    });
    expect(crashed.removed).toHaveLength(1);
    const bad = fakeIo({ EDITOR: 'ed' }, () => Promise.resolve({ code: 2 }));
    expect(await editExternally('x', 'auto', bad.io)).toEqual({
      kind: 'failed',
      message: 'ed exit 2',
    });
  });

  describe('with a real process (a local script as the editor)', () => {
    const folders: string[] = [];
    afterEach(async () => {
      for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
    });

    it('lets a program edit the file and removes it afterwards', async () => {
      const folder = await mkdtemp(join(tmpdir(), 'ot-editor-test-'));
      folders.push(folder);
      const script = join(folder, 'edit.cjs');
      await writeFile(
        script,
        "const fs = require('fs'); const f = process.argv[2]; fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + ' + edited\\n');",
      );
      const base = createEditorIo();
      let path = '';
      const io: EditorIo = {
        ...base,
        env: { EDITOR: `"${process.execPath}" "${script}"` },
        prepare: async (text) => (path = await base.prepare(text)),
      };
      const result = await editExternally('draft', 'auto', io);
      expect(result).toEqual({ kind: 'edited', text: 'draft + edited' });
      await expect(stat(path)).rejects.toBeDefined();
      expect(await readFile(script, 'utf8')).toContain('edited');
    });
  });
});
