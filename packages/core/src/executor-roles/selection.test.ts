// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { InvalidInput } from '../errors.js';
import { parseExecutorId } from './names.js';
import {
  resolveRoleExecutors,
  type ExecutorEntry,
  type ProfileFact,
  type ResolvedExecutor,
  type ResolvedRole,
} from './resolve.js';
import {
  DEFAULT_SELECTION_SETTINGS,
  gatherSelectionFacts,
  selectExecutor,
  selectExecutorFromPorts,
  type ExecutorFacts,
  type QuotaFact,
  type SelectionInput,
  type SelectionPorts,
  type SelectionSettings,
  type WorkedBy,
} from './selection.js';

/** An Executor of a resolved list; the provider is the family of the model (the client fixes two). */
function executor(id: string, provider?: string): ResolvedExecutor {
  const parsed = parseExecutorId(id);
  const fixed: Record<string, string> = { 'claude-code': 'anthropic', codex: 'openai' };
  const entry: ExecutorEntry = {
    id,
    client: parsed.client,
    profile: parsed.profile,
    model: parsed.model,
    effort: parsed.effort,
    provider: fixed[parsed.client] ?? provider ?? 'unknown',
  };
  return {
    id,
    entry,
    validity: 'valid',
    invalidReason: null,
    shortfalls: [],
    origin: 'config',
  };
}

const OK: QuotaFact = { state: 'ok', cause: null, untilReset: null, headroom: 0.5 };
const FREE = { slot: 'free', ram: 'ok' } as const;

function facts(overrides: Partial<ExecutorFacts> = {}): ExecutorFacts {
  return {
    profileState: 'active',
    healthy: true,
    quota: OK,
    admission: FREE,
    contextWindow: 200_000,
    ...overrides,
  };
}

const exhausted = (untilReset: number | null, cause: 'quota' | 'budget' = 'quota'): QuotaFact => ({
  state: 'exhausted',
  cause,
  untilReset,
  headroom: 0,
});

interface Setup {
  readonly list: ResolvedExecutor[];
  /** Facts by Executor id; an Executor with none gets the healthy default. */
  readonly facts?: Record<string, Partial<ExecutorFacts>>;
  readonly role?: ResolvedRole['role'];
  readonly whenExhausted?: ResolvedRole['whenExhausted'];
  readonly settings?: Partial<SelectionSettings>;
  readonly promptTokens?: number;
  readonly previousExecutor?: string | null;
  readonly workedBy?: WorkedBy | null;
  readonly roundRobin?: ReadonlyMap<string, number>;
}

function select(setup: Setup) {
  const map = new Map<string, ExecutorFacts>();
  for (const item of setup.list) {
    if (item.validity === 'valid') map.set(item.id, facts(setup.facts?.[item.id]));
  }
  const input: SelectionInput = {
    role: {
      role: setup.role ?? 'author',
      executors: setup.list,
      whenExhausted: setup.whenExhausted ?? 'next',
    },
    facts: map,
    settings: { ...DEFAULT_SELECTION_SETTINGS, ...setup.settings },
    promptTokens: setup.promptTokens,
    previousExecutor: setup.previousExecutor,
    workedBy: setup.workedBy,
    roundRobin: setup.roundRobin,
  };
  return selectExecutor(input);
}

const OPUS_A = 'claude-opus-high@claude-code/empresa';
const OPUS_B = 'claude-opus-high@claude-code/pessoal';
const SOL = 'codex-sol-high@codex/conta-1';
const MINIMAX = 'minimax-m2-medium@opencode/minimax-api';
const GEMMA = 'gemma4-medium@opencode/local';

const reasonsOf = (result: ReturnType<typeof select>) =>
  result.skipped.map((skipped) => [skipped.executor, skipped.reason]);

describe('the first available Executor', () => {
  it('takes the first of the list when it is available, and skips nobody', () => {
    const result = select({ list: [executor(OPUS_A), executor(SOL)] });
    expect(result.selected?.id).toBe(OPUS_A);
    expect(result.wait).toBeNull();
    expect(result.skipped).toEqual([]);
    expect(result.strategy).toBe('ordered');
  });

  it('is the same answer for the same input', () => {
    const setup = {
      list: [executor(OPUS_A), executor(SOL)],
      facts: { [OPUS_A]: { healthy: false } },
    };
    expect(select(setup)).toEqual(select(setup));
  });

  it('says what it skipped, in the order of the list, each with its reason', () => {
    const result = select({
      list: [executor(OPUS_A), executor(SOL), executor(MINIMAX)],
      facts: {
        [OPUS_A]: { quota: exhausted(5_000) },
        [SOL]: { admission: { slot: 'full', ram: 'ok' } },
      },
    });
    expect(result.selected?.id).toBe(MINIMAX);
    expect(result.skipped).toEqual([
      {
        executor: OPUS_A,
        profile: 'claude-code/empresa',
        reason: 'quota',
        detail: 'exhausted',
        untilReset: 5_000,
      },
      {
        executor: SOL,
        profile: 'codex/conta-1',
        reason: 'no_slot',
        detail: null,
        untilReset: null,
      },
    ]);
  });
});

describe('each reason for skipping an Executor', () => {
  const cases: [string, Partial<ExecutorFacts>, string][] = [
    ['quota', { quota: exhausted(1_000) }, 'quota'],
    ['budget', { quota: exhausted(null, 'budget') }, 'budget'],
    ['draining', { profileState: 'draining' }, 'draining'],
    ['a missing profile', { profileState: 'missing' }, 'invalid'],
    ['a removed profile', { profileState: 'removed' }, 'invalid'],
    ['no vacancy', { admission: { slot: 'full', ram: 'ok' } }, 'no_slot'],
    ['no RAM', { admission: { slot: 'free', ram: 'low' } }, 'ram'],
    ['an unhealthy profile', { healthy: false }, 'unhealthy'],
  ];

  it.each(cases)('%s', (_name, fact, reason) => {
    const result = select({
      list: [executor(OPUS_A), executor(SOL)],
      facts: { [OPUS_A]: fact },
    });
    expect(result.selected?.id).toBe(SOL);
    expect(reasonsOf(result)).toEqual([[OPUS_A, reason]]);
  });

  it('an Executor marked invalid by the resolution is skipped as invalid, with its reason', () => {
    const invalid: ResolvedExecutor = {
      ...executor(OPUS_A),
      validity: 'invalid',
      invalidReason: 'profile_missing',
    };
    const result = select({ list: [invalid, executor(SOL)] });
    expect(result.selected?.id).toBe(SOL);
    expect(result.skipped).toMatchObject([
      { executor: OPUS_A, reason: 'invalid', detail: 'profile_missing' },
    ]);
  });

  it('the prompt that does not fit the window skips the Executor as context', () => {
    const result = select({
      list: [executor(GEMMA), executor(SOL)],
      facts: { [GEMMA]: { contextWindow: 32_000 }, [SOL]: { contextWindow: 200_000 } },
      promptTokens: 40_000,
    });
    expect(result.selected?.id).toBe(SOL);
    expect(result.skipped).toMatchObject([{ executor: GEMMA, reason: 'context' }]);
    expect(result.skipped[0]?.detail).toContain('32000');
  });

  it('counts the reserve of the client, and a prompt that just fits passes', () => {
    const list = [executor(GEMMA), executor(SOL)];
    const facts32 = { [GEMMA]: { contextWindow: 32_000 } };
    expect(
      select({ list, facts: facts32, promptTokens: 30_000, settings: { contextReserve: 2_000 } })
        .selected?.id,
    ).toBe(GEMMA);
    expect(
      select({ list, facts: facts32, promptTokens: 30_001, settings: { contextReserve: 2_000 } })
        .selected?.id,
    ).toBe(SOL);
  });

  it('never fails the window when the prompt or the window is not known', () => {
    const list = [executor(GEMMA)];
    expect(
      select({ list, facts: { [GEMMA]: { contextWindow: undefined } }, promptTokens: 1e9 })
        .selected,
    ).not.toBeNull();
    expect(select({ list, facts: { [GEMMA]: { contextWindow: 1 } } }).selected).not.toBeNull();
  });

  it('gives one reason per Executor, the first of the questions of 5.7', () => {
    const result = select({
      list: [executor(OPUS_A), executor(SOL)],
      facts: {
        [OPUS_A]: {
          profileState: 'draining',
          healthy: false,
          quota: exhausted(1),
          admission: { slot: 'full', ram: 'low' },
        },
      },
    });
    expect(reasonsOf(result)).toEqual([[OPUS_A, 'draining']]);
  });

  it('refuses to guess when the facts of a valid Executor are missing', () => {
    expect(() =>
      selectExecutor({
        role: { role: 'author', executors: [executor(OPUS_A)], whenExhausted: 'next' },
        facts: new Map(),
        settings: DEFAULT_SELECTION_SETTINGS,
      }),
    ).toThrow(InvalidInput);
  });
});

describe('when nobody is available', () => {
  const dry = {
    [OPUS_A]: { quota: exhausted(9_000) },
    [SOL]: { quota: exhausted(7_000) },
    [MINIMAX]: { admission: { slot: 'full', ram: 'ok' } as const },
  };
  const list = () => [executor(OPUS_A), executor(SOL), executor(MINIMAX)];

  it('next: waits for whichever frees first, with the earliest known end', () => {
    const result = select({ list: list(), facts: dry, whenExhausted: 'next' });
    expect(result.selected).toBeNull();
    expect(result.wait).toEqual({ mode: 'next', on: [OPUS_A, SOL, MINIMAX], until: 7_000 });
    expect(result.skipped).toHaveLength(3);
  });

  it('wait: waits for the reset of the first, with no demotion', () => {
    const result = select({ list: list(), facts: dry, whenExhausted: 'wait' });
    expect(result.selected).toBeNull();
    expect(result.wait).toEqual({ mode: 'wait', on: [OPUS_A], until: 9_000 });
  });

  it('wait: never waits for what time cannot fix (a draining first Executor)', () => {
    const result = select({
      list: list(),
      facts: { ...dry, [OPUS_A]: { profileState: 'draining' } },
      whenExhausted: 'wait',
    });
    expect(result.wait).toEqual({ mode: 'wait', on: [SOL], until: 7_000 });
  });

  it('has nothing to wait for when every reason is permanent', () => {
    const result = select({
      list: [executor(OPUS_A)],
      facts: { [OPUS_A]: { profileState: 'draining' } },
    });
    expect(result.wait).toEqual({ mode: 'next', on: [], until: null });
  });

  it('a wait with no end known has `until` null', () => {
    const result = select({
      list: [executor(OPUS_A)],
      facts: { [OPUS_A]: { quota: exhausted(null) } },
    });
    expect(result.wait).toEqual({ mode: 'next', on: [OPUS_A], until: null });
  });
});

describe('retry with diversity', () => {
  const list = () => [executor(OPUS_A), executor(SOL), executor(MINIMAX)];

  it('starts at the Executor after the one of the previous attempt', () => {
    const result = select({ list: list(), previousExecutor: OPUS_A });
    expect(result.selected?.id).toBe(SOL);
    expect(result.retriedAfter).toBe(OPUS_A);
    expect(result.skipped).toEqual([]);
  });

  it('goes on in the list and wraps around, the one that failed last', () => {
    const wrapped = select({ list: list(), previousExecutor: MINIMAX });
    expect(wrapped.selected?.id).toBe(OPUS_A);
    const onlyFailed = select({
      list: list(),
      previousExecutor: SOL,
      facts: { [MINIMAX]: { healthy: false }, [OPUS_A]: { healthy: false } },
    });
    expect(onlyFailed.selected?.id).toBe(SOL);
    expect(reasonsOf(onlyFailed)).toEqual([
      [MINIMAX, 'unhealthy'],
      [OPUS_A, 'unhealthy'],
    ]);
  });

  it('forward_only never goes back: the ones up to the failed one are skipped as retry', () => {
    const result = select({
      list: list(),
      previousExecutor: SOL,
      settings: { retryDiversity: 'forward_only' },
      facts: { [MINIMAX]: { healthy: false } },
    });
    expect(result.selected).toBeNull();
    expect(reasonsOf(result)).toEqual([
      [OPUS_A, 'retry'],
      [SOL, 'retry'],
      [MINIMAX, 'unhealthy'],
    ]);
  });

  it('off starts from the top again; a previous Executor outside the list changes nothing', () => {
    expect(
      select({ list: list(), previousExecutor: OPUS_A, settings: { retryDiversity: 'off' } })
        .selected?.id,
    ).toBe(OPUS_A);
    const stranger = select({ list: list(), previousExecutor: 'x-low@codex/gone' });
    expect(stranger.selected?.id).toBe(OPUS_A);
    expect(stranger.retriedAfter).toBeNull();
  });
});

describe('the cross-review (selection.cross_check)', () => {
  const list = () => [executor(OPUS_A), executor(SOL), executor(GEMMA, 'google')];
  const workedByAnthropic: WorkedBy = { provider: 'anthropic', model: 'claude-opus' };

  it('prefer_other_provider (default): skips the provider of the work, with the pulo in the event', () => {
    const result = select({ list: list(), role: 'reviewer', workedBy: workedByAnthropic });
    expect(result.selected?.id).toBe(SOL);
    expect(reasonsOf(result)).toEqual([[OPUS_A, 'same_provider']]);
    expect(result.crossCheck).toEqual({
      mode: 'prefer_other_provider',
      applied: true,
      workedProvider: 'anthropic',
      fellBack: false,
    });
  });

  it('prefer_other_provider: goes back to the provider of the work when nobody else is available', () => {
    const result = select({
      list: list(),
      role: 'critic',
      workedBy: workedByAnthropic,
      facts: { [SOL]: { quota: exhausted(3_000) }, [GEMMA]: { healthy: false } },
    });
    expect(result.selected?.id).toBe(OPUS_A);
    expect(result.crossCheck.fellBack).toBe(true);
    expect(reasonsOf(result)).toEqual([
      [SOL, 'quota'],
      [GEMMA, 'unhealthy'],
    ]);
  });

  it('prefer_other_provider: a conflicting Executor that is unavailable keeps its real reason', () => {
    const result = select({
      list: list(),
      role: 'reviewer',
      workedBy: workedByAnthropic,
      facts: {
        [OPUS_A]: { quota: exhausted(1_000) },
        [SOL]: { healthy: false },
        [GEMMA]: { healthy: false },
      },
    });
    expect(result.selected).toBeNull();
    expect(result.wait?.on).toEqual([SOL, GEMMA, OPUS_A]);
    expect(result.skipped.find((s) => s.executor === OPUS_A)?.reason).toBe('quota');
  });

  it('require_other_provider: never takes the provider of the work, and waits', () => {
    const result = select({
      list: [executor(OPUS_A), executor(SOL)],
      role: 'reviewer',
      workedBy: workedByAnthropic,
      settings: { crossCheck: 'require_other_provider' },
      facts: { [SOL]: { quota: exhausted(4_000) } },
    });
    expect(result.selected).toBeNull();
    expect(result.wait).toEqual({ mode: 'next', on: [SOL], until: 4_000 });
    expect(reasonsOf(result)).toEqual([
      [OPUS_A, 'same_provider'],
      [SOL, 'quota'],
    ]);
  });

  it('require_other_provider: waits for nothing when the list has no other provider', () => {
    const result = select({
      list: [executor(OPUS_A), executor(OPUS_B)],
      role: 'critic',
      workedBy: workedByAnthropic,
      settings: { crossCheck: 'require_other_provider' },
    });
    expect(result.selected).toBeNull();
    expect(result.wait).toEqual({ mode: 'next', on: [], until: null });
  });

  it('other_model: another model of the same provider is enough', () => {
    const sonnet = executor('claude-sonnet-high@claude-code/empresa');
    const result = select({
      list: [executor(OPUS_A), sonnet, executor(SOL)],
      role: 'reviewer',
      workedBy: workedByAnthropic,
      settings: { crossCheck: 'other_model' },
    });
    expect(result.selected?.id).toBe(sonnet.id);
    expect(reasonsOf(result)).toEqual([[OPUS_A, 'same_model']]);
  });

  it('other_model: the same model at another effort or account is the same model', () => {
    const result = select({
      list: [executor('claude-opus-low@claude-code/pessoal'), executor(OPUS_A)],
      role: 'reviewer',
      workedBy: workedByAnthropic,
      settings: { crossCheck: 'other_model' },
    });
    expect(result.selected).toBeNull();
    expect(reasonsOf(result)).toEqual([
      ['claude-opus-low@claude-code/pessoal', 'same_model'],
      [OPUS_A, 'same_model'],
    ]);
  });

  it('off: only the order of the list', () => {
    const result = select({
      list: list(),
      role: 'reviewer',
      workedBy: workedByAnthropic,
      settings: { crossCheck: 'off' },
    });
    expect(result.selected?.id).toBe(OPUS_A);
    expect(result.crossCheck.applied).toBe(false);
    expect(result.skipped).toEqual([]);
  });

  it('applies only to the Reviewer and the Critic, and only when there is work to compare with', () => {
    expect(select({ list: list(), role: 'author', workedBy: workedByAnthropic }).selected?.id).toBe(
      OPUS_A,
    );
    expect(select({ list: list(), role: 'reviewer', workedBy: null }).selected?.id).toBe(OPUS_A);
    expect(select({ list: list(), role: 'reviewer' }).crossCheck.applied).toBe(false);
  });

  it('an unknown provider counts as different from all, on both sides', () => {
    const unknownExecutor = executor('mystery-high@opencode/other');
    expect(unknownExecutor.entry.provider).toBe('unknown');
    const byUnknownWork = select({
      list: [unknownExecutor, executor(OPUS_A)],
      role: 'reviewer',
      workedBy: { provider: 'unknown' },
    });
    expect(byUnknownWork.selected?.id).toBe(unknownExecutor.id);
    expect(byUnknownWork.skipped).toEqual([]);
    const byKnownWork = select({
      list: [unknownExecutor],
      role: 'reviewer',
      workedBy: { provider: 'anthropic' },
    });
    expect(byKnownWork.selected?.id).toBe(unknownExecutor.id);
  });

  it('keeps the provider of the model, not the client or the account', () => {
    const viaOpencode = executor('claude-opus-high@opencode/anthropic-api', 'anthropic');
    const result = select({
      list: [viaOpencode, executor(GEMMA, 'google')],
      role: 'reviewer',
      workedBy: workedByAnthropic,
    });
    expect(result.selected?.id).toBe(GEMMA);
    expect(reasonsOf(result)).toEqual([[viaOpencode.id, 'same_provider']]);
  });
});

describe('selection.strategy among the accounts of one <model>-<effort> (N130)', () => {
  const list = () => [executor(OPUS_A), executor(OPUS_B), executor(SOL)];
  const room = (headroom: number | null) => ({ quota: { ...OK, headroom } });

  it('ordered (default): the list order, the second account only when the first is out', () => {
    expect(select({ list: list() }).selected?.id).toBe(OPUS_A);
    expect(
      select({ list: list(), facts: { [OPUS_A]: { quota: exhausted(1) } } }).selected?.id,
    ).toBe(OPUS_B);
  });

  it('most_headroom: the account with more room goes first; a tie keeps the list order', () => {
    const settings = { strategy: 'most_headroom' } as const;
    expect(
      select({
        list: list(),
        settings,
        facts: { [OPUS_A]: room(0.2), [OPUS_B]: room(0.7) },
      }).selected?.id,
    ).toBe(OPUS_B);
    expect(
      select({
        list: list(),
        settings,
        facts: { [OPUS_A]: room(0.4), [OPUS_B]: room(0.4) },
      }).selected?.id,
    ).toBe(OPUS_A);
  });

  it('most_headroom: an unknown headroom goes after a known one', () => {
    expect(
      select({
        list: list(),
        settings: { strategy: 'most_headroom' },
        facts: { [OPUS_A]: room(null), [OPUS_B]: room(0.1) },
      }).selected?.id,
    ).toBe(OPUS_B);
  });

  it('never moves an Executor of another model, whatever the strategy', () => {
    const result = select({
      list: [executor(OPUS_A), executor(SOL), executor(OPUS_B)],
      settings: { strategy: 'most_headroom' },
      facts: { [OPUS_A]: room(0.1), [OPUS_B]: room(0.9), [SOL]: room(0.1) },
    });
    // the two Opus accounts are not side by side: nothing is reordered
    expect(result.selected?.id).toBe(OPUS_A);
  });

  it('round_robin: starts at the cursor and hands back the next one', () => {
    const settings = { strategy: 'round_robin' } as const;
    const first = select({ list: list(), settings });
    expect(first.selected?.id).toBe(OPUS_A);
    expect(first.roundRobin).toEqual({ group: 'claude-opus-high', cursor: 1 });
    const second = select({
      list: list(),
      settings,
      roundRobin: new Map([['claude-opus-high', 1]]),
    });
    expect(second.selected?.id).toBe(OPUS_B);
    expect(second.roundRobin).toEqual({ group: 'claude-opus-high', cursor: 0 });
  });

  it('round_robin: skips an account that is out and still moves the cursor past the one used', () => {
    const result = select({
      list: list(),
      settings: { strategy: 'round_robin' },
      roundRobin: new Map([['claude-opus-high', 1]]),
      facts: { [OPUS_B]: { quota: exhausted(1) } },
    });
    expect(result.selected?.id).toBe(OPUS_A);
    expect(reasonsOf(result)).toEqual([[OPUS_B, 'quota']]);
    expect(result.roundRobin).toEqual({ group: 'claude-opus-high', cursor: 1 });
  });

  it('round_robin: the one alone in its model takes no cursor', () => {
    const result = select({
      list: [executor(SOL), executor(OPUS_A)],
      settings: { strategy: 'round_robin' },
    });
    expect(result.roundRobin).toBeNull();
  });
});

describe('unknown and near-limit quota (N124)', () => {
  const list = () => [executor(OPUS_A), executor(SOL)];
  const unknown: QuotaFact = { state: 'unknown', cause: null, untilReset: null, headroom: null };
  const near: QuotaFact = { state: 'near_limit', cause: null, untilReset: null, headroom: 0.1 };

  it('allows an unknown quota by default: the real session is the test', () => {
    expect(select({ list: list(), facts: { [OPUS_A]: { quota: unknown } } }).selected?.id).toBe(
      OPUS_A,
    );
  });

  it('unknown_quota: skip passes it over as quota, naming it unknown', () => {
    const result = select({
      list: list(),
      settings: { unknownQuota: 'skip' },
      facts: { [OPUS_A]: { quota: unknown } },
    });
    expect(result.selected?.id).toBe(SOL);
    expect(result.skipped).toMatchObject([
      { executor: OPUS_A, reason: 'quota', detail: 'unknown' },
    ]);
  });

  it('keeps near_limit in the order of the list by default', () => {
    expect(select({ list: list(), facts: { [OPUS_A]: { quota: near } } }).selected?.id).toBe(
      OPUS_A,
    );
  });

  it('near_limit: last puts it behind the others, and still takes it when it is the only one', () => {
    const settings = { nearLimit: 'last' } as const;
    expect(
      select({ list: list(), settings, facts: { [OPUS_A]: { quota: near } } }).selected?.id,
    ).toBe(SOL);
    expect(
      select({
        list: list(),
        settings,
        facts: { [OPUS_A]: { quota: near }, [SOL]: { quota: exhausted(1) } },
      }).selected?.id,
    ).toBe(OPUS_A);
  });

  it('near_limit: skip passes it over as quota, naming near_limit', () => {
    const result = select({
      list: list(),
      settings: { nearLimit: 'skip' },
      facts: { [OPUS_A]: { quota: near } },
    });
    expect(result.selected?.id).toBe(SOL);
    expect(result.skipped).toMatchObject([
      { executor: OPUS_A, reason: 'quota', detail: 'near_limit' },
    ]);
  });
});

describe('the Executors of the roles and the phase criterion', () => {
  const PROFILES: ProfileFact[] = [
    { id: 'claude-code/empresa', kind: 'token_plan', state: 'active' },
    { id: 'claude-code/pessoal', kind: 'token_plan', state: 'active' },
    { id: 'codex/conta-1', kind: 'token_plan', state: 'active' },
  ];
  const CATALOG: ExecutorEntry[] = [
    executor(OPUS_A).entry,
    executor(OPUS_B).entry,
    executor(SOL).entry,
  ];

  function resolved(layers: Parameters<typeof resolveRoleExecutors>[0]['layers'] = [{}]) {
    return resolveRoleExecutors({ layers, catalog: CATALOG, profiles: PROFILES });
  }

  it('criterion 1 of the phase: with two profiles of one client, exhausting one picks the next of the list', () => {
    const author = resolved().roles.author;
    expect(author.executors.map((item) => item.id)).toEqual([OPUS_A, OPUS_B, SOL]);
    const input = (quota: Record<string, QuotaFact>): SelectionInput => ({
      role: author,
      facts: new Map(
        author.executors.map((item) => [item.id, facts({ quota: quota[item.id] ?? OK })]),
      ),
      settings: DEFAULT_SELECTION_SETTINGS,
    });
    expect(selectExecutor(input({})).selected?.id).toBe(OPUS_A);
    const after = selectExecutor(input({ [OPUS_A]: exhausted(60_000) }));
    expect(after.selected?.id).toBe(OPUS_B);
    expect(after.skipped).toMatchObject([
      { executor: OPUS_A, reason: 'quota', untilReset: 60_000 },
    ]);
    const bothOut = selectExecutor(
      input({ [OPUS_A]: exhausted(60_000), [OPUS_B]: exhausted(90_000) }),
    );
    expect(bothOut.selected?.id).toBe(SOL);
  });

  it('allowed_profiles of a scenario takes the accounts out before the selection ever sees them', () => {
    const author = resolved([{}, { allowed_profiles: ['claude-code/empresa', 'codex/conta-1'] }])
      .roles.author;
    expect(author.executors.map((item) => item.id)).toEqual([OPUS_A, SOL]);
    const result = selectExecutor({
      role: author,
      facts: new Map(author.executors.map((item) => [item.id, facts()])),
      settings: DEFAULT_SELECTION_SETTINGS,
    });
    expect(result.selected?.id).toBe(OPUS_A);
    const outOfQuota = selectExecutor({
      role: author,
      facts: new Map(
        author.executors.map((item) => [
          item.id,
          facts(item.id === OPUS_A ? { quota: exhausted(1) } : {}),
        ]),
      ),
      settings: DEFAULT_SELECTION_SETTINGS,
    });
    // the other Opus account is not allowed here, so the selection goes to the next model
    expect(outOfQuota.selected?.id).toBe(SOL);
    expect(outOfQuota.skipped.map((skipped) => skipped.executor)).toEqual([OPUS_A]);
  });

  it('the Reviewer of the quality preset skips the provider of the Author', () => {
    const reviewer = resolved().roles.reviewer;
    // quality: codex first, then the Opus accounts
    expect(reviewer.executors.map((item) => item.id)).toEqual([SOL, OPUS_A, OPUS_B]);
    const result = selectExecutor({
      role: reviewer,
      facts: new Map(reviewer.executors.map((item) => [item.id, facts()])),
      settings: DEFAULT_SELECTION_SETTINGS,
      workedBy: { provider: 'openai' },
    });
    expect(result.selected?.id).toBe(OPUS_A);
    expect(reasonsOf({ ...result } as ReturnType<typeof select>)).toEqual([[SOL, 'same_provider']]);
  });
});

describe('the ports', () => {
  function ports(calls: string[], over: Partial<SelectionPorts> = {}): SelectionPorts {
    return {
      profile: (id) => {
        calls.push(`profile:${id}`);
        return { state: 'active' };
      },
      health: () => true,
      quota: (id) => {
        calls.push(`quota:${id}`);
        return OK;
      },
      admission: () => FREE,
      contextWindow: () => 200_000,
      ...over,
    };
  }

  it('asks each profile once, however many Executors it has, and nothing of an invalid one', async () => {
    const calls: string[] = [];
    const invalid: ResolvedExecutor = {
      ...executor('codex-sol-high@codex/conta-9'),
      validity: 'invalid',
      invalidReason: 'profile_missing',
    };
    const gathered = await gatherSelectionFacts(ports(calls), [
      executor(OPUS_A),
      executor('claude-sonnet-high@claude-code/empresa'),
      invalid,
    ]);
    expect([...gathered.keys()]).toEqual([OPUS_A, 'claude-sonnet-high@claude-code/empresa']);
    expect(calls.filter((call) => call.startsWith('profile:'))).toEqual([
      'profile:claude-code/empresa',
    ]);
    expect(calls.filter((call) => call.startsWith('quota:'))).toHaveLength(1);
  });

  it('an unregistered profile is missing, and the selection skips it as invalid', async () => {
    const result = await selectExecutorFromPorts(
      ports([], {
        profile: (id) => (id === 'claude-code/empresa' ? undefined : { state: 'active' }),
      }),
      {
        role: {
          role: 'author',
          executors: [executor(OPUS_A), executor(SOL)],
          whenExhausted: 'next',
        },
        settings: DEFAULT_SELECTION_SETTINGS,
      },
    );
    expect(result.selected?.id).toBe(SOL);
    expect(result.skipped).toMatchObject([
      { executor: OPUS_A, reason: 'invalid', detail: 'profile missing' },
    ]);
  });

  it('lets a failing port fail the selection: it never guesses availability', async () => {
    await expect(
      selectExecutorFromPorts(
        ports([], {
          quota: () => {
            throw new Error('probe down');
          },
        }),
        {
          role: { role: 'author', executors: [executor(OPUS_A)], whenExhausted: 'next' },
          settings: DEFAULT_SELECTION_SETTINGS,
        },
      ),
    ).rejects.toThrow('probe down');
  });
});
