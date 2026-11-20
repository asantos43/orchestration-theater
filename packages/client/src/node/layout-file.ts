// SPDX-License-Identifier: MPL-2.0
import { readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LayoutInterface } from '@otheater/protocol';
import type { LayoutFileStore } from '../layout/persistence.js';
import { writePrivateFileAtomic, type WritePrivateFileOptions } from './files.js';

/**
 * The file of the `local` layout mode (`ui.layout.store: local`, P12 of docs/17): one file per
 * interface in the client folder, beside `client.json`. [proposta] Name `layout.<interface>.json`,
 * mode 0600 and the same atomic write as the list of daemons.
 */

/** `layout.tui.json` or `layout.web.json`. */
export function layoutFileName(layoutInterface: LayoutInterface): string {
  return `layout.${layoutInterface}.json`;
}

/** The layout file of an interface inside the client folder. */
export function clientLayoutFile(configDir: string, layoutInterface: LayoutInterface): string {
  return resolve(configDir, layoutFileName(layoutInterface));
}

/** What a file that cannot be used is renamed to, so the copy stays beside it. */
export const LAYOUT_SET_ASIDE_SUFFIX = '.bad';

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'ENOENT';
}

export class FileLayoutStore implements LayoutFileStore {
  readonly #path: string;
  readonly #options: WritePrivateFileOptions;

  constructor(path: string, options: WritePrivateFileOptions = {}) {
    this.#path = resolve(path);
    this.#options = options;
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<string | undefined> {
    try {
      return await readFile(this.#path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  write(text: string): Promise<void> {
    return writePrivateFileAtomic(this.#path, text, this.#options);
  }

  async setAside(): Promise<boolean> {
    try {
      await rename(this.#path, `${this.#path}${LAYOUT_SET_ASIDE_SUFFIX}`);
      return true;
    } catch {
      return false;
    }
  }
}
