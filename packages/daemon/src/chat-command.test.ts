// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { ScenarioSystemMessagePayload } from '@otheater/protocol';
import { renderSystemMessage } from './chat-command.js';
import { createTranslator } from './i18n.js';

/** The system message of the reconciliation, in the language of the Producer (5.22). */

const FULL: ScenarioSystemMessagePayload = {
  scenarioId: 's1',
  kind: 'recovery',
  resumed: [
    { kind: 'play', id: 'p1' },
    { kind: 'attempt', id: 'p1:d1:1' },
  ],
  settled: [
    { effectType: 'open_pr', playId: 'p1', outcome: 'done' },
    { effectType: 'merge_branch', playId: 'p1', outcome: 'not_done' },
  ],
  waiting: [
    { kind: 'effect', id: 'k', playId: 'p2', effectType: 'open_pr' },
    { kind: 'play', id: 'p3', playId: 'p3', effectType: null },
  ],
};

describe('renderSystemMessage', () => {
  it('says what was resumed, settled and what waits, in English', async () => {
    const t = await createTranslator('en');
    expect(renderSystemMessage(t, FULL)).toEqual([
      'System: the daemon restarted and reconciled this scenario.',
      '  Resumed: play p1; attempt p1:d1:1.',
      '  Settled by the effect verifier: open_pr of play p1 (done); merge_branch of play p1 (not done).',
      '  Waiting for you: open_pr of play p2 (nobody could check it); play p3 (it could not be restored).',
    ]);
  });

  it('says it in Brazilian Portuguese', async () => {
    const t = await createTranslator('pt-BR');
    expect(renderSystemMessage(t, FULL)).toEqual([
      'Sistema: o daemon reiniciou e reconciliou este cenário.',
      '  Retomado: peça p1; tentativa p1:d1:1.',
      '  Resolvido pelo verificador de efeitos: open_pr da peça p1 (feito); merge_branch da peça p1 (não feito).',
      '  Esperando por você: open_pr da peça p2 (ninguém conseguiu verificar); peça p3 (não pôde ser restaurada).',
    ]);
  });

  it('leaves out the line of a part with nothing in it', async () => {
    const t = await createTranslator('en');
    const lines = renderSystemMessage(t, {
      scenarioId: 's1',
      kind: 'recovery',
      resumed: [{ kind: 'play', id: 'p1' }],
      settled: [],
      waiting: [],
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('  Resumed: play p1.');
  });
});

describe('renderSystemMessage, the handoff', () => {
  const HANDOFF: ScenarioSystemMessagePayload = {
    scenarioId: 's1',
    kind: 'handoff',
    playId: 'p1',
    attemptId: 'p1/d1/1',
    role: 'actor',
    cause: 'quota_exhausted',
    fromExecutor: 'opus@claude-code/a',
    toExecutor: 'gpt@codex/b',
  };

  it('says who passed the baton to whom, in English', async () => {
    const t = await createTranslator('en');
    expect(renderSystemMessage(t, HANDOFF)).toEqual([
      'System: attempt p1/d1/1 passed the baton from opus@claude-code/a to gpt@codex/b (quota_exhausted); the work goes on from the saved state.',
    ]);
  });

  it('says it in Brazilian Portuguese', async () => {
    const t = await createTranslator('pt-BR');
    expect(renderSystemMessage(t, HANDOFF)).toEqual([
      'Sistema: a tentativa p1/d1/1 passou o bastão de opus@claude-code/a para gpt@codex/b (quota_exhausted); o trabalho continua do estado guardado.',
    ]);
  });
});
