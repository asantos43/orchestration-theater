// SPDX-License-Identifier: MPL-2.0
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdapterUnavailable,
  InvalidInput,
  NotFound,
  ROLE_ID_PATTERN,
  type PromptSource,
} from '@otheater/core';

/** Extension of a prompt file: `prompts/<role>.md`. */
const EXTENSION = '.md';

/**
 * [proposta] The prompts ship inside this package (`prompts/` next to `src/` and `dist/`, listed in
 * `files` of its `package.json`), so the installed daemon finds them through the workspace link or
 * the published package and never depends on the working directory. The architecture draws the
 * folder at the repository root; keeping it here makes it part of the artifact that is installed.
 */
export const BUNDLED_PROMPTS_DIR: string = fileURLToPath(new URL('../prompts', import.meta.url));

export interface FilePromptSourceOptions {
  /** Folder with one `<role>.md` per role. Defaults to {@link BUNDLED_PROMPTS_DIR}. */
  readonly directory?: string | undefined;
}

/** Same text on every platform: no BOM, `\n` line breaks, no blank space around it. */
function normalize(raw: string): string {
  const withoutBom = raw.codePointAt(0) === 0xfeff ? raw.slice(1) : raw;
  return withoutBom.replace(/\r\n?/g, '\n').trim();
}

/**
 * `PromptSource` over a folder of Markdown files, one per role (`director.md`, `actor.md`, ...).
 * Reads on every call, so editing a file takes effect on the next session without a restart.
 * Files that do not look like `<role id>.md` are ignored.
 */
export class FilePromptSource implements PromptSource {
  private readonly directory: string;

  constructor(options: FilePromptSourceOptions = {}) {
    this.directory = options.directory ?? BUNDLED_PROMPTS_DIR;
  }

  async roles(): Promise<readonly string[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (cause) {
      throw new AdapterUnavailable(`Cannot read the prompts folder ${this.directory}`, { cause });
    }
    return names
      .filter((name) => name.endsWith(EXTENSION))
      .map((name) => name.slice(0, -EXTENSION.length))
      .filter((role) => ROLE_ID_PATTERN.test(role))
      .sort();
  }

  async get(role: string): Promise<string> {
    if (!ROLE_ID_PATTERN.test(role)) {
      throw new InvalidInput(`"${role}" is not a role id`);
    }
    let raw: string;
    try {
      raw = await readFile(join(this.directory, `${role}${EXTENSION}`), 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        // A missing folder is also ENOENT: tell it apart, it is the source that is broken then.
        try {
          await readdir(this.directory);
        } catch (dirCause) {
          throw new AdapterUnavailable(`Cannot read the prompts folder ${this.directory}`, {
            cause: dirCause,
          });
        }
        throw new NotFound(`No prompt for the role "${role}"`, { cause });
      }
      throw new AdapterUnavailable(`Cannot read the prompt of the role "${role}"`, { cause });
    }
    const text = normalize(raw);
    if (text === '') {
      throw new AdapterUnavailable(`The prompt of the role "${role}" is empty`);
    }
    return text;
  }
}
