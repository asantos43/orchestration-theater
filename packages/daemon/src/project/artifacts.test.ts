// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileConventions, type ProjectConventions } from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDeliveryArtifacts,
  changelogModeOf,
  planChangelog,
  type DeliveryFacts,
} from './artifacts.js';

const facts: DeliveryFacts = {
  playId: 'play-1',
  need: 'Add the export command\nIt writes a CSV.',
  demands: [
    { id: 'd1', title: 'Parse the flags' },
    { id: 'd2', title: 'Write the file' },
  ],
};

const conventional: Pick<ProjectConventions, 'commit'> = {
  commit: { style: 'conventional', defaultType: 'feat' },
};

describe('changelogModeOf', () => {
  it('uses the override of the scenario when it is one of the modes', () => {
    expect(changelogModeOf('always', { 'delivery.changelog': 'never' })).toBe('never');
    expect(changelogModeOf('always', { 'delivery.changelog': 'auto' })).toBe('auto');
  });

  it('keeps the global value for anything else', () => {
    expect(changelogModeOf('auto', undefined)).toBe('auto');
    expect(changelogModeOf('auto', {})).toBe('auto');
    expect(changelogModeOf('auto', { 'delivery.changelog': 'sometimes' })).toBe('auto');
    expect(changelogModeOf('auto', { 'delivery.changelog': 3 })).toBe('auto');
  });
});

describe('buildDeliveryArtifacts', () => {
  it('writes the title as the first line of the need in a repository of free commits', () => {
    const artifacts = buildDeliveryArtifacts(facts, {
      commit: { style: 'free', defaultType: 'feat' },
    });
    expect(artifacts.title).toBe('Add the export command');
    expect(artifacts.mergeMessage.startsWith('Add the export command\n\n')).toBe(true);
    expect(artifacts.changelogMessage).toBe('Add the changelog entry of play play-1');
  });

  it('writes the title as a Conventional Commit in a repository of them', () => {
    const artifacts = buildDeliveryArtifacts(facts, conventional);
    expect(artifacts.title).toBe('feat: Add the export command');
    expect(artifacts.entry).toEqual({
      summary: 'Add the export command',
      details: ['Parse the flags', 'Write the file'],
      type: 'feat',
    });
    expect(artifacts.changelogMessage).toBe('docs(changelog): add the entry of play play-1');
  });

  it('keeps the type a need already has and uses the default type of the project otherwise', () => {
    const typed = buildDeliveryArtifacts(
      { ...facts, need: 'fix(core): stop the crash' },
      conventional,
    );
    expect(typed.title).toBe('fix: stop the crash');
    expect(typed.entry.type).toBe('fix');
    const chore = buildDeliveryArtifacts(facts, {
      commit: { style: 'conventional', defaultType: 'chore' },
    });
    expect(chore.title).toBe('chore: Add the export command');
  });

  it('does not touch the need of a project that has no conventions yet', () => {
    expect(buildDeliveryArtifacts(facts).title).toBe('Add the export command');
  });

  it('cuts a long title to 72 characters, the prefix included', () => {
    const long = buildDeliveryArtifacts({ ...facts, need: 'x'.repeat(200) }, conventional);
    expect(long.title).toHaveLength(72);
    expect(long.title.startsWith('feat: xxx')).toBe(true);
  });

  it('falls back to the id of the play for an empty need', () => {
    expect(buildDeliveryArtifacts({ ...facts, need: '  ' }).title).toBe('Play play-1');
  });

  it('lists the need, the demands and the warnings in the body', () => {
    const { body } = buildDeliveryArtifacts({ ...facts, partial: true, criticWaived: true });
    expect(body).toContain('Delivered by OTheater (play play-1).');
    expect(body).toContain('Only the approved demands are included.');
    expect(body).toContain('The Critic was waived for this play.');
    expect(body).toContain('## Need\n\nAdd the export command\nIt writes a CSV.');
    expect(body).toContain('- `d1`: Parse the flags\n- `d2`: Write the file');
  });

  it('lists the demands in the merge message', () => {
    const { mergeMessage } = buildDeliveryArtifacts(facts);
    expect(mergeMessage).toBe(
      'Add the export command\n\nDemands:\n- Parse the flags (d1)\n- Write the file (d2)\n\nDelivered by OTheater (play play-1).',
    );
  });
});

describe('planChangelog', () => {
  let worktree: string;
  const { entry } = buildDeliveryArtifacts(facts, conventional);
  const detected = (
    format: 'keep-a-changelog' | 'conventional-changelog' | 'other',
    file = 'CHANGELOG.md',
  ): Pick<ProjectConventions, 'source' | 'changelog'> => ({
    source: 'detected',
    changelog: { format, file },
  });

  beforeEach(async () => {
    worktree = await realpath(await mkdtemp(join(tmpdir(), 'otheater-changelog-')));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it('never touches the changelog in `never`', async () => {
    await writeFile(join(worktree, 'CHANGELOG.md'), '# Changelog\n');
    expect(await planChangelog({ mode: 'never', worktree, entry })).toBeUndefined();
  });

  it('creates CHANGELOG.md in Keep a Changelog format when there is none, in `always`', async () => {
    const change = await planChangelog({
      mode: 'always',
      worktree,
      entry,
      conventions: { source: 'detected', changelog: { format: 'none' } },
    });
    expect(change).toMatchObject({
      file: 'CHANGELOG.md',
      format: 'keep-a-changelog',
      created: true,
    });
    expect(change?.content).toContain('## [Unreleased]\n\n### Added\n\n- Add the export command');
  });

  it('leaves a repository without a changelog alone in `auto`, but not a project of the profile', async () => {
    const conventions = { source: 'detected', changelog: { format: 'none' } } as const;
    expect(await planChangelog({ mode: 'auto', worktree, entry, conventions })).toBeUndefined();
    expect(
      await planChangelog({
        mode: 'auto',
        worktree,
        entry,
        conventions: profileConventions('main'),
      }),
    ).toMatchObject({ created: true });
  });

  it('keeps the format the file has: the entry goes in it, not in Keep a Changelog', async () => {
    const text = '# Changelog\n\n## 1.1.0\n\n### Features\n\n* a feature\n';
    await writeFile(join(worktree, 'CHANGELOG.md'), text);
    const change = await planChangelog({
      mode: 'always',
      worktree,
      entry,
      conventions: detected('conventional-changelog'),
    });
    expect(change).toMatchObject({ file: 'CHANGELOG.md', created: false });
    expect(change?.content).toContain('## Unreleased\n\n### Features\n\n* Add the export command');
  });

  it('uses the format of the file when the conventions do not say, in whatever file it is', async () => {
    await writeFile(join(worktree, 'History.md'), '# History\n\n- old thing\n');
    const change = await planChangelog({ mode: 'auto', worktree, entry });
    expect(change?.file).toBe('History.md');
    expect(change?.format).toBe('other');
    expect(change?.content).toBe(
      '# History\n\n- Add the export command\n  - Parse the flags\n  - Write the file\n- old thing\n',
    );
  });

  it('does not trust a confirmed file name that is not the one found', async () => {
    await writeFile(join(worktree, 'CHANGELOG.md'), '# Changes\n\n- old thing\n');
    const change = await planChangelog({
      mode: 'always',
      worktree,
      entry,
      conventions: detected('keep-a-changelog', 'docs/CHANGES.md'),
    });
    expect(change?.format).toBe('other');
  });

  it('plans nothing when the entry is already in the file', async () => {
    const first = await planChangelog({ mode: 'always', worktree, entry });
    await writeFile(join(worktree, 'CHANGELOG.md'), first?.content ?? '');
    expect(await planChangelog({ mode: 'always', worktree, entry })).toBeUndefined();
    expect(await readFile(join(worktree, 'CHANGELOG.md'), 'utf8')).toBe(first?.content);
  });
});
