// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  directorHangs,
  directorQuotaFailure,
  playRolePlay,
  type RolePlayHost,
} from './role-play.js';
import { parseScriptSpec } from './scripts.js';

interface Call {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

let sandbox: string;
const previous = process.env.FAKE_AGENT_STATE_DIR;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'fake-agent-role-play-'));
  process.env.FAKE_AGENT_STATE_DIR = join(sandbox, 'state');
});

afterEach(async () => {
  if (previous === undefined) delete process.env.FAKE_AGENT_STATE_DIR;
  else process.env.FAKE_AGENT_STATE_DIR = previous;
  await rm(sandbox, { recursive: true, force: true });
});

/** A host that records the tool calls and answers them with `replies`. */
function host(
  text: string,
  replies: Record<string, unknown> = {},
  signal: AbortSignal = new AbortController().signal,
): { host: RolePlayHost; calls: Call[]; said: string[]; exhausted: (string | undefined)[] } {
  const calls: Call[] = [];
  const said: string[] = [];
  const exhausted: (string | undefined)[] = [];
  return {
    calls,
    said,
    exhausted,
    host: {
      text,
      cwd: sandbox,
      signal,
      exhaust: (resetsAt) => {
        exhausted.push(resetsAt);
        return Promise.reject(new Error('quota exhausted'));
      },
      say: (line) => {
        said.push(line);
        return Promise.resolve();
      },
      call: (tool, args) => {
        calls.push({ tool, args });
        const structured = replies[tool] ?? { ok: true };
        return Promise.resolve({ isError: false, text: JSON.stringify(structured), structured });
      },
    },
  };
}

function stagePrompt(stage: string, need = 'build it', extra = ''): string {
  return `prefix of the role\n#ot-stage: ${stage}\n#ot-play: play-1\n#ot-role: x\n\n## Need\n\n${need}\n${extra}`;
}

describe('the role-play script', () => {
  it('is a script the fake agent can parse', () => {
    expect(parseScriptSpec('role-play').name).toBe('role-play');
  });

  it('plays the Actor: writes the file of the demand and submits the result', async () => {
    const run = host(`${stagePrompt('EXECUTING')}\n#ot-demand: alpha\n#ot-attempt: 1\n`);
    await playRolePlay(run.host);
    expect(await readFile(join(sandbox, 'alpha.txt'), 'utf8')).toContain('alpha');
    expect(run.calls.map((call) => call.tool)).toEqual(['submit']);
  });

  it('plays the stages with the tool of each one', async () => {
    const tools: Record<string, string> = {
      PLANNING: 'submit_plan',
      REVIEWING_PLAN: 'submit_plan_review',
      SCRIPTING: 'submit_script',
      REVIEWING_SCRIPT: 'submit_script_review',
      CRITIQUING: 'submit_critique',
    };
    for (const [stage, tool] of Object.entries(tools)) {
      const run = host(stagePrompt(stage));
      await playRolePlay(run.host);
      expect(run.calls.map((call) => call.tool)).toEqual([tool]);
    }
  });

  it('writes a script of two demands, the second after the first, that fails its check when exhausted', async () => {
    const ok = host(stagePrompt('SCRIPTING'));
    await playRolePlay(ok.host);
    const script = ok.calls[0]?.args.script as {
      demands: { id: string; dependsOn: string[]; verify: { args: string[] }[] }[];
    };
    expect(script.demands.map((demand) => [demand.id, demand.dependsOn])).toEqual([
      ['alpha', []],
      ['beta', ['alpha']],
    ]);
    expect(script.demands[0]?.verify[0]?.args).toEqual(['-e', 'process.exit(0)']);
    const bad = host(stagePrompt('SCRIPTING', 'build it #outcome:exhausted'));
    await playRolePlay(bad.host);
    const failing = bad.calls[0]?.args.script as typeof script;
    expect(failing.demands[0]?.verify[0]?.args).toEqual(['-e', 'process.exit(1)']);
  });

  it('has the Critic reject the first look for a failure outcome and approve the next', async () => {
    const prompt = stagePrompt('CRITIQUING', 'build it #outcome:script_failure');
    const first = host(prompt);
    await playRolePlay(first.host);
    expect(first.calls[0]?.args).toMatchObject({ approved: false });
    expect(String(first.calls[0]?.args.reason)).toContain('[outcome:script_failure]');
    const second = host(prompt);
    await playRolePlay(second.host);
    expect(second.calls[0]?.args).toEqual({ approved: true });
  });

  it('rescript: the second script keeps alpha, marked unchanged, and rewrites beta', async () => {
    const prompt = stagePrompt('SCRIPTING', 'build it #outcome:rescript');
    const first = host(prompt);
    await playRolePlay(first.host);
    const second = host(prompt);
    await playRolePlay(second.host);
    interface Demands {
      demands: { id: string; description: string; unchanged?: boolean }[];
    }
    const before = (first.calls[0]?.args.script as Demands).demands;
    const after = (second.calls[0]?.args.script as Demands).demands;
    expect(before.map((demand) => demand.unchanged)).toEqual([undefined, undefined]);
    expect(after[0]).toMatchObject({ id: 'alpha', unchanged: true });
    expect(after[0]?.description).toBe(before[0]?.description);
    expect(after[1]?.unchanged).toBeUndefined();
    expect(after[1]?.description).not.toBe(before[1]?.description);
    const critic = host(stagePrompt('CRITIQUING', 'build it #outcome:rescript'));
    await playRolePlay(critic.host);
    expect(String(critic.calls[0]?.args.reason)).toContain('[outcome:rescript]');
  });

  it('base_drift: the Critic moves main on its first look, with a new file or a shared one', async () => {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: sandbox, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'a@example.invalid');
    git('config', 'user.name', 'A');
    await writeFile(join(sandbox, 'seed.txt'), 'seed\n');
    git('add', '.');
    git('commit', '-q', '-m', 'seed');
    const start = git('rev-parse', 'main');
    const quiet = host(stagePrompt('CRITIQUING', 'build it #outcome:base_drift'));
    await playRolePlay(quiet.host);
    expect(git('rev-parse', 'main')).not.toBe(start);
    expect(git('show', 'main:news.txt')).toContain('written on main');
    expect(git('show', 'main:seed.txt')).toBe('seed');
    // the second look leaves main alone
    const moved = git('rev-parse', 'main');
    await playRolePlay(host(stagePrompt('CRITIQUING', 'build it #outcome:base_drift')).host);
    expect(git('rev-parse', 'main')).toBe(moved);
    const shared = host(stagePrompt('CRITIQUING', 'build it #outcome:base_drift_conflict'));
    process.env.FAKE_AGENT_STATE_DIR = join(sandbox, 'other-state');
    await playRolePlay(shared.host);
    expect(git('show', 'main:alpha.txt')).toContain('written on main');
    expect(git('log', '--format=%s', 'main')).toContain('main moves: alpha.txt');
  });

  it('has the Critic approve at once when the outcome is approved', async () => {
    const run = host(stagePrompt('CRITIQUING'));
    await playRolePlay(run.host);
    expect(run.calls[0]?.args).toEqual({ approved: true });
  });

  it('plays the Director: opens a play, asks the Producer, and classifies a critique', async () => {
    const open = host('prefix\n#ot-play do the thing #outcome:approved');
    await playRolePlay(open.host);
    expect(open.calls[0]).toEqual({
      tool: 'open_play',
      args: { need: 'do the thing #outcome:approved' },
    });

    const ask = host('#ot-ask which name?', {});
    await playRolePlay(ask.host);
    expect(ask.calls[0]?.tool).toBe('ask_producer');

    const judge = host('#ot-judge\n#ot-play: play-1\n#ot-point: classify_critique', {
      next_action: {
        decisions: [
          {
            id: 'd1',
            kind: 'judge.classify_critique',
            input: { reason: 'bad [outcome:structural_failure]', demandIds: ['alpha', 'beta'] },
          },
        ],
      },
    });
    await playRolePlay(judge.host);
    expect(judge.calls.map((call) => call.tool)).toEqual(['next_action', 'decide']);
    expect(judge.calls[1]?.args).toMatchObject({
      decisionId: 'd1',
      payload: { failures: [{ kind: 'structural' }] },
    });
  });

  it('plays the judgment, not the play, when a baton package carries the first prompt (P23)', async () => {
    const handed = host(
      '## Task\n\n#ot-play need #outcome:approved\n\n#ot-judge\n#ot-play: play-1\n#ot-point: classify_critique',
      {
        next_action: {
          decisions: [
            {
              id: 'd1',
              kind: 'judge.classify_critique',
              input: { reason: '[outcome:approved]', demandIds: ['alpha'] },
            },
          ],
        },
      },
    );
    await playRolePlay(handed.host);
    expect(handed.calls.map((call) => call.tool)).toEqual(['next_action', 'decide']);
  });

  it('classifies an execution failure with the first demand', async () => {
    const judge = host('#ot-judge', {
      next_action: {
        decisions: [
          {
            id: 'd1',
            kind: 'judge.classify_critique',
            input: { reason: '[outcome:execution_failure]', demandIds: ['alpha', 'beta'] },
          },
        ],
      },
    });
    await playRolePlay(judge.host);
    expect(judge.calls[1]?.args).toMatchObject({
      payload: { failures: [{ kind: 'execution', demandIds: ['alpha'] }] },
    });
  });

  it('notes which answer of point 8 the outcome asks for, and gives it', async () => {
    const classify = (outcome: string) =>
      host('#ot-judge', {
        next_action: {
          decisions: [
            {
              id: 'd1',
              kind: 'judge.classify_critique',
              input: { reason: `[outcome:${outcome}]`, demandIds: ['alpha', 'beta'] },
            },
          ],
        },
      });
    const redo = classify('dependency_redone_redo');
    await playRolePlay(redo.host);
    expect(
      String((redo.calls[1]?.args.payload as { failures: { note: string }[] }).failures[0]?.note),
    ).toContain('[answer:redo]');
    const rebase = classify('dependency_redone_rebase');
    await playRolePlay(rebase.host);
    expect(
      String((rebase.calls[1]?.args.payload as { failures: { note: string }[] }).failures[0]?.note),
    ).not.toContain('[answer:');

    const answer = async (reason: string) => {
      const judge = host('#ot-judge', {
        next_action: {
          decisions: [
            {
              id: 'p8',
              kind: 'judge.dependency_redone',
              input: { reason, dependentIds: ['beta'] },
            },
          ],
        },
      });
      await playRolePlay(judge.host);
      return judge.calls[1]?.args;
    };
    expect(await answer('redo the first demand [answer:redo]')).toEqual({
      decisionId: 'p8',
      payload: { action: 'redo' },
    });
    expect(await answer('redo the first demand')).toEqual({
      decisionId: 'p8',
      payload: { action: 'rebase' },
    });
  });

  it('answers a clarify decision with what the Producer said', async () => {
    const run = host('#ot-clarify\n#ot-play: play-1', {
      next_action: { decisions: [{ id: 'c1', kind: 'clarify', input: {} }] },
      ask_producer: { answers: ['hello'] },
    });
    await playRolePlay(run.host);
    expect(run.calls.map((call) => call.tool)).toEqual(['next_action', 'ask_producer', 'decide']);
    expect(run.calls[2]?.args).toEqual({ decisionId: 'c1', payload: { answers: ['hello'] } });
  });

  it('answers a simple chat question itself, and says so when it woke with the state summary', async () => {
    const plain = host('#ot-chat two and two');
    await playRolePlay(plain.host);
    expect(plain.calls).toEqual([]);
    expect(plain.said).toEqual(['answer: two and two']);
    const woke = host('State of scenario "talk" (talk-1, chat).\n\n#ot-chat again');
    await playRolePlay(woke.host);
    expect(woke.said).toEqual(['woke with the state of talk-1', 'answer: again']);
  });

  it('hands a hard chat question to the consultant with its attachments', async () => {
    const run = host('#ot-consult how to shard\n#ot-attach A1 A2', {
      consult: { answer: 'x' },
    });
    await playRolePlay(run.host);
    expect(run.calls).toEqual([
      { tool: 'consult', args: { question: 'how to shard', attachments: ['A1', 'A2'] } },
    ]);
    expect(run.said[0]).toContain('consulted');
  });

  it('reads the attachments the Director names', async () => {
    const run = host('#ot-read A1 A3');
    await playRolePlay(run.host);
    expect(run.calls.map((call) => call.args)).toEqual([{ id: 'A1' }, { id: 'A3' }]);
    expect(run.said).toHaveLength(2);
  });

  it('plays the consultant: reads what the prompt lists and submits the answer', async () => {
    const run = host(
      'prefix\n#ot-role: consultant\n#ot-consult-ask: what is in it\n#ot-attachments: A1',
      {
        read_attachment: { kind: 'text', mime: 'text/plain', content: 'the note\n' },
      },
    );
    await playRolePlay(run.host);
    expect(run.calls.map((call) => call.tool)).toEqual(['read_attachment', 'submit']);
    expect(run.calls[1]?.args).toEqual({
      result: { answer: 'consulted on "what is in it" [A1 says the note]' },
    });
  });

  it('the consultant writes in its directory, refuses a path that leaves it, and researches (P10)', async () => {
    const run = host(
      '#ot-role: consultant\n#ot-consult-ask: plan write:notes/p.md=the_plan write:../out.txt=x http:http://127.0.0.1:1/d',
      { http_get: { status: 200, body: 'docs\n' } },
    );
    await playRolePlay(run.host);
    expect(await readFile(join(sandbox, 'notes', 'p.md'), 'utf8')).toBe('the plan');
    await expect(readFile(join(sandbox, '..', 'out.txt'), 'utf8')).rejects.toThrow();
    expect(run.calls.map((call) => call.tool)).toEqual(['http_get', 'submit']);
    const answer = JSON.stringify(run.calls[1]?.args);
    expect(answer).toContain('write notes/p.md ok');
    expect(answer).toContain('write ../out.txt refused');
    expect(answer).toContain('http http://127.0.0.1:1/d 200 docs');
  });

  it('the consultant reports an image it was shown as an image block (P10)', async () => {
    const run = host('#ot-role: consultant\n#ot-consult-ask: look\n#ot-attachments: A1');
    const base = run.host;
    await playRolePlay({
      ...base,
      call: (tool, args) =>
        tool === 'read_attachment'
          ? Promise.resolve({
              isError: false,
              text: '{}',
              structured: { id: 'A1', kind: 'image', mime: 'image/png' },
              images: [{ mimeType: 'image/png', bytes: 68 }],
            })
          : base.call(tool, args),
    });
    expect(JSON.stringify(run.calls.at(-1)?.args)).toContain(
      'A1 is image/png, seen as image/png (68 bytes)',
    );
  });

  it('plays the Author grouping the queue: ideas of the first area go together', async () => {
    const run = host(
      [
        'prefix',
        '#ot-role: author',
        '#ot-group-ideas: 5',
        '- I1 [area: api] add a route',
        '- I2 [area: ui] add a button',
        '- I3 [area: api] test the route',
        '- I4 [area: -] fix a typo',
      ].join('\n'),
    );
    await playRolePlay(run.host);
    expect(run.calls.map((call) => call.tool)).toEqual(['submit_idea_group']);
    const args = run.calls[0]?.args as {
      group: { ideaIds: string[]; need: string };
      leftOut: { ideaId: string }[];
    };
    expect(args.group.ideaIds).toEqual(['I1', 'I3']);
    expect(args.group.need).toBe('add a route; test the route');
    expect(args.leftOut.map((item) => item.ideaId)).toEqual(['I2', 'I4']);
  });

  it('an idea with no area goes alone and the group respects the maximum', async () => {
    const alone = host('#ot-group-ideas: 5\n- I7 [area: -] one\n- I8 [area: -] two');
    await playRolePlay(alone.host);
    expect((alone.calls[0]?.args as { group: { ideaIds: string[] } }).group.ideaIds).toEqual([
      'I7',
    ]);
    const capped = host('#ot-group-ideas: 1\n- I1 [area: a] x\n- I2 [area: a] y');
    await playRolePlay(capped.host);
    expect((capped.calls[0]?.args as { group: { ideaIds: string[] } }).group.ideaIds).toEqual([
      'I1',
    ]);
  });
});

describe('the hang of the Director (P21b)', () => {
  it('hangs the first time and lets the prompt that comes back through', async () => {
    const text = '#ot-director-hang\n#ot-chat hello';
    expect(await directorHangs(text)).toBe(true);
    expect(await directorHangs(text)).toBe(false);
  });

  it('does nothing without the marker', async () => {
    expect(await directorHangs('#ot-chat hello')).toBe(false);
  });
});

describe('the quota failure of the Director (P20)', () => {
  it('fails the first time and lets the prompt that comes back through', async () => {
    const text = '#ot-director-fail:quota\n#ot-chat hello';
    expect(await directorQuotaFailure(text)).toEqual({});
    expect(await directorQuotaFailure(text)).toBeUndefined();
  });

  it('fails the number of times asked and carries the end of the limit', async () => {
    const text =
      '#ot-director-fail:quota\n#ot-director-fail-times:2\n#ot-director-fail-resets:2026-11-18T12:00:00.000Z';
    const reset = { resetsAt: '2026-11-18T12:00:00.000Z' };
    expect(await directorQuotaFailure(text)).toEqual(reset);
    expect(await directorQuotaFailure(text)).toEqual(reset);
    expect(await directorQuotaFailure(text)).toBeUndefined();
  });

  it('does nothing without the marker', async () => {
    expect(await directorQuotaFailure('#ot-chat hello')).toBeUndefined();
  });

  it('says the directives in force of the state summary the Director woke up with', async () => {
    const summary = [
      'State of scenario "talk" (chat, idle).',
      '',
      'Directives in force:',
      '- D1 (global rule): Always answer in haiku.',
      '- D2 (local rule) [director]: Keep it short.',
      '',
      'Prompts still in the queue, in delivery order:',
      '- none',
    ].join('\n');
    const run = host(`${summary}\n#ot-chat hello`);
    await playRolePlay(run.host);
    expect(run.said).toContain('directives in force: Always answer in haiku. | Keep it short.');
    expect(run.said).toContain('answer: hello');
  });
});

describe('the quota failure armed for the judgment point (P23)', () => {
  const arm =
    '#ot-director-fail:quota\n#ot-director-fail-on:judge\n#ot-director-fail-resets:2026-11-18T12:00:00.000Z\n#ot-play need';
  const judge = '#ot-judge\n#ot-play: play-1\n#ot-point: judge.classify_critique';

  it('lets the turn that arms it go through and fails the first judge prompt only', async () => {
    expect(await directorQuotaFailure(arm)).toBeUndefined();
    expect(await directorQuotaFailure('#ot-chat hello')).toBeUndefined();
    expect(await directorQuotaFailure(judge)).toEqual({ resetsAt: '2026-11-18T12:00:00.000Z' });
    expect(await directorQuotaFailure(judge)).toBeUndefined();
  });

  it('does nothing at a judge prompt when nothing was armed', async () => {
    expect(await directorQuotaFailure(judge)).toBeUndefined();
  });
});

describe('the tokens of the Actor (P23)', () => {
  const prompt = (need: string, demand = 'alpha', attempt = 1): string =>
    `${stagePrompt('EXECUTING', need)}\n#ot-demand: ${demand}\n#ot-attempt: ${String(attempt)}\n`;

  it('commits and installs after writing the file, with the calls the effects registry replays', async () => {
    const run = host(prompt('go #actor-effects:alpha'));
    await playRolePlay(run.host);
    expect(run.calls.map((call) => call.tool)).toEqual(['git_commit', 'install_deps', 'submit']);
    expect(run.calls[0]?.args).toEqual({ message: 'alpha: write alpha.txt' });
    const other = host(prompt('go #actor-effects:alpha', 'beta'));
    await playRolePlay(other.host);
    expect(other.calls.map((call) => call.tool)).toEqual(['submit']);
  });

  it('runs out of quota once, after its effects, and carries the end of the limit', async () => {
    const need = 'go #actor-effects:alpha #actor-quota:alpha=2026-11-18T18:00:00.000Z';
    const first = host(prompt(need));
    await expect(playRolePlay(first.host)).rejects.toThrow('quota exhausted');
    expect(first.exhausted).toEqual(['2026-11-18T18:00:00.000Z']);
    expect(first.calls.map((call) => call.tool)).toEqual(['git_commit', 'install_deps']);
    // The next session of the attempt finds the failure spent and finishes.
    const second = host(prompt(need));
    await playRolePlay(second.host);
    expect(second.exhausted).toEqual([]);
    expect(second.calls.map((call) => call.tool)).toEqual(['git_commit', 'install_deps', 'submit']);
  });

  it('fails only in the attempt the token names', async () => {
    const need = 'go #actor-quota:alpha=2026-11-18T18:00:00.000Z@2';
    const first = host(prompt(need, 'alpha', 1));
    await playRolePlay(first.host);
    expect(first.exhausted).toEqual([]);
    const second = host(prompt(need, 'alpha', 2));
    await expect(playRolePlay(second.host)).rejects.toThrow('quota exhausted');
  });

  it('waits for the cancel once, writes nothing, and goes on at the next session', async () => {
    const need = 'go #actor-hang:alpha@2';
    const cancel = new AbortController();
    const hanging = host(prompt(need, 'alpha', 2), {}, cancel.signal);
    const turn = playRolePlay(hanging.host);
    await new Promise((done) => setTimeout(done, 50));
    cancel.abort();
    await turn;
    expect(hanging.calls).toEqual([]);
    await expect(readFile(join(sandbox, 'alpha.txt'), 'utf8')).rejects.toThrow();
    const next = host(prompt(need, 'alpha', 2));
    await playRolePlay(next.host);
    expect(next.calls.map((call) => call.tool)).toEqual(['submit']);
  });

  it('plays the prompt of the Actor again at a turn with no marker in the same worktree (native resume)', async () => {
    const need = 'go #actor-effects:alpha #actor-quota:alpha=2026-11-18T18:00:00.000Z';
    const first = host(prompt(need));
    await expect(playRolePlay(first.host)).rejects.toThrow('quota exhausted');
    const resumed = host('Carry on with the task where you stopped.');
    await playRolePlay(resumed.host);
    expect(resumed.calls.map((call) => call.tool)).toEqual([
      'git_commit',
      'install_deps',
      'submit',
    ]);
    const stranger = await mkdtemp(join(tmpdir(), 'fake-agent-stranger-'));
    const nothing = host('Carry on with the task where you stopped.');
    await playRolePlay({ ...nothing.host, cwd: stranger });
    expect(nothing.calls).toEqual([]);
    expect(nothing.said).toEqual(['fake agent: nothing to do']);
    await rm(stranger, { recursive: true, force: true });
  });
});
