// SPDX-License-Identifier: MPL-2.0
import { PROMPT_SOURCE_PORT_VERSION, type Adapter } from '@otheater/core';
import { z } from 'zod';

export {
  BUNDLED_PROMPTS_DIR,
  FilePromptSource,
  type FilePromptSourceOptions,
} from './file-prompt-source.js';

/**
 * Configuration of the files prompt source (`adapters.prompts: files`). `directory` replaces the
 * repository folder `prompts/` (a user's own prompts); without it that folder is used.
 */
export const FilePromptSourceConfigSchema = z.strictObject({
  directory: z.string().min(1).optional(),
});

export type FilePromptSourceConfig = z.infer<typeof FilePromptSourceConfigSchema>;

/** Identity of this adapter for the composition point (architecture 5.18). */
export const filePromptSourceAdapter: Adapter = {
  id: 'files',
  implements: { port: 'PromptSource', range: `^${PROMPT_SOURCE_PORT_VERSION}` },
};
