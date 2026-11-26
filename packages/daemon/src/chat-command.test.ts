// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { ScenarioSystemMessagePayload, ShellCommandFinishedPayload } from '@otheater/protocol';
import {
  renderGeneratedReply,
  renderShellFinished,
  renderShellStarted,
  renderSystemMessage,
} from './chat-command.js';
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

describe('renderSystemMessage, the wait for the reset (P19)', () => {
  const WAIT: ScenarioSystemMessagePayload = {
    scenarioId: 's1',
    kind: 'reset_wait',
    playId: 'p1',
    attemptId: 'p1/d1/1',
    role: 'actor',
    cause: 'quota_exhausted',
    executor: 'opus@claude-code/a',
    resetsAt: Date.UTC(2026, 10, 18, 15, 30),
  };

  it('says what is waited for, until when, in English', async () => {
    const t = await createTranslator('en');
    const [line] = renderSystemMessage(t, WAIT);
    expect(line).toContain('attempt p1/d1/1 waits for');
    expect(line).toContain('opus@claude-code/a');
    expect(line).toContain('2026-11-18T15:30:00.000Z');
  });

  it('says it in Brazilian Portuguese, and without a date when none is known', async () => {
    const t = await createTranslator('pt-BR');
    const [dated] = renderSystemMessage(t, WAIT);
    expect(dated).toContain('a tentativa p1/d1/1 espera');
    const [capped] = renderSystemMessage(t, { ...WAIT, cause: 'spend_cap', resetsAt: null });
    expect(capped).toContain('a tentativa p1/d1/1 espera');
    expect(capped).not.toContain('até');
    expect(capped).not.toBe(dated);
  });
});

describe('renderSystemMessage, the wait of the strict cross-review (N135)', () => {
  const WAIT: ScenarioSystemMessagePayload = {
    scenarioId: 's1',
    kind: 'selection_wait',
    role: 'reviewer',
    playId: 'p1',
    demandId: 'd1',
    crossCheck: 'require_other_provider',
    workedProvider: 'anthropic',
    on: [{ executor: 'gpt@codex/b', profile: 'codex/b', reason: 'quota' }],
    until: null,
  };

  it('says what the role waits on, in English', async () => {
    const t = await createTranslator('en');
    const [line] = renderSystemMessage(t, WAIT);
    expect(line).toContain('the reviewer waits');
    expect(line).toContain('same provider');
    expect(line).toContain('gpt@codex/b (quota)');
  });

  it('says it in Brazilian Portuguese and names the model for other_model', async () => {
    const t = await createTranslator('pt-BR');
    const lines = renderSystemMessage(t, { ...WAIT, crossCheck: 'other_model', on: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Sistema:');
    expect(lines[0]).toContain('reviewer');
  });
});

describe('renderSystemMessage, the failover of the Director (P20)', () => {
  const FAILOVER: ScenarioSystemMessagePayload = {
    scenarioId: 's1',
    kind: 'director_failover',
    outcome: 'switched',
    cause: 'quota_exhausted',
    fromExecutor: 'fake-model@fake/one',
    toExecutor: 'fake-model@fake/two',
    requeued: 'q1',
    resetsAt: null,
    detail: null,
  };

  it('says which Executor took over and why, in English', async () => {
    const t = await createTranslator('en');
    const [line] = renderSystemMessage(t, FAILOVER);
    expect(line).toContain('fake-model@fake/one');
    expect(line).toContain('fake-model@fake/two');
    expect(line).toContain('quota exhausted');
  });

  it('says a refusal of the security policy in words, not as a code (N334)', async () => {
    const en = renderSystemMessage(await createTranslator('en'), {
      ...FAILOVER,
      outcome: 'unavailable',
      cause: 'permission',
      fromExecutor: null,
      toExecutor: null,
    });
    expect(en[0]).toContain('refused by the security policy');
    expect(en[0]).not.toContain('permission');
    const pt = renderSystemMessage(await createTranslator('pt-BR'), {
      ...FAILOVER,
      outcome: 'unavailable',
      cause: 'permission',
      fromExecutor: null,
      toExecutor: null,
    });
    expect(pt[0]).toContain('recusado pela política de segurança');
  });

  it('says it waits, with the end of the limit, in Brazilian Portuguese', async () => {
    const t = await createTranslator('pt-BR');
    const lines = renderSystemMessage(t, {
      ...FAILOVER,
      outcome: 'waiting',
      toExecutor: null,
      resetsAt: Date.UTC(2026, 10, 18, 12),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Sistema:');
    expect(lines[0]).toContain('2026-11-18T12:00:00.000Z');
  });

  it('says nobody can take it over', async () => {
    const t = await createTranslator('en');
    const [line] = renderSystemMessage(t, {
      ...FAILOVER,
      outcome: 'unavailable',
      toExecutor: null,
    });
    expect(line).toContain('no other Executor');
  });
});

describe('renderGeneratedReply (N183)', () => {
  const TOOLS = [
    { name: 'open_play', status: 'completed' as const },
    { name: 'ask_producer', status: 'failed' as const },
  ];

  it('names the tools and the play, in English', async () => {
    const t = await createTranslator('en');
    expect(renderGeneratedReply(t, TOOLS, 'play-1')).toBe(
      'System: the Director ended the turn without a reply. Tools called: open_play, ask_producer (failed). Play opened: play-1.',
    );
  });

  it('says it in Brazilian Portuguese, with and without a play', async () => {
    const t = await createTranslator('pt-BR');
    expect(renderGeneratedReply(t, TOOLS, 'play-1')).toBe(
      'Sistema: o Diretor terminou o turno sem responder. Ferramentas chamadas: open_play, ask_producer (falhou). Peça aberta: play-1.',
    );
    expect(renderGeneratedReply(t, TOOLS.slice(0, 1), undefined)).toBe(
      'Sistema: o Diretor terminou o turno sem responder. Ferramentas chamadas: open_play.',
    );
  });

  it('says there was no tool at all', async () => {
    const t = await createTranslator('pt-BR');
    expect(renderGeneratedReply(t, [], undefined)).toBe(
      'Sistema: o Diretor terminou o turno sem responder.',
    );
  });
});

describe('renderShellFinished, the ! command (N43, N187)', () => {
  const RESULT: ShellCommandFinishedPayload = {
    commandId: 'sh_1',
    outcome: 'exited',
    exitCode: 2,
    durationMs: 1500,
    totalLines: 300,
    shownLines: 3,
    keep: 'tail',
    logTruncated: false,
    attachmentId: 'A1',
    askedInput: false,
    context: 'sent',
    logPath: '/tmp/x.log',
  };

  it('says how it ended, shows the snippet and what was left out, in English', async () => {
    const t = await createTranslator('en');
    expect(renderShellFinished(t, RESULT, '298\n299\n300')).toEqual([
      'Command ended with exit code 2.',
      '  298',
      '  299',
      '  300',
      '  ... only the last 3 of 300 lines are shown; the whole output is in the log.',
    ]);
  });

  it('says it in Brazilian Portuguese, for a timeout and for a command that asked for input', async () => {
    const t = await createTranslator('pt-BR');
    expect(
      renderShellFinished(
        t,
        { ...RESULT, outcome: 'timeout', exitCode: null, totalLines: 1, shownLines: 1 },
        'x',
      ),
    ).toEqual([
      'O comando foi interrompido após 1.5 s (limite de tempo); os processos dele foram encerrados.',
      '  x',
    ]);
    const asked = renderShellFinished(
      t,
      { ...RESULT, totalLines: 1, shownLines: 1, askedInput: true, context: 'asked' },
      'Continue? ',
    );
    expect(asked.at(-2)).toContain('pediu entrada');
    expect(asked.at(-1)).toContain('pergunta espera');
  });

  it('says a command that did not run, and the line that began it', async () => {
    const t = await createTranslator('en');
    expect(
      renderShellFinished(
        t,
        {
          ...RESULT,
          outcome: 'failed',
          exitCode: null,
          totalLines: 0,
          shownLines: 0,
          attachmentId: null,
          context: 'none',
          error: 'no shell',
        },
        '',
      ),
    ).toEqual(['Command did not run: no shell']);
    expect(renderShellStarted(t, { commandId: 'sh_1', command: 'ls -la', place: 'sandbox' })).toBe(
      '$ ls -la (sandbox)',
    );
  });
});
