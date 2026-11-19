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
  readonly earlier?: ResolvedExecutor[];
}

function select(setup: Setup) {
  const map = new Map<string, ExecutorFacts>();
  for (const item of [...setup.list, ...(setup.earlier ?? [])]) {
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
    earlier: setup.earlier,
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
    expect(result.wait).toEqual({
      mode: 'next',
      on: [OPUS_A, SOL, MINIMAX],
      until: 7_000,
      notify: false,
    });
    expect(result.skipped).toHaveLength(3);
  });

  it('wait: waits for the reset of the first, with no demotion', () => {
    const result = select({ list: list(), facts: dry, whenExhausted: 'wait' });
    expect(result.selected).toBeNull();
    expect(result.wait).toEqual({ mode: 'wait', on: [OPUS_A], until: 9_000, notify: false });
  });

  it('wait: never waits for what time cannot fix (a draining first Executor)', () => {
    const result = select({
      list: list(),
      facts: { ...dry, [OPUS_A]: { profileState: 'draining' } },
      whenExhausted: 'wait',
    });
    expect(result.wait).toEqual({ mode: 'wait', on: [SOL], until: 7_000, notify: false });
  });

  it('has nothing to wait for when every reason is permanent', () => {
    const result = select({
      list: [executor(OPUS_A)],
      facts: { [OPUS_A]: { profileState: 'draining' } },
    });
    expect(result.wait).toEqual({ mode: 'next', on: [], until: null, notify: false });
  });

  it('a wait with no end known has `until` null', () => {
    const result = select({
      list: [executor(OPUS_A)],
      facts: { [OPUS_A]: { quota: exhausted(null) } },
    });
    expect(result.wait).toEqual({ mode: 'next', on: [OPUS_A], until: null, notify: false });
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
      blocked: false,
      noneConfigured: false,
      degraded: null,
      sameAccount: false,
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
    // Opus is free and set aside, so the wait is the cross-review's: it is flagged (N135).
    expect(result.wait).toEqual({ mode: 'next', on: [SOL], until: 4_000, notify: true });
    expect(reasonsOf(result)).toEqual([
      [OPUS_A, 'same_provider'],
      [SOL, 'quota'],
    ]);
    expect(result.crossCheck.blocked).toBe(true);
  });

  it('require_other_provider: waits for nothing when the list has no other provider', () => {
    const result = select({
      list: [executor(OPUS_A), executor(OPUS_B)],
      role: 'critic',
      workedBy: workedByAnthropic,
      settings: { crossCheck: 'require_other_provider' },
    });
    // N150: nobody in the list satisfies it, so it does not wait: it goes back to the provider of
    // the work at once (the list order, both at the same level) and says why.
    expect(result.selected?.id).toBe(OPUS_A);
    expect(result.wait).toBeNull();
    expect(result.crossCheck).toMatchObject({
      blocked: false,
      noneConfigured: true,
      fellBack: true,
      degraded: 'same',
    });
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
    // N150: no other model in the list, so no wait: the list order, with the fall flagged.
    expect(result.selected?.id).toBe('claude-opus-low@claude-code/pessoal');
    expect(result.wait).toBeNull();
    expect(result.crossCheck).toMatchObject({ noneConfigured: true, degraded: 'same' });
    expect(reasonsOf(result)).toEqual([]);
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

describe('selection.strict_unavailable: a strict cross-review with only the provider of the work free (N135)', () => {
  const worked: WorkedBy = { provider: 'anthropic', model: 'claude-opus' };
  const strictSetup = (strictUnavailable: SelectionSettings['strictUnavailable']): Setup => ({
    list: [executor(OPUS_A), executor(SOL)],
    role: 'reviewer',
    workedBy: worked,
    settings: { crossCheck: 'require_other_provider', strictUnavailable },
    facts: { [SOL]: { quota: exhausted(4_000) } },
  });

  it('defaults to wait_notify', () => {
    expect(DEFAULT_SELECTION_SETTINGS.strictUnavailable).toBe('wait_notify');
  });

  it('wait_notify waits and flags the wait, so the Producer is told', () => {
    const result = select(strictSetup('wait_notify'));
    expect(result.selected).toBeNull();
    expect(result.wait).toEqual({ mode: 'next', on: [SOL], until: 4_000, notify: true });
    expect(result.crossCheck).toMatchObject({ blocked: true, fellBack: false });
    expect(reasonsOf(result)).toEqual([
      [OPUS_A, 'same_provider'],
      [SOL, 'quota'],
    ]);
  });

  it('wait waits the same way, with no flag', () => {
    const result = select(strictSetup('wait'));
    expect(result.selected).toBeNull();
    expect(result.wait).toEqual({ mode: 'next', on: [SOL], until: 4_000, notify: false });
    expect(result.crossCheck.blocked).toBe(true);
  });

  it('fallback_prefer goes back to the provider of the work, as prefer_other_provider does', () => {
    const result = select(strictSetup('fallback_prefer'));
    expect(result.selected?.id).toBe(OPUS_A);
    expect(result.wait).toBeNull();
    expect(result.crossCheck).toMatchObject({
      mode: 'require_other_provider',
      blocked: false,
      fellBack: true,
    });
    expect(reasonsOf(result)).toEqual([[SOL, 'quota']]);
  });

  it('fallback_prefer in other_model goes back to the same model', () => {
    const result = select({
      ...strictSetup('fallback_prefer'),
      settings: { crossCheck: 'other_model', strictUnavailable: 'fallback_prefer' },
      list: [executor(OPUS_A)],
    });
    expect(result.selected?.id).toBe(OPUS_A);
    expect(result.crossCheck.fellBack).toBe(true);
  });

  it('fallback_prefer still prefers another provider while there is one', () => {
    const result = select({
      ...strictSetup('fallback_prefer'),
      facts: {},
    });
    expect(result.selected?.id).toBe(SOL);
    expect(result.crossCheck.fellBack).toBe(false);
  });

  it('does not flag a wait the cross-review does not cause', () => {
    // The provider of the work is down as well: nothing is held back by the strict mode.
    const result = select({
      ...strictSetup('wait_notify'),
      facts: { [SOL]: { quota: exhausted(4_000) }, [OPUS_A]: { healthy: false } },
    });
    expect(result.selected).toBeNull();
    expect(result.wait?.notify).toBe(false);
    expect(result.crossCheck.blocked).toBe(false);
  });

  it('does not touch prefer_other_provider, off or an Executor that is chosen', () => {
    const chosen = select({ ...strictSetup('wait_notify'), facts: {} });
    expect(chosen.selected?.id).toBe(SOL);
    expect(chosen.crossCheck.blocked).toBe(false);
    for (const crossCheck of ['prefer_other_provider', 'off'] as const) {
      const result = select({
        ...strictSetup('wait_notify'),
        settings: { crossCheck, strictUnavailable: 'wait_notify' },
      });
      expect(result.selected?.id).toBe(OPUS_A);
      expect(result.crossCheck.blocked).toBe(false);
    }
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
    expect(reasonsOf({ ...result })).toEqual([[SOL, 'same_provider']]);
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

describe('selection.same_provider_fallback: the cross-review back at the provider of the work (N150)', () => {
  const OPUS_LOW_A = 'claude-opus-low@claude-code/empresa';
  const OPUS_LOW_B = 'claude-opus-low@claude-code/pessoal';
  const SONNET_MED_A = 'claude-sonnet-medium@claude-code/empresa';
  const SONNET_MED_B = 'claude-sonnet-medium@claude-code/pessoal';
  const SONNET_HIGH_A = 'claude-sonnet-high@claude-code/empresa';
  const HAIKU_HIGH_A = 'claude-haiku-high@claude-code/empresa';
  // The work: sonnet (large) at medium effort, on the account `empresa`.
  const worked: WorkedBy = {
    provider: 'anthropic',
    model: 'claude-sonnet',
    effort: 'medium',
    profile: 'claude-code/empresa',
  };
  const dry = { quota: exhausted(9_000) };
  // Nobody of another provider: every Executor of the list conflicts. The list order is the
  // opposite of the steps, so a step that works is not the list order.
  const only = (
    mode: SelectionSettings['sameProviderFallback'],
    facts: NonNullable<Setup['facts']> = {},
    settings: Partial<SelectionSettings> = {},
  ) =>
    select({
      list: [SONNET_MED_A, HAIKU_HIGH_A, SONNET_HIGH_A, OPUS_LOW_A].map((id) => executor(id)),
      role: 'reviewer',
      workedBy: worked,
      facts,
      settings: { sameProviderFallback: mode, ...settings },
    });

  it('defaults to stronger_then_effort and prefer_other', () => {
    expect(DEFAULT_SELECTION_SETTINGS.sameProviderFallback).toBe('stronger_then_effort');
    expect(DEFAULT_SELECTION_SETTINGS.sameProviderAccount).toBe('prefer_other');
    expect(DEFAULT_SELECTION_SETTINGS.modelTiers).toEqual({});
  });

  it('stronger_then_effort: a stronger model first, even behind the others in the list', () => {
    const result = only('stronger_then_effort');
    expect(result.selected?.id).toBe(OPUS_LOW_A);
    expect(result.wait).toBeNull();
    expect(result.crossCheck).toMatchObject({
      applied: true,
      fellBack: true,
      degraded: 'stronger_model',
      noneConfigured: false,
      blocked: false,
    });
  });

  it('stronger_then_effort: a stronger model without quota goes down to the higher effort, no wait', () => {
    const result = only('stronger_then_effort', { [OPUS_LOW_A]: dry });
    expect(result.selected?.id).toBe(SONNET_HIGH_A);
    expect(result.crossCheck.degraded).toBe('higher_effort');
    // The reason of the step above is the real one, and the haiku and the same effort are kept
    // for a later step, not for the quota.
    expect(result.skipped.find((s) => s.executor === OPUS_LOW_A)).toMatchObject({
      reason: 'quota',
    });
    expect(result.skipped.find((s) => s.executor === SONNET_MED_A)?.reason).toBe('same_provider');
  });

  it('stronger_then_effort: both steps up without quota go down to any, in the list order', () => {
    const result = only('stronger_then_effort', { [OPUS_LOW_A]: dry, [SONNET_HIGH_A]: dry });
    expect(result.selected?.id).toBe(SONNET_MED_A);
    expect(result.crossCheck.degraded).toBe('same');
    // The ones behind the pick in the list are not skipped; the two steps up carry the real reason.
    expect(reasonsOf(result)).toEqual([
      [SONNET_HIGH_A, 'quota'],
      [OPUS_LOW_A, 'quota'],
    ]);
  });

  it('stronger_model: skips the effort step and goes to any', () => {
    expect(only('stronger_model').selected?.id).toBe(OPUS_LOW_A);
    const down = only('stronger_model', { [OPUS_LOW_A]: dry });
    expect(down.selected?.id).toBe(SONNET_MED_A);
    expect(down.crossCheck.degraded).toBe('same');
  });

  it('higher_effort: the same model at a higher effort, even with a stronger model free', () => {
    const result = only('higher_effort');
    expect(result.selected?.id).toBe(SONNET_HIGH_A);
    expect(result.crossCheck.degraded).toBe('higher_effort');
    const down = only('higher_effort', { [SONNET_HIGH_A]: dry });
    expect(down.selected?.id).toBe(SONNET_MED_A);
    expect(down.crossCheck.degraded).toBe('same');
  });

  it('any: the list order, as before', () => {
    const result = only('any');
    expect(result.selected?.id).toBe(SONNET_MED_A);
    expect(result.crossCheck).toMatchObject({ fellBack: true, degraded: 'same' });
  });

  it('the top: nothing stronger and no higher effort falls to any', () => {
    const result = select({
      list: [executor(SONNET_HIGH_A), executor('claude-opus-high@claude-code/empresa')],
      role: 'critic',
      workedBy: { provider: 'anthropic', model: 'claude-opus', effort: 'high' },
    });
    expect(result.selected?.id).toBe(SONNET_HIGH_A);
    expect(result.crossCheck).toMatchObject({ fellBack: true, degraded: 'same' });
  });

  it('with another provider free, the fall does not happen and degraded is null', () => {
    const result = select({
      list: [executor(OPUS_LOW_A), executor(SOL)],
      role: 'reviewer',
      workedBy: worked,
    });
    expect(result.selected?.id).toBe(SOL);
    expect(result.crossCheck).toMatchObject({
      fellBack: false,
      degraded: null,
      sameAccount: false,
    });
  });

  it('applies to the strict mode with fallback_prefer', () => {
    const result = select({
      list: [executor(SONNET_MED_A), executor(OPUS_LOW_A), executor(SOL)],
      role: 'reviewer',
      workedBy: worked,
      facts: { [SOL]: dry },
      settings: { crossCheck: 'require_other_provider', strictUnavailable: 'fallback_prefer' },
    });
    expect(result.selected?.id).toBe(OPUS_LOW_A);
    expect(result.crossCheck).toMatchObject({
      degraded: 'stronger_model',
      noneConfigured: false,
      blocked: false,
    });
  });

  it('does not apply to the strict mode that waits, when another provider exists but is dry', () => {
    const result = select({
      list: [executor(SONNET_MED_A), executor(OPUS_LOW_A), executor(SOL)],
      role: 'reviewer',
      workedBy: worked,
      facts: { [SOL]: dry },
      settings: { crossCheck: 'require_other_provider', strictUnavailable: 'wait_notify' },
    });
    expect(result.selected).toBeNull();
    expect(result.wait).toMatchObject({ on: [SOL], until: 9_000, notify: true });
    expect(result.crossCheck).toMatchObject({
      blocked: true,
      noneConfigured: false,
      degraded: null,
    });
  });

  describe('noneConfigured: nobody in the list satisfies the cross-review, so nothing to wait for', () => {
    it.each(['wait', 'wait_notify', 'fallback_prefer'] as const)(
      'require_other_provider with strict_unavailable %s applies the fall at once',
      (strictUnavailable) => {
        const result = select({
          list: [executor(SONNET_MED_A), executor(OPUS_LOW_A)],
          role: 'reviewer',
          workedBy: worked,
          settings: { crossCheck: 'require_other_provider', strictUnavailable },
        });
        expect(result.selected?.id).toBe(OPUS_LOW_A);
        expect(result.wait).toBeNull();
        expect(result.crossCheck).toMatchObject({
          noneConfigured: true,
          blocked: false,
          fellBack: true,
          degraded: 'stronger_model',
        });
      },
    );

    it.each(['wait', 'wait_notify', 'fallback_prefer'] as const)(
      'other_model with strict_unavailable %s applies the fall at once, by the effort',
      (strictUnavailable) => {
        // Every model of the list is the one of the work: no stronger model by definition, so the
        // step of the higher effort, and then any [proposta].
        const result = select({
          list: [executor(SONNET_MED_B), executor(SONNET_HIGH_A)],
          role: 'critic',
          workedBy: worked,
          settings: { crossCheck: 'other_model', strictUnavailable },
        });
        expect(result.selected?.id).toBe(SONNET_HIGH_A);
        expect(result.wait).toBeNull();
        expect(result.crossCheck).toMatchObject({
          noneConfigured: true,
          blocked: false,
          degraded: 'higher_effort',
        });
      },
    );

    it('still waits when the whole fall is unavailable, with the real reasons', () => {
      const result = select({
        list: [executor(SONNET_MED_A), executor(OPUS_LOW_A)],
        role: 'reviewer',
        workedBy: worked,
        facts: { [SONNET_MED_A]: dry, [OPUS_LOW_A]: { quota: exhausted(5_000) } },
        settings: { crossCheck: 'require_other_provider' },
      });
      expect(result.selected).toBeNull();
      expect(result.wait?.until).toBe(5_000);
      expect(result.crossCheck.noneConfigured).toBe(true);
      expect(reasonsOf(result)).toEqual([
        [SONNET_MED_A, 'quota'],
        [OPUS_LOW_A, 'quota'],
      ]);
    });

    it('is not marked in prefer_other_provider, which never waits for it', () => {
      const result = select({
        list: [executor(SONNET_MED_A)],
        role: 'reviewer',
        workedBy: worked,
      });
      expect(result.crossCheck).toMatchObject({ noneConfigured: false, fellBack: true });
    });

    it('is not marked when the list is empty', () => {
      const result = select({
        list: [],
        role: 'reviewer',
        workedBy: worked,
        settings: { crossCheck: 'require_other_provider' },
      });
      expect(result.crossCheck.noneConfigured).toBe(false);
    });
  });

  describe('the strength of the model', () => {
    const MINIMAX_M2 = 'minimax-m2-medium@opencode/minimax-api';
    const MINIMAX_M3 = 'minimax-m3-medium@opencode/minimax-api';
    const minimax = (
      mode: SelectionSettings['sameProviderFallback'],
      over: Partial<SelectionSettings> = {},
    ) =>
      select({
        list: [executor(MINIMAX_M2, 'minimax'), executor(MINIMAX_M3, 'minimax')],
        role: 'reviewer',
        workedBy: { provider: 'minimax', model: 'minimax-m2', effort: 'medium' },
        settings: { sameProviderFallback: mode, ...over },
      });

    it('a provider with no tiers skips the step of the stronger model', () => {
      const result = minimax('stronger_then_effort');
      // m3 is another model, not a higher effort of the same one: no step matches, so any.
      expect(result.selected?.id).toBe(MINIMAX_M2);
      expect(result.crossCheck.degraded).toBe('same');
    });

    it('a tier declared in the configuration makes a model stronger', () => {
      const result = minimax('stronger_then_effort', {
        modelTiers: { 'minimax-m2': 'medium', 'minimax-m3': 'large' },
      });
      expect(result.selected?.id).toBe(MINIMAX_M3);
      expect(result.crossCheck.degraded).toBe('stronger_model');
    });

    it('the same tier is not stronger', () => {
      const result = minimax('stronger_then_effort', {
        modelTiers: { 'minimax-m2': 'large', 'minimax-m3': 'large' },
      });
      expect(result.selected?.id).toBe(MINIMAX_M2);
      expect(result.crossCheck.degraded).toBe('same');
    });

    it('a tier on one side only is not enough', () => {
      expect(
        minimax('stronger_model', { modelTiers: { 'minimax-m3': 'frontier' } }).crossCheck.degraded,
      ).toBe('same');
      expect(
        minimax('stronger_model', { modelTiers: { 'minimax-m2': 'small' } }).crossCheck.degraded,
      ).toBe('same');
    });

    it('a tier of the configuration replaces the built-in one', () => {
      // Built in: sonnet is large and opus is frontier. Declared: opus is large too, so it is not
      // stronger and the fall goes down to the higher effort.
      const result = only('stronger_then_effort', {}, { modelTiers: { opus: 'large' } });
      expect(result.selected?.id).toBe(SONNET_HIGH_A);
      expect(result.crossCheck.degraded).toBe('higher_effort');
    });

    it('the built-in ladders hold: haiku is not stronger than sonnet, opus is', () => {
      // The haiku is first in the list and free: the weaker model is not a step up.
      const list = [HAIKU_HIGH_A, SONNET_MED_A, OPUS_LOW_A].map((id) => executor(id));
      const base = { list, role: 'reviewer', workedBy: worked } as const;
      expect(select(base).selected?.id).toBe(OPUS_LOW_A);
      const down = select({ ...base, facts: { [OPUS_LOW_A]: dry } });
      expect(down.selected?.id).toBe(HAIKU_HIGH_A);
      expect(down.crossCheck.degraded).toBe('same');
    });
  });

  describe('selection.same_provider_account: several accounts of one provider', () => {
    const twoAccounts = (
      facts: NonNullable<Setup['facts']>,
      mode: SelectionSettings['sameProviderAccount'],
      list = [OPUS_LOW_A, OPUS_LOW_B],
    ) =>
      select({
        list: list.map((id) => executor(id)),
        role: 'reviewer',
        workedBy: worked,
        facts,
        settings: { sameProviderAccount: mode },
      });

    it('another account of the provider does not satisfy the cross-review', () => {
      const result = twoAccounts({}, 'prefer_other', [SONNET_MED_B]);
      expect(result.crossCheck).toMatchObject({ fellBack: true, applied: true });
    });

    it('prefer_other: inside the step, the other account comes first', () => {
      const result = twoAccounts({}, 'prefer_other');
      expect(result.selected?.id).toBe(OPUS_LOW_B);
      expect(result.crossCheck).toMatchObject({ degraded: 'stronger_model', sameAccount: false });
    });

    it('strategy: the account of the work has no special treatment', () => {
      const result = twoAccounts({}, 'strategy');
      expect(result.selected?.id).toBe(OPUS_LOW_A);
      expect(result.crossCheck.sameAccount).toBe(true);
    });

    it('prefer_other: the preferred account without quota falls to the one of the work, same step', () => {
      const result = twoAccounts({ [OPUS_LOW_B]: dry }, 'prefer_other');
      expect(result.selected?.id).toBe(OPUS_LOW_A);
      expect(result.crossCheck).toMatchObject({ degraded: 'stronger_model', sameAccount: true });
      expect(result.skipped.find((s) => s.executor === OPUS_LOW_B)?.reason).toBe('quota');
    });

    it('the step comes before the account: a stronger model on the own account beats the same model elsewhere', () => {
      const result = twoAccounts({}, 'prefer_other', [SONNET_MED_B, OPUS_LOW_A]);
      expect(result.selected?.id).toBe(OPUS_LOW_A);
      expect(result.crossCheck.degraded).toBe('stronger_model');
    });

    it('sameAccount is false when the account of the work is not known', () => {
      const result = select({
        list: [executor(OPUS_LOW_A), executor(OPUS_LOW_B)],
        role: 'reviewer',
        workedBy: { provider: 'anthropic', model: 'claude-sonnet', effort: 'medium' },
      });
      expect(result.selected?.id).toBe(OPUS_LOW_A);
      expect(result.crossCheck.sameAccount).toBe(false);
    });
  });
});

describe('profiles.rotate_on_exhaustion: another account of the provider that ran out (N157)', () => {
  const SOL_2 = 'codex-sol-high@codex/conta-2';
  const SOL_1_LOW = 'codex-sol-low@codex/conta-1';
  const GPT_CHAT = 'gpt-5-high@opencode/chatgpt';
  const GPT_API = 'gpt-5-high@opencode/openai-api';
  const RESET = 1_800_000_000_000;
  const openai = (id: string): ResolvedExecutor => executor(id, 'openai');

  it('is off for OpenAI by default and on for every other provider', () => {
    expect(DEFAULT_SELECTION_SETTINGS.rotateOnExhaustion).toEqual({ openai: 'off' });
  });

  it('off: the work does not pass to another OpenAI subscription; it goes to another provider', () => {
    const result = select({
      list: [executor(SOL), executor(SOL_2), executor(OPUS_A)],
      facts: { [SOL]: { quota: exhausted(RESET) } },
    });
    expect(result.selected?.id).toBe(OPUS_A);
    expect(reasonsOf(result)).toEqual([
      [SOL, 'quota'],
      [SOL_2, 'rotation'],
    ]);
    const held = result.skipped.find((skipped) => skipped.executor === SOL_2);
    expect(held?.detail).toBe(
      'profiles.rotate_on_exhaustion.openai is off and codex/conta-1 is exhausted',
    );
    expect(held?.untilReset).toBe(RESET);
    expect(result.rotated).toBeNull();
  });

  it('off: with no other provider the role waits for the reset of the account that ran out', () => {
    const result = select({
      list: [executor(SOL), executor(SOL_2)],
      facts: { [SOL]: { quota: exhausted(RESET) } },
    });
    expect(result.selected).toBeNull();
    expect(result.wait).toEqual({ mode: 'next', on: [SOL, SOL_2], until: RESET, notify: false });
    const waited = select({
      list: [executor(SOL), executor(SOL_2)],
      facts: { [SOL]: { quota: exhausted(RESET) } },
      whenExhausted: 'wait',
    });
    expect(waited.wait?.on).toEqual([SOL]);
  });

  it('off: an OpenCode profile with the ChatGPT login counts as an OpenAI subscription', () => {
    const result = select({
      list: [executor(SOL), openai(GPT_CHAT), executor(OPUS_A)],
      facts: { [SOL]: { quota: exhausted(RESET) } },
    });
    expect(result.selected?.id).toBe(OPUS_A);
    expect(reasonsOf(result)).toEqual([
      [SOL, 'quota'],
      [GPT_CHAT, 'rotation'],
    ]);
  });

  it('off: an API profile of OpenAI is not held, and an exhausted API profile holds nobody', () => {
    const api = select({
      list: [executor(SOL), openai(GPT_API)],
      facts: { [SOL]: { quota: exhausted(RESET) }, [GPT_API]: { profileKind: 'api' } },
    });
    expect(api.selected?.id).toBe(GPT_API);
    const apiRanOut = select({
      list: [openai(GPT_API), executor(SOL)],
      facts: { [GPT_API]: { profileKind: 'api', quota: exhausted(RESET) } },
    });
    expect(apiRanOut.selected?.id).toBe(SOL);
  });

  it('off: a spending cap (budget) holds nobody', () => {
    const result = select({
      list: [executor(SOL), executor(SOL_2)],
      facts: { [SOL]: { quota: exhausted(RESET, 'budget') } },
    });
    expect(result.selected?.id).toBe(SOL_2);
  });

  it('off: another model of the same account is not another account', () => {
    const result = select({
      list: [executor(SOL), executor(SOL_1_LOW), executor(SOL_2)],
      facts: { [SOL]: { quota: exhausted(RESET) } },
    });
    // The same profile is exhausted too in real life; here only the rule is under test.
    expect(result.selected?.id).toBe(SOL_1_LOW);
  });

  it('off: an account first in the order is not held by an exhausted one behind it', () => {
    const result = select({
      list: [executor(SOL_2), executor(SOL)],
      facts: { [SOL]: { quota: exhausted(RESET) } },
    });
    expect(result.selected?.id).toBe(SOL_2);
    expect(result.skipped).toEqual([]);
  });

  it('off: the account that ran out on the attempt before holds the retry (P15)', () => {
    // retry_diversity: rotate puts SOL_2 first; the account that failed still holds it.
    const result = select({
      list: [executor(SOL), executor(SOL_2), executor(OPUS_A)],
      facts: { [SOL]: { quota: exhausted(RESET) } },
      previousExecutor: SOL,
    });
    expect(result.selected?.id).toBe(OPUS_A);
    expect(reasonsOf(result)).toContainEqual([SOL_2, 'rotation']);
  });

  it('off: an Executor that already worked and left the list holds the baton (P18) and the failover (P20)', () => {
    const result = select({
      list: [executor(SOL_2), executor(OPUS_A)],
      earlier: [executor(SOL)],
      facts: { [SOL]: { quota: exhausted(RESET) } },
    });
    expect(result.selected?.id).toBe(OPUS_A);
    expect(reasonsOf(result)).toEqual([[SOL_2, 'rotation']]);
    // An earlier Executor whose account did not run out holds nobody.
    const fine = select({ list: [executor(SOL_2), executor(OPUS_A)], earlier: [executor(SOL)] });
    expect(fine.selected?.id).toBe(SOL_2);
  });

  it('off: the facts of an earlier Executor are required', () => {
    expect(() =>
      selectExecutor({
        role: { role: 'author', executors: [executor(SOL_2)], whenExhausted: 'next' },
        facts: new Map([[SOL_2, facts()]]),
        settings: DEFAULT_SELECTION_SETTINGS,
        earlier: [executor(SOL)],
      }),
    ).toThrow(InvalidInput);
  });

  it('off: other providers are not held by default', () => {
    const result = select({
      list: [executor(OPUS_A), executor(OPUS_B)],
      facts: { [OPUS_A]: { quota: exhausted(RESET) } },
    });
    expect(result.selected?.id).toBe(OPUS_B);
    expect(result.rotated).toEqual({
      provider: 'anthropic',
      from: 'claude-code/empresa',
      to: 'claude-code/pessoal',
    });
  });

  it('on: the work rotates to another OpenAI account and the result says so', () => {
    const result = select({
      list: [executor(SOL), executor(SOL_2), executor(OPUS_A)],
      facts: { [SOL]: { quota: exhausted(RESET) } },
      settings: { rotateOnExhaustion: { openai: 'on' } },
    });
    expect(result.selected?.id).toBe(SOL_2);
    expect(reasonsOf(result)).toEqual([[SOL, 'quota']]);
    expect(result.rotated).toEqual({
      provider: 'openai',
      from: 'codex/conta-1',
      to: 'codex/conta-2',
    });
  });

  it('off for another provider holds it the same way', () => {
    const result = select({
      list: [executor(OPUS_A), executor(OPUS_B), executor(SOL)],
      facts: { [OPUS_A]: { quota: exhausted(RESET) } },
      settings: { rotateOnExhaustion: { anthropic: 'off' } },
    });
    expect(result.selected?.id).toBe(SOL);
    expect(reasonsOf(result)).toEqual([
      [OPUS_A, 'quota'],
      [OPUS_B, 'rotation'],
    ]);
  });

  it('the ports give the kind of the profile to the facts', async () => {
    const ports: SelectionPorts = {
      profile: (id) =>
        id === 'opencode/openai-api' ? { state: 'active', kind: 'api' } : { state: 'active' },
      health: () => true,
      quota: () => OK,
      admission: () => FREE,
      contextWindow: () => undefined,
    };
    const gathered = await gatherSelectionFacts(ports, [openai(GPT_API), executor(SOL)]);
    expect(gathered.get(GPT_API)?.profileKind).toBe('api');
    expect(gathered.get(SOL)?.profileKind).toBeUndefined();
  });
});
