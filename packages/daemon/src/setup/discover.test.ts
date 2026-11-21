// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { discoverForPreset, presetHeads } from './discover.js';
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
