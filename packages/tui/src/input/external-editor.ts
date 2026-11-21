// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorMessage } from './clipboard-image.js';
import { normalizeNewlines, splitShellWords } from './paste.js';
import type { EditorMode } from './settings.js';

/**
 * Ctrl+G (N35): the message goes to a temporary file, the editor of `$VISUAL` (or `$EDITOR`) opens
 * it, and what is saved comes back to the box. The TUI hands the terminal to the editor and takes
 * it back (`suspendTerminal` of Ink, in the component); this module only runs the editor.
 */

export type ExternalEditResult =
  | { readonly kind: 'edited'; readonly text: string }
  | { readonly kind: 'off' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly message: string };

export interface EditorIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** Writes the temporary file with the message and returns its path. */
  prepare(text: string): Promise<string>;
  /** Runs the editor, with the terminal, until it exits. */
  run(command: readonly string[], file: string): Promise<{ readonly code: number | null }>;
  read(path: string): Promise<string>;
  /** Removes the temporary file. */
  cleanup(path: string): Promise<void>;
}

/** The command of the editor from the environment: `$VISUAL`, then `$EDITOR`; `undefined` when none. */
export function resolveEditorCommand(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string[] | undefined {
  for (const name of ['VISUAL', 'EDITOR']) {
    const value = env[name]?.trim() ?? '';
    if (value === '') continue;
    const words = splitShellWords(value, platform !== 'win32');
    if (words !== undefined && words.length > 0) return words;
  }
  return undefined;
}

/** What the file holds, as the box takes it: `\n` lines, and no newline the editor added at the end. */
export function textFromEditor(content: string): string {
  return normalizeNewlines(content).replace(/\n$/, '');
}

export async function editExternally(
  text: string,
  mode: EditorMode,
  io: EditorIo,
): Promise<ExternalEditResult> {
  if (mode === 'off') return { kind: 'off' };
  const command = resolveEditorCommand(io.env, io.platform);
  if (command === undefined) return { kind: 'missing' };
  let file: string | undefined;
  try {
    file = await io.prepare(text);
    const { code } = await io.run(command, file);
    if (code !== 0) return { kind: 'failed', message: `${command[0] ?? ''} exit ${String(code)}` };
    return { kind: 'edited', text: textFromEditor(await io.read(file)) };
  } catch (error) {
    return { kind: 'failed', message: errorMessage(error) };
  } finally {
    if (file !== undefined) await io.cleanup(file).catch(() => undefined);
  }
}

/** The editor on this machine. */
export function createEditorIo(): EditorIo {
  return {
    env: process.env,
    platform: process.platform,
    prepare: async (text) => {
      const folder = await mkdtemp(join(tmpdir(), 'otheater-edit-'));
      const file = join(folder, 'message.md');
      await writeFile(file, text, { mode: 0o600 });
      return file;
    },
    run: (command, file) =>
      new Promise((resolve, reject) => {
        const [program, ...args] = command;
        if (program === undefined) {
          reject(new Error('no editor'));
          return;
        }
        const child = spawn(program, [...args, file], { stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', (code) => {
          resolve({ code });
        });
      }),
    read: (path) => readFile(path, 'utf8'),
    cleanup: (path) => rm(join(path, '..'), { recursive: true, force: true }),
  };
}
