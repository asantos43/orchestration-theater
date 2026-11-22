// SPDX-License-Identifier: MPL-2.0
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as nodeSea from 'node:sea';
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
 * The versioned `prompts/` folder at the repository root (architecture 5.22 and the repository
 * layout, next to `locales/`). The daemon reads it the same way it reads `locales/`; shipping it
 * with an installed artifact is a packaging task of a later phase.
 */
export const BUNDLED_PROMPTS_DIR: string = fileURLToPath(
  new URL('../../../../prompts', import.meta.url),
);

/**
 * In the single executable (Phase 10, P1) the prompts are assets, `prompts/<role>.md`, and the list
 * of roles is read from the asset index the build writes. A small copy of the helper of
 * `@otheater/client/node`, since an adapter imports no package of the workspace besides `core`.
 */
function seaAsset(key: string): string | undefined {
  try {
    return nodeSea.isSea() ? nodeSea.getAsset(key, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function seaRoleNames(): string[] | undefined {
  const index = seaAsset('ot-assets.json');
  if (index === undefined) return undefined;
  try {
    const keys = JSON.parse(index) as unknown;
    if (!Array.isArray(keys)) return undefined;
    return keys
      .filter((key): key is string => typeof key === 'string' && key.startsWith('prompts/'))
      .map((key) => key.slice('prompts/'.length));
  } catch {
    return undefined;
  }
}

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
  /** Reads the assets of the executable: no folder was asked for, and this is a SEA. */
  private readonly fromAssets: boolean;

  constructor(options: FilePromptSourceOptions = {}) {
    this.directory = options.directory ?? BUNDLED_PROMPTS_DIR;
    this.fromAssets = options.directory === undefined && seaRoleNames() !== undefined;
  }

  async roles(): Promise<readonly string[]> {
    let names: string[];
    try {
      names = this.fromAssets ? (seaRoleNames() ?? []) : await readdir(this.directory);
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
    if (this.fromAssets) {
      const asset = seaAsset(`prompts/${role}${EXTENSION}`);
      if (asset === undefined) throw new NotFound(`No prompt for the role "${role}"`);
      raw = asset;
    } else {
      raw = await this.readFromDisk(role);
    }
    const text = normalize(raw);
    if (text === '') {
      throw new AdapterUnavailable(`The prompt of the role "${role}" is empty`);
    }
    return text;
  }

  private async readFromDisk(role: string): Promise<string> {
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
    return raw;
  }
}
