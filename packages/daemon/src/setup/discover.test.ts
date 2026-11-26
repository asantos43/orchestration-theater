// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { discoverForPreset, matchPreset, presetHeads } from './discover.js';
import { ListCatalog } from './rig-fixture.js';

describe('what the catalogs give for a preset', () => {
  it('names each head of the preset once, in the order the roles name them', () => {
    const heads = presetHeads('quality');
    expect(heads[0]).toBe('claude-haiku-low');
    expect(new Set(heads).size).toBe(heads.length);
    expect(heads).toContain('minimax-m2-medium');
  });

  it('turns a head the catalog lists into an Executor of that account', async () => {
    const { discovered, notes } = await discoverForPreset({
      accounts: ['claude-code/main', 'codex/main', 'opencode/key'],
      preset: 'quality',
      catalogs: (client) =>
        client === 'claude-code'
          ? new ListCatalog(['opus', 'haiku'])
          : client === 'codex'
            ? new ListCatalog(['sol'])
            : undefined,
      presetExpand: true,
    });
    expect(discovered.map((item) => item.id)).toEqual([
      'claude-haiku-low@claude-code/main',
      'claude-opus-high@claude-code/main',
      'codex-sol-high@codex/main',
    ]);
    expect(discovered.every((item) => item.source === 'discovered' && item.presetExpand)).toBe(
      true,
    );
    expect(discovered[0]).toMatchObject({
      provider: 'anthropic',
      model: 'haiku',
      alias: 'claude-haiku',
    });
    expect(notes).toEqual([]);
  });

  it('leaves out a model whose catalog does not accept the effort the preset names, with a note', async () => {
    const { discovered, notes } = await discoverForPreset({
      accounts: ['claude-code/main'],
      preset: 'quality',
      catalogs: () => new ListCatalog(['opus'], { efforts: ['low', 'medium'] }),
      presetExpand: true,
    });
    expect(discovered).toEqual([]);
    expect(notes.map((note) => note.code)).toEqual(['effort_not_accepted']);
  });

  it('a catalog that fails is a warning note, and the other accounts still go through', async () => {
    const { discovered, notes } = await discoverForPreset({
      accounts: ['claude-code/main', 'codex/main'],
      preset: 'balanced',
      catalogs: (client) =>
        client === 'claude-code' ? new ListCatalog([], { fail: true }) : new ListCatalog(['sol']),
      presetExpand: false,
    });
    expect(notes).toMatchObject([{ severity: 'warning', code: 'catalog_unavailable' }]);
    // `balanced` names `codex-sol-high` for the Consultant and `codex-sol-medium` for the others.
    expect(discovered.map((item) => item.id)).toEqual([
      'codex-sol-high@codex/main',
      'codex-sol-medium@codex/main',
    ]);
    expect(discovered.every((item) => !item.presetExpand)).toBe(true);
  });
});

describe('the family of a model of the preset (N333)', () => {
  // What the Codex catalog lists today: the version is in the name, the family is a word.
  const CODEX = ['gpt-5.6-sol', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna'];

  it('fills codex-sol with the newest listed sol, and keeps the name of the preset', async () => {
    const { discovered, notes } = await discoverForPreset({
      accounts: ['codex/main'],
      preset: 'balanced',
      catalogs: () => new ListCatalog(CODEX),
      presetExpand: true,
    });
    expect(notes).toEqual([]);
    // The Director of every preset names `codex-luna-low`.
    expect(discovered.map((item) => [item.id, item.model])).toEqual([
      ['codex-luna-low@codex/main', 'gpt-6-luna'],
      ['codex-sol-high@codex/main', 'gpt-6.2-sol'],
      ['codex-sol-medium@codex/main', 'gpt-6.2-sol'],
    ]);
    expect(discovered[1]).toMatchObject({ alias: 'codex-sol', provider: 'openai' });
  });

  it('fills every Codex head of the preset that names a listed family', () => {
    const heads = presetHeads('quality').filter((head) => head.startsWith('codex-'));
    const { discovered } = matchPreset({
      profileId: 'codex/main',
      listed: CODEX.map((id) => ({ id, efforts: [], local: false })),
      preset: 'quality',
      presetExpand: true,
    });
    expect(discovered.map((item) => item.id.split('@')[0])).toEqual(heads);
    expect(discovered.find((item) => item.alias === 'codex-luna')?.model).toBe('gpt-6-luna');
  });

  it('an id equal to the family comes before the newest of the family', () => {
    const { discovered } = matchPreset({
      profileId: 'codex/main',
      listed: ['gpt-6.2-sol', 'sol'].map((id) => ({ id, efforts: [], local: false })),
      preset: 'balanced',
      presetExpand: true,
    });
    expect(discovered.map((item) => item.model)).toEqual(['sol', 'sol']);
  });

  it('the family is a whole word: solar is not sol', () => {
    const { discovered } = matchPreset({
      profileId: 'codex/main',
      listed: ['gpt-7-solar'].map((id) => ({ id, efforts: [], local: false })),
      preset: 'balanced',
      presetExpand: true,
    });
    expect(discovered).toEqual([]);
  });

  it('takes the newest that accepts the effort of the head', () => {
    const { discovered, notes } = matchPreset({
      profileId: 'codex/main',
      listed: [
        { id: 'gpt-6.2-sol', efforts: ['medium'], local: false },
        { id: 'gpt-5.6-sol', efforts: ['medium', 'high'], local: false },
      ],
      preset: 'balanced',
      presetExpand: true,
    });
    expect(notes).toEqual([]);
    expect(discovered.map((item) => [item.id, item.model])).toEqual([
      ['codex-sol-high@codex/main', 'gpt-5.6-sol'],
      ['codex-sol-medium@codex/main', 'gpt-6.2-sol'],
    ]);
  });

  it('with no listed model of the family that takes the effort, a note names the newest', () => {
    const { discovered, notes } = matchPreset({
      profileId: 'codex/main',
      listed: [{ id: 'gpt-6.2-sol', efforts: ['low'], local: false }],
      preset: 'balanced',
      presetExpand: true,
    });
    expect(discovered).toEqual([]);
    expect(notes.map((note) => note.code)).toEqual(['effort_not_accepted', 'effort_not_accepted']);
    expect(notes[0]?.message).toContain('gpt-6.2-sol');
  });

  it('with setup.preset_match exact, only an id equal to the family fills the head', async () => {
    const { discovered } = await discoverForPreset({
      accounts: ['codex/main'],
      preset: 'balanced',
      catalogs: () => new ListCatalog(CODEX),
      presetExpand: true,
      match: { mode: 'exact', aliases: {} },
    });
    expect(discovered).toEqual([]);
  });

  it('executors.aliases comes first, in both modes', () => {
    for (const mode of ['newest', 'exact'] as const) {
      const { discovered } = matchPreset({
        profileId: 'codex/main',
        listed: CODEX.map((id) => ({ id, efforts: [], local: false })),
        preset: 'balanced',
        presetExpand: true,
        match: { mode, aliases: { 'codex-sol': 'gpt-5.6-sol' } },
      });
      const sol = discovered.filter((item) => item.alias === 'codex-sol');
      expect(sol.map((item) => item.model)).toEqual(['gpt-5.6-sol', 'gpt-5.6-sol']);
    }
  });

  it('an alias the catalog does not list is a note once, and the mode decides', () => {
    const { discovered, notes } = matchPreset({
      profileId: 'codex/main',
      listed: CODEX.map((id) => ({ id, efforts: [], local: false })),
      preset: 'balanced',
      presetExpand: true,
      match: { mode: 'newest', aliases: { 'codex-sol': 'gpt-9-sol' } },
    });
    expect(notes.map((note) => note.code)).toEqual(['alias_not_listed']);
    expect(notes[0]?.message).toContain('gpt-9-sol');
    const sol = discovered.filter((item) => item.alias === 'codex-sol');
    expect(sol.map((item) => item.model)).toEqual(['gpt-6.2-sol', 'gpt-6.2-sol']);
  });
});
