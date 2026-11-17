// SPDX-License-Identifier: MPL-2.0
import { isAbsolute, resolve } from 'node:path';
import {
  FilePromptSource,
  FilePromptSourceConfigSchema,
  filePromptSourceAdapter,
} from '@otheater/adapter-prompts-files';
import {
  AdapterUnavailable,
  InvalidInput,
  PROMPT_SOURCE_PORT_VERSION,
  type PromptSource,
} from '@otheater/core';
import semver from 'semver';
import { describeZodError, type DaemonConfig } from './config.js';

/**
 * The prompt source the config asks for (`adapters.prompts`, `prompts.*`). It lives apart from
 * `compose.ts` (the only other file that names adapters) so the prompt step does not touch the
 * composition point; the adapter is range-checked here the same way `compose.ts` does it.
 * [proposta] A relative `prompts.directory` is read against the data directory, like `backup.dir`.
 */
export function defaultPromptSource(config: DaemonConfig, dataDir: string): PromptSource {
  const { range } = filePromptSourceAdapter.implements;
  if (
    filePromptSourceAdapter.implements.port !== 'PromptSource' ||
    semver.validRange(range) === null
  ) {
    throw new InvalidInput(
      `Adapter "${filePromptSourceAdapter.id}" declares a bad PromptSource range`,
    );
  }
  if (!semver.satisfies(PROMPT_SOURCE_PORT_VERSION, range)) {
    throw new AdapterUnavailable(
      `Adapter "${filePromptSourceAdapter.id}" does not support port PromptSource version ` +
        `${PROMPT_SOURCE_PORT_VERSION}: it declares the range "${range}"`,
    );
  }
  const parsed = FilePromptSourceConfigSchema.safeParse(config.prompts);
  if (!parsed.success) {
    const message = describeZodError(parsed.error)
      .split('; ')
      .map((part) => `prompts.${part}`)
      .join('; ');
    throw new InvalidInput(`config.yaml: ${message}`, { cause: parsed.error });
  }
  const { directory } = parsed.data;
  if (directory === undefined) return new FilePromptSource();
  return new FilePromptSource({
    directory: isAbsolute(directory) ? directory : resolve(dataDir, directory),
  });
}
