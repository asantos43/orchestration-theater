// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { crossCheckNotices, loadCrossCheckNotices } from './cross-check-notices.js';
import { selectionSettingsOf } from './executor-selection.js';

const store = async (ids: readonly string[]): Promise<InMemoryStore> => {
  const memory = new InMemoryStore({ clock: new FakeClock() });
  for (const id of ids) {
    const [client = '', name = ''] = id.split('/');
    await memory.profiles.create({
      client,
      name,
      kind: 'token_plan',
      provider: client === 'codex' ? 'openai' : 'anthropic',
      dir: `/p/${name}`,
      secretRef: null,
    });
  }
  return memory;
};

const ENTRIES = `
executors:
  claude-opus-high@claude-code/empresa: { client: claude-code, profile: empresa, model: claude-opus, effort: high }
  claude-opus-high@claude-code/pessoal: { client: claude-code, profile: pessoal, model: claude-opus, effort: high }
  claude-sonnet-high@claude-code/empresa: { client: claude-code, profile: empresa, model: claude-sonnet, effort: high }
  codex-sol-high@codex/conta-1: { client: codex, profile: conta-1, model: codex-sol, effort: high }
`;
const PROFILES = ['claude-code/empresa', 'claude-code/pessoal', 'codex/conta-1'];

const config = (crossCheck: string, roles: string) =>
  parseConfig(`${ENTRIES}\nselection:\n  cross_check: ${crossCheck}\nroles:\n${roles}\n`);

describe('the notice at load of a strict cross-review that cannot be met (P15b, N150)', () => {
  it('warns when the Reviewer has only one provider, two accounts being one provider', async () => {
    const notices = await loadCrossCheckNotices(
      config(
        'require_other_provider',
        `  reviewer: { executors: [claude-opus-high@claude-code/empresa, claude-opus-high@claude-code/pessoal] }
  critic: { executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1] }`,
      ),
      await store(PROFILES),
    );
    expect(notices.map((notice) => notice.role)).toEqual(['reviewer']);
    expect(notices[0]?.message).toMatch(
      /require_other_provider and the list of reviewer has Executors of one provider only \(anthropic\)/u,
    );
    expect(notices[0]?.message).toMatch(/selection\.same_provider_fallback: stronger_then_effort/u);
  });

  it('with other_model counts models, not providers nor accounts', async () => {
    const notices = await loadCrossCheckNotices(
      config(
        'other_model',
        `  reviewer: { executors: [claude-opus-high@claude-code/empresa, claude-opus-high@claude-code/pessoal] }
  critic: { executors: [claude-opus-high@claude-code/empresa, claude-sonnet-high@claude-code/empresa] }`,
      ),
      await store(PROFILES),
    );
    expect(notices.map((notice) => notice.role)).toEqual(['reviewer']);
    expect(notices[0]?.message).toMatch(/one model only \(claude-opus\)/u);
  });

  it('says nothing with prefer_other_provider or off', async () => {
    for (const mode of ['prefer_other_provider', 'off']) {
      const notices = await loadCrossCheckNotices(
        config(mode, '  reviewer: { executors: [claude-opus-high@claude-code/empresa] }'),
        await store(PROFILES),
      );
      expect(notices).toEqual([]);
    }
  });

  it('says nothing for a list with two providers, and nothing for the other roles', async () => {
    const notices = await loadCrossCheckNotices(
      config(
        'require_other_provider',
        `  reviewer: { executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1] }
  author: { executors: [claude-opus-high@claude-code/empresa] }`,
      ),
      await store(PROFILES),
    );
    expect(notices.filter((notice) => notice.role === 'reviewer')).toEqual([]);
    expect(notices.some((notice) => (notice.role as string) === 'author')).toBe(false);
  });

  it('crossCheckNotices skips an empty list of a role', () => {
    const settings = selectionSettingsOf(parseConfig('selection:\n  cross_check: other_model\n'));
    const empty = { executors: [] };
    const roles = { reviewer: empty, critic: empty } as unknown as Parameters<
      typeof crossCheckNotices
    >[1];
    expect(crossCheckNotices(settings, roles)).toEqual([]);
  });
});
