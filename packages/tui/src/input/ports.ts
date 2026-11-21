// SPDX-License-Identifier: MPL-2.0
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createClipboardIo, type ClipboardIo } from './clipboard-image.js';
import { createEditorIo, type EditorIo } from './external-editor.js';

/**
 * What the box needs of the machine: the clipboard, the external editor and the files. The box
 * takes them as an argument so that a test never runs the real tool (N57).
 */
export interface BoxPorts {
  readonly clipboard: ClipboardIo;
  readonly editor: EditorIo;
  /** Whether `path` is a file that exists (a folder is not). */
  isFile(path: string): Promise<boolean>;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
}

export function createBoxPorts(): BoxPorts {
  return {
    clipboard: createClipboardIo(),
    editor: createEditorIo(),
    isFile: async (path) => {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
    homedir: homedir(),
    platform: process.platform,
  };
}
