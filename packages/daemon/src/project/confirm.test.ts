// SPDX-License-Identifier: MPL-2.0
import {
  askProducerInput,
  conventionsToJson,
  parseConventions,
  type ProjectConventions,
} from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { QuestionBoard } from '../orchestration/handlers.js';
import { captureLogger } from '../test-helpers.js';
import {
  applyConventionAnswers,
  conventionQuestions,
  ConventionConfirmer,
  describeConventions,
} from './confirm.js';

const detected: ProjectConventions = {
  version: 1,
  source: 'detected',
  confirmed: false,
  mainBranch: 'trunk',
  changelog: { format: 'conventional-changelog', file: 'HISTORY.md' },
  commit: { style: 'conventional', defaultType: 'feat' },
  ci: 'github-actions',
  commands: { test: 'pnpm test', install: 'pnpm install' },
};

describe('conventionQuestions', () => {
  it('are valid questions for the Producer, with what was detected as the recommendation', () => {
    const questions = conventionQuestions(detected);
    expect(askProducerInput.safeParse({ questions }).success).toBe(true);
    expect(questions).toHaveLength(4);
    expect(questions[0]?.recommended).toBe('conventional-changelog');
    expect(questions[1]?.recommended).toBe('Conventional Commits');
    expect(questions[2]?.recommended).toBe('Use the detected command');
    expect(questions[0]?.question).toContain('main branch trunk');
    expect(questions[0]?.question).toContain('CI github-actions');
    expect(questions[0]?.question).toContain('install pnpm install');
  });

  it('ask the commands as open questions when none was detected', () => {
    const questions = conventionQuestions({ ...detected, commands: {} });
    expect(askProducerInput.safeParse({ questions }).success).toBe(true);
    expect(questions[2]).toMatchObject({ open: true });
    expect(questions[2]?.options).toBeUndefined();
  });

  it('stay inside the size of a question however long the detection is', () => {
    const long = { ...detected, commands: { test: 'x'.repeat(900), install: 'y'.repeat(900) } };
    expect(describeConventions(long).length).toBeLessThan(500);
    expect(askProducerInput.safeParse({ questions: conventionQuestions(long) }).success).toBe(true);
  });
});

describe('applyConventionAnswers', () => {
  it('keeps what was detected when the Producer confirms it', () => {
    const answers = [
      'conventional-changelog',
      'Conventional Commits',
      'Use the detected command',
      'Use the detected command',
    ];
    expect(applyConventionAnswers(detected, answers)).toEqual({
      ...detected,
      source: 'producer',
      confirmed: true,
    });
  });

  it('takes the correction of each answer: by label, by position or by value, in any case', () => {
    const corrected = applyConventionAnswers(detected, [
      'KEEP A CHANGELOG',
      '2',
      'make check',
      'No command',
    ]);
    expect(corrected.changelog).toEqual({ format: 'keep-a-changelog', file: 'HISTORY.md' });
    expect(corrected.commit.style).toBe('free');
    expect(corrected.commands).toEqual({ test: 'make check' });
    expect(corrected.source).toBe('producer');
    expect(corrected.confirmed).toBe(true);
    expect(parseConventions(conventionsToJson(corrected))).toEqual(corrected);
  });

  it('leaves what it does not understand or was not answered as it was detected', () => {
    const corrected = applyConventionAnswers(detected, ['dunno', '']);
    expect(corrected.changelog.format).toBe('conventional-changelog');
    expect(corrected.commit.style).toBe('conventional');
    expect(corrected.commands).toEqual(detected.commands);
  });

  it('forgets the file when the Producer says there is no changelog', () => {
    const corrected = applyConventionAnswers(detected, ['No changelog']);
    expect(corrected.changelog).toEqual({ format: 'none' });
  });
});

describe('ConventionConfirmer', () => {
  let store: InMemoryStore;
  let board: QuestionBoard;
  let confirmer: ConventionConfirmer;

  beforeEach(async () => {
    store = new InMemoryStore({ clock: new FakeClock() });
    board = new QuestionBoard();
    confirmer = new ConventionConfirmer({
      store,
      board,
      logger: captureLogger().logger,
    });
    await store.scenarios.create({
      id: 's1',
      kind: 'project',
      flowId: 'play',
      name: 'app',
      folder: '/work/app',
      profile: 'software',
      baseBranch: 'trunk',
      conventions: conventionsToJson(detected),
    });
  });

  it('opens one question that the channel shows, and saves the answer as confirmed', async () => {
    expect(await confirmer.ask('s1')).toBe(true);
    const [decision] = await store.decisions.list({ scenarioId: 's1', states: ['pending'] });
    expect(decision?.kind).toBe('producer_question');
    expect(board.has(decision?.id ?? '')).toBe(true);
    // Asking again while it is open opens nothing.
    expect(await confirmer.ask('s1')).toBe(false);

    board.resolve(decision?.id ?? '', {
      answers: ['Keep a Changelog', 'Free text', 'Use the detected command', 'No command'],
    });
    await confirmer.settled('s1');
    const saved = parseConventions((await store.scenarios.get('s1'))?.conventions);
    expect(saved).toMatchObject({
      source: 'producer',
      confirmed: true,
      changelog: { format: 'keep-a-changelog', file: 'HISTORY.md' },
      commit: { style: 'free' },
      commands: { test: 'pnpm test' },
    });
    // Confirmed: it is not asked again.
    expect(await confirmer.ask('s1')).toBe(false);
  });

  it('asks again after a restart, and does not leave the old question open', async () => {
    await confirmer.ask('s1');
    const [first] = await store.decisions.list({ scenarioId: 's1', states: ['pending'] });
    // The daemon stops: nobody waits for the answer any more.
    board.abortAll('The daemon is stopping.');
    await confirmer.settled('s1');
    expect((await store.decisions.get(first?.id ?? ''))?.state).toBe('cancelled');
    expect(parseConventions((await store.scenarios.get('s1'))?.conventions)?.confirmed).toBe(false);

    expect(await confirmer.ask('s1')).toBe(true);
    const pending = await store.decisions.list({ scenarioId: 's1', states: ['pending'] });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).not.toBe(first?.id);
  });

  it('scenario.notice conventions_not_confirmed: a question that could not be answered is an event, an answered one is not (P24, N146)', async () => {
    const notices = async () =>
      (await store.events.readFrom(0, 1000)).filter((event) => event.type === 'scenario.notice');
    await confirmer.ask('s1');
    board.abortAll('The daemon is stopping.');
    await confirmer.settled('s1');
    expect((await notices()).map((event) => event.payload)).toEqual([
      {
        scenarioId: 's1',
        kind: 'conventions_not_confirmed',
        subject: null,
        detail: 'The daemon is stopping.',
      },
    ]);
    expect((await notices())[0]?.scenarioId).toBe('s1');

    // An answered question writes nothing more.
    await confirmer.ask('s1');
    const [decision] = await store.decisions.list({ scenarioId: 's1', states: ['pending'] });
    board.resolve(decision?.id ?? '', { answers: [] });
    await confirmer.settled('s1');
    expect(await notices()).toHaveLength(1);
  });

  it('asks nothing for a scenario without conventions', async () => {
    await store.scenarios.update('s1', { conventions: null });
    expect(await confirmer.ask('s1')).toBe(false);
    expect(await confirmer.ask('nope')).toBe(false);
  });
});
