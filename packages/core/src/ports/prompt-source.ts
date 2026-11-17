// SPDX-License-Identifier: MPL-2.0

/** Semver of the `PromptSource` port contract (architecture 5.18, "Versão dos contratos"). */
export const PROMPT_SOURCE_PORT_VERSION = '0.1.0';

/**
 * Where the initial prompt of each role comes from (architecture 5.10 and 5.18). The default
 * adapter reads the versioned `prompts/` folder; prompts per project are a [hipótese] for later.
 *
 * [proposta] The minimal contract: one plain-text prompt per role, in English (architecture 5.22).
 * It carries no templating and no version of its own; the daemon assembles the prefix around it
 * (`assemblePrefix`) and checks it against the registries on start-up (`assertValidPrompts`).
 *
 * Contract (checked by `describePromptSourceConformance` in `@otheater/sdk`):
 * - `roles()` lists the ids of the roles that have a prompt, sorted, each one matching
 *   `ROLE_ID_PATTERN`. It does not check them against the role registry: that is the daemon's job.
 * - `get(role)` resolves with the prompt text: line breaks are `\n`, no trailing blank space, and
 *   never empty. The same call returns the same text while the source does not change.
 * - `get` of a role that has no prompt rejects with `NotFound`; a role id that does not match
 *   `ROLE_ID_PATTERN` (a path, an upper-case name) rejects with `InvalidInput`, without touching
 *   the storage.
 * - A source that cannot be read (folder missing, no permission) rejects with `AdapterUnavailable`.
 */
export interface PromptSource {
  roles(): Promise<readonly string[]>;
  get(role: string): Promise<string>;
}
