// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  describeManifestProblems,
  InvalidInput,
  parsePluginManifestText,
  PLUGIN_MANIFEST_MAX_CHARS,
  type PluginManifest,
} from '@otheater/core';
import { parse as parseYaml } from 'yaml';

/** The manifest sits at the root of the folder of the plugin (architecture 5.14). */
export const PLUGIN_MANIFEST_FILE = 'plugin.yaml';

/** A manifest read from a folder: validated by the P3 validator, and the hash of its bytes. */
export interface ReadPluginManifest {
  readonly manifest: PluginManifest;
  /** SHA-256 (hex) of the bytes of `plugin.yaml`: what the Producer approves (N236). */
  readonly hash: string;
}

/** SHA-256 (hex) of the bytes of a manifest. */
export function hashManifestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Reads and validates `<dir>/plugin.yaml`. Throws `InvalidInput`: a missing or oversized file, or
 * a file that is not a regular file (a link could point out of the folder), says so; an invalid
 * manifest carries the lines of the P3 validator (`tools[1].effects: ...`), one problem per line.
 * `frameworkToolNames` is the set of tool names of the frozen registry (a plugin tool may not take
 * one); it defaults to the official tools, as the validator does.
 */
export async function readPluginManifest(
  dir: string,
  options: { readonly frameworkToolNames?: Iterable<string> | undefined } = {},
): Promise<ReadPluginManifest> {
  const file = join(dir, PLUGIN_MANIFEST_FILE);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InvalidInput(`There is no ${PLUGIN_MANIFEST_FILE} in ${dir}`, { cause: error });
    }
    throw new InvalidInput(`Cannot read ${file}: ${String(error)}`, { cause: error });
  }
  if (!info.isFile()) {
    throw new InvalidInput(`${file} is not a regular file (a link or a folder is refused)`);
  }
  // A UTF-8 character takes at most 4 bytes: past this it is over the character limit anyway.
  if (info.size > PLUGIN_MANIFEST_MAX_CHARS * 4) {
    throw new InvalidInput(
      `${file} is too big (more than ${String(PLUGIN_MANIFEST_MAX_CHARS)} characters)`,
    );
  }
  const bytes = await readFile(file);
  const result = parsePluginManifestText(bytes.toString('utf8'), parseYaml, {
    frameworkToolNames: options.frameworkToolNames,
  });
  if (!result.ok) {
    throw new InvalidInput(
      `Invalid ${PLUGIN_MANIFEST_FILE} in ${dir}:\n${describeManifestProblems(result.problems)}`,
    );
  }
  return { manifest: result.manifest, hash: hashManifestBytes(bytes) };
}
