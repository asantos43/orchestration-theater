// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, NotFound } from '../errors.js';
import type { PromptSource } from '../ports/prompt-source.js';
import { ROLE_ID_PATTERN } from '../registries/roles.js';

/** A `PromptSource` over a plain object, for tests. The texts are returned as given. */
export class InMemoryPromptSource implements PromptSource {
  readonly #prompts: Map<string, string>;

  constructor(prompts: Readonly<Record<string, string>>) {
    this.#prompts = new Map(Object.entries(prompts));
  }

  roles(): Promise<readonly string[]> {
    return Promise.resolve([...this.#prompts.keys()].sort());
  }

  get(role: string): Promise<string> {
    if (!ROLE_ID_PATTERN.test(role)) {
      return Promise.reject(new InvalidInput(`"${role}" is not a role id`));
    }
    const text = this.#prompts.get(role);
    return text === undefined
      ? Promise.reject(new NotFound(`No prompt for the role "${role}"`))
      : Promise.resolve(text);
  }

  /** Replaces or adds the prompt of a role (tests that change the source after the start). */
  set(role: string, text: string): void {
    this.#prompts.set(role, text);
  }
}
