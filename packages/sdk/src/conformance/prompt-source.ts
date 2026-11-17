// SPDX-License-Identifier: MPL-2.0
import { PROMPT_SOURCE_PORT_VERSION, type PromptSource } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { rejectionOf } from './helpers.js';

export interface PromptSourceHarness extends Disposable {
  readonly source: PromptSource;
  /**
   * What the source was filled with, by role id: the texts exactly as `get` must return them
   * (already `\n` line breaks and trimmed). Needs at least two roles.
   */
  readonly prompts: Readonly<Record<string, string>>;
}

/**
 * Registers the `PromptSource` conformance tests (port version {@link PROMPT_SOURCE_PORT_VERSION})
 * in the calling Vitest file. Call it at the top level of a test file, once per adapter.
 */
export function describePromptSourceConformance(
  name: string,
  factory: AdapterFactory<PromptSourceHarness>,
): void {
  describe(`PromptSource conformance: ${name} (port ${PROMPT_SOURCE_PORT_VERSION})`, () => {
    const harness = useHarness(factory);

    it('roles() lists the roles that have a prompt, sorted', async () => {
      const { source, prompts } = harness();
      expect(await source.roles()).toEqual(Object.keys(prompts).sort());
    });

    it('get() returns the text of each role, and the same text on a second call', async () => {
      const { source, prompts } = harness();
      for (const [role, text] of Object.entries(prompts)) {
        expect(await source.get(role)).toBe(text);
        expect(await source.get(role)).toBe(text);
      }
    });

    it('get() never returns an empty text', async () => {
      const { source } = harness();
      for (const role of await source.roles()) {
        expect((await source.get(role)).trim()).not.toBe('');
      }
    });

    it('get() of a role without a prompt rejects with NOT_FOUND', async () => {
      const { source } = harness();
      expect(await rejectionOf(source.get('no_such_role'))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('get() of something that is not a role id rejects with INVALID_INPUT', async () => {
      const { source } = harness();
      for (const role of ['', '../secrets', 'a/b', 'Director', 'has space', '.hidden']) {
        expect(await rejectionOf(source.get(role))).toMatchObject({ code: 'INVALID_INPUT' });
      }
    });
  });
}
