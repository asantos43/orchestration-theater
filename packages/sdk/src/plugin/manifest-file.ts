// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import {
  describeManifestProblems,
  parsePluginManifestText,
  type PluginManifest,
  type PluginManifestOptions,
  type PluginManifestProblem,
} from '@otheater/core';
import { parse as parseYaml } from 'yaml';

/** The `plugin.yaml` is not valid: `problems` has each field and what is wrong with it. */
export class PluginManifestError extends Error {
  override readonly name = 'PluginManifestError';
  constructor(
    readonly source: string,
    readonly problems: readonly PluginManifestProblem[],
  ) {
    super(`invalid plugin manifest ${source}:\n${describeManifestProblems(problems)}`);
  }
}

/**
 * Reads and validates a `plugin.yaml` with the validator of `@otheater/core` (the one the daemon
 * runs on install). It throws a {@link PluginManifestError} that lists every problem found.
 */
export function readPluginManifest(
  file: string | URL,
  options: PluginManifestOptions = {},
): PluginManifest {
  const result = parsePluginManifestText(readFileSync(file, 'utf8'), parseYaml, options);
  if (!result.ok) throw new PluginManifestError(String(file), result.problems);
  return result.manifest;
}
