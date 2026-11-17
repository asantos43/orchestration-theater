// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConventions } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayFakes,
  type PlayHarness,
  type PlayHarnessOptions,
} from './e2e-fixture.js';

/**
 * The `software` profile (P7) end to end, with the fake agent in every role: an imported
 * repository keeps its own changelog format and commit pattern, one without a changelog gets
 * `CHANGELOG.md` at its first delivery, and a new project is born with the structure and the CI of
 * the profile. The client is the compiled `dist/cli.js` of the fake agent, so `pnpm build` comes
 * first.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

function fakes(): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

function withPlayDaemon(
  options: PlayHarnessOptions,
  body: (harness: PlayHarness) => Promise<void>,
): Promise<void> {
  return withDaemon(fakes(), options, body);
}

/** Opens the play of the Producer's message and waits for it to be delivered. */
async function deliver(harness: PlayHarness): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, '#ot-play write alpha and beta #outcome:approved');
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  await waitFor(
    'DONE',
    async () => (await harness.daemon.store.plays.get(play.id))?.state === 'DONE',
  );
  return play.id;
}

function headOf(harness: PlayHarness, playId: string): string {
  const pull = harness.codeHost.pullRequests()[0];
  if (pull === undefined) throw new Error(`play ${playId} opened no pull request`);
  return pull.headBranch;
}

/** Runs git on what the play delivered, as the repository has it (`<branch>` is the head of the PR). */
function delivered(harness: PlayHarness, playId: string, ...args: string[]): Promise<string> {
  return testGit(
    harness.rig.repo,
    ...args.map((arg) => arg.replace('<branch>', headOf(harness, playId))),
  );
}

const CONVENTIONAL_CHANGELOG = [
  '# Changelog',
  '',
  'All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.',
  '',
  '## [1.1.0](https://example.test/compare/v1.0.0...v1.1.0) (2026-02-01)',
  '',
  '### Features',
  '',
  '* a feature from before',
  '',
].join('\n');

/** The repository of the fixture, as a project that keeps a changelog and Conventional Commits. */
async function makeItConventional(repo: string): Promise<void> {
  await writeFile(join(repo, 'CHANGELOG.md'), CONVENTIONAL_CHANGELOG);
  await testGit(repo, 'add', '-A');
  await testGit(repo, 'commit', '--quiet', '-m', 'feat: a feature from before');
  await writeFile(join(repo, 'notes.txt'), 'x\n');
  await testGit(repo, 'add', '-A');
  await testGit(repo, 'commit', '--quiet', '-m', 'fix: a fix from before');
  await testGit(repo, 'push', '--quiet', 'origin', 'main');
}

describe('the software profile with the fake agent (P7)', { timeout: 120_000 }, () => {
  it('keeps the changelog format and the commit pattern of an imported repository', async () => {
    await withPlayDaemon({}, async (harness) => {
      await makeItConventional(harness.rig.repo);
      const playId = await deliver(harness);

      const scenario = (await harness.daemon.store.scenarios.list())[0];
      expect(parseConventions(scenario?.conventions)).toMatchObject({
        source: 'detected',
        changelog: { format: 'conventional-changelog', file: 'CHANGELOG.md' },
        commit: { style: 'conventional' },
      });

      const [pull] = harness.codeHost.pullRequests();
      expect(pull?.title).toMatch(/^feat: /);

      const changelog = await delivered(harness, playId, 'show', '<branch>:CHANGELOG.md');
      // The entry is in the format of the file: its own sections and bullets, above the old release.
      expect(changelog).toContain('## Unreleased');
      expect(changelog).toContain('### Features');
      expect(changelog).toMatch(/^\* write alpha and beta/m);
      expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.1.0]'));
      expect(changelog).toContain('* a feature from before');
      expect(changelog).not.toContain('keepachangelog');

      const subjects = (await delivered(harness, playId, 'log', '--format=%s', '<branch>'))
        .trim()
        .split('\n');
      expect(subjects).toContain(`docs(changelog): add the entry of play ${playId}`);
    });
  });

  it('creates CHANGELOG.md at the first delivery of an imported repository that has none', async () => {
    await withPlayDaemon({}, async (harness) => {
      const playId = await deliver(harness);

      const changelog = await delivered(harness, playId, 'show', '<branch>:CHANGELOG.md');
      expect(changelog).toContain('# Changelog');
      expect(changelog).toContain('keepachangelog.com');
      expect(changelog).toContain('## [Unreleased]');
      expect(changelog).toContain('write alpha and beta');
      const subjects = (await delivered(harness, playId, 'log', '--format=%s', '<branch>'))
        .trim()
        .split('\n');
      expect(subjects).toContain(`Add the changelog entry of play ${playId}`);
      // The repository has no Conventional Commits, so the title is the plain first line.
      expect(harness.codeHost.pullRequests()[0]?.title).not.toMatch(/^[a-z]+: /);
    });
  });

  it('touches no changelog with delivery.changelog never', async () => {
    await withPlayDaemon({ extra: 'delivery:\n  changelog: never' }, async (harness) => {
      const playId = await deliver(harness);
      await expect(delivered(harness, playId, 'show', '<branch>:CHANGELOG.md')).rejects.toThrow();
    });
  });

  it('asks the Producer to confirm the detection, and saves the answer as confirmed', async () => {
    await withPlayDaemon({ conventions: 'ask' }, async (harness) => {
      const { scenarioId } = await harness.producer.openChat({ repo: harness.rig.repo });
      const ask = await waitFor('the question', async () =>
        (await harness.producer.poll(scenarioId, 0)).asks.find(
          (item) => item.kind === 'producer_question',
        ),
      );
      expect(JSON.stringify(ask.input)).toContain('Which changelog format');

      await harness.producer.answer(ask.id, {
        answers: ['No changelog', 'Free text', 'make check', 'No command'],
      });
      const saved = await waitFor('the confirmed conventions', async () => {
        const conventions = parseConventions(
          (await harness.daemon.store.scenarios.get(scenarioId))?.conventions,
        );
        return conventions?.confirmed === true ? conventions : undefined;
      });
      expect(saved).toMatchObject({
        source: 'producer',
        changelog: { format: 'none' },
        commit: { style: 'free' },
        commands: { test: 'make check' },
      });
      // Confirmed once: opening the chat again asks nothing.
      await harness.producer.openChat({ repo: harness.rig.repo });
      expect(
        (await harness.producer.poll(scenarioId, 0)).asks.filter(
          (item) => item.kind === 'producer_question',
        ),
      ).toEqual([]);
    });
  });

  it('is born with the structure and the CI of the profile when the project is new', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'otheater-new-project-')));
    try {
      await withPlayDaemon({}, async (harness) => {
        const repo = join(parent, 'fresh');
        const { scenarioId } = await harness.producer.openChat({ repo, newProject: true });
        for (const file of [
          'README.md',
          'CHANGELOG.md',
          'scripts/test.sh',
          '.github/workflows/ci.yml',
        ]) {
          expect((await stat(join(repo, file))).isFile()).toBe(true);
        }
        expect(await readFile(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain(
          'scripts/test.sh',
        );
        expect((await testGit(repo, 'status', '--porcelain')).trim()).toBe('');
        const scenario = await harness.daemon.store.scenarios.get(scenarioId);
        expect(scenario).toMatchObject({ folder: repo, baseBranch: 'main', profile: 'software' });
        expect(parseConventions(scenario?.conventions)).toMatchObject({
          source: 'profile',
          ci: 'github-actions',
          changelog: { format: 'keep-a-changelog' },
        });
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
