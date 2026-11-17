// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  parseIdeaCommand,
  renderIdeaGroup,
  renderIdeaResult,
  renderQueueHeld,
} from './chat-command.js';
import { createTranslator } from './i18n.js';
import type { IdeaView, PendingAsk } from './orchestration/channel.js';

/** The command `/idea` of `ot chat` (5.20): how it reads the line and what it prints. */

describe('parseIdeaCommand', () => {
  it('takes a free text as an idea, with an optional --area', () => {
    expect(parseIdeaCommand('/idea add a retry to the client')).toEqual({
      action: 'add',
      text: 'a retry to the client',
    });
    expect(parseIdeaCommand('/idea retry the call')).toEqual({
      action: 'add',
      text: 'retry the call',
    });
    expect(parseIdeaCommand('/idea --area api speed up the route')).toEqual({
      action: 'add',
      text: 'speed up the route',
      area: 'api',
    });
    expect(parseIdeaCommand('/idea add --area=ui a new button')).toEqual({
      action: 'add',
      text: 'a new button',
      area: 'ui',
    });
  });

  it('reads list and drain only when they are alone; with more words they start an idea', () => {
    expect(parseIdeaCommand('/idea list')).toEqual({ action: 'list' });
    expect(parseIdeaCommand('/idea drain')).toEqual({ action: 'drain' });
    expect(parseIdeaCommand('/idea list the plays in the TUI')).toEqual({
      action: 'add',
      text: 'list the plays in the TUI',
    });
  });

  it('reads discard and defer with the id and a reason, and requeue with the id', () => {
    expect(parseIdeaCommand('/idea discard I3 it is a duplicate of I1')).toEqual({
      action: 'discard',
      id: 'I3',
      reason: 'it is a duplicate of I1',
    });
    expect(parseIdeaCommand('/idea defer I2 after the release')).toEqual({
      action: 'defer',
      id: 'I2',
      reason: 'after the release',
    });
    expect(parseIdeaCommand('/idea requeue I2')).toEqual({ action: 'requeue', id: 'I2' });
  });

  it('refuses the lines that say nothing', () => {
    expect(parseIdeaCommand('/idea')).toBeUndefined();
    expect(parseIdeaCommand('/idea add')).toBeUndefined();
    expect(parseIdeaCommand('/idea --area api')).toBeUndefined();
    expect(parseIdeaCommand('/idea discard I3')).toBeUndefined();
    expect(parseIdeaCommand('/idea requeue')).toBeUndefined();
    expect(parseIdeaCommand('/idea requeue I1 I2')).toBeUndefined();
  });
});

const DONE: IdeaView = {
  id: 'I1',
  state: 'done',
  text: 'add the route',
  area: 'api',
  groupId: 'g1',
  playId: 'play-1',
  prNumber: 7,
  prUrl: 'https://example.test/pr/7',
  reason: null,
};
const DEFERRED: IdeaView = {
  id: 'I2',
  state: 'deferred',
  text: 'rewrite it all',
  area: null,
  groupId: null,
  playId: null,
  prNumber: null,
  prUrl: null,
  reason: 'after the release',
};

describe('renderIdeaResult', () => {
  it('lists the ideas with the play and the PR they ended in, and the reason of a deferred one', async () => {
    const t = await createTranslator('en');
    const lines = renderIdeaResult(t, { action: 'list' }, { ideas: [DONE, DEFERRED] });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('I1');
    expect(lines[0]).toContain('add the route');
    expect(lines[0]).toContain('play-1');
    expect(lines[0]).toContain('PR #7');
    expect(lines[1]).toContain('after the release');
  });

  it('says what a drain did and why it stopped, in both languages', async () => {
    for (const language of ['en', 'pt-BR'] as const) {
      const t = await createTranslator(language);
      const lines = renderIdeaResult(
        t,
        { action: 'drain' },
        { ideas: [], drain: { groups: 2, stopped: 'a reason' } },
      );
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('2');
      expect(lines[1]).toContain('a reason');
    }
  });
});

describe('renderIdeaGroup', () => {
  const ask: PendingAsk = {
    id: 's:ideas:g1',
    kind: 'ideas.group',
    input: {
      groupId: 'g1',
      need: 'Do the route and its test',
      rationale: 'same area',
      ideas: [
        { id: 'I1', text: 'add the route' },
        { id: 'I3', text: 'test the route' },
      ],
      leftOut: [{ ideaId: 'I2', reason: 'another area', question: 'Which button?' }],
    },
  } as unknown as PendingAsk;

  it('shows the need, each idea of the group, what was left out and how to answer', async () => {
    const t = await createTranslator('en');
    const lines = renderIdeaGroup(t, ask);
    expect(lines[0]).toContain('Do the route and its test');
    expect(lines[0]).toContain('same area');
    expect(lines.some((line) => line.includes('I1') && line.includes('add the route'))).toBe(true);
    expect(lines.some((line) => line.includes('I3') && line.includes('test the route'))).toBe(true);
    expect(lines.some((line) => line.includes('I2') && line.includes('Which button?'))).toBe(true);
    expect(lines).toHaveLength(1 + 2 + 1 + 1);
    expect(lines.at(-1)).toContain('approve');
  });

  it('says it in Brazilian Portuguese', async () => {
    const t = await createTranslator('pt-BR');
    const lines = renderIdeaGroup(t, ask);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('Do the route and its test');
  });
});

describe('renderQueueHeld', () => {
  const CAUSES = [
    'author_failed',
    'author_left_all_out',
    'group_refused',
    'play_not_opened',
    'play_ended',
  ] as const;

  it('says why the queue stopped and what frees it, for every cause, in both languages', async () => {
    for (const language of ['en', 'pt-BR'] as const) {
      const t = await createTranslator(language);
      for (const cause of CAUSES) {
        const lines = renderQueueHeld(t, {
          scenarioId: 's1',
          cause,
          reason: 'the reason given',
          playId: cause === 'play_ended' ? 'play-9' : null,
        });
        const text = lines.join('\n');
        expect(lines).toHaveLength(2);
        expect(text).toContain('the reason given');
        expect(text).toContain('/idea drain');
        expect(text).toContain('/idea requeue');
        expect(text).not.toContain('ideaHeld');
        expect(text.includes('play-9')).toBe(cause === 'play_ended');
      }
    }
  });
});
