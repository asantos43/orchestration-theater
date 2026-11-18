// SPDX-License-Identifier: MPL-2.0
import {
  DEFAULT_SELECTION_SETTINGS,
  parseExecutorId,
  selectExecutor,
  type ExecutorEntry,
  type ExecutorFacts,
  type ResolvedExecutor,
} from '@otheater/core';
import { validateEventPayload } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import type { QuotaStatus, QuotaWindowState } from '../quota/state.js';
import { executorSelectedPayload, quotaFactOf, selectionSettingsOf } from './executor-selection.js';

const window = (usedPercent: number, fresh = true): QuotaWindowState => ({
  window: '5h',
  usedPercent,
  resetsAt: null,
  observedAt: 1_000,
  source: 'probe',
  fresh,
});

const status = (over: Partial<QuotaStatus> = {}): QuotaStatus => ({
  profile: 'claude-code/empresa',
  state: 'ok',
  cause: null,
  untilReset: null,
  windows: [],
  observedAt: null,
  nearLimitWindow: null,
  reason: '',
  ...over,
});

describe('selectionSettingsOf', () => {
  it('maps the keys of the configuration to the settings of the selector', () => {
    expect(selectionSettingsOf(parseConfig(''))).toEqual(DEFAULT_SELECTION_SETTINGS);
    expect(
      selectionSettingsOf(
        parseConfig(`
selection:
  strategy: most_headroom
  cross_check: other_model
  unknown_quota: skip
  near_limit: last
  retry_diversity: off
  strict_unavailable: fallback_prefer
  same_provider_fallback: stronger_model
  same_provider_account: strategy
  context_reserve: 4k
models:
  Minimax-M3:
    tier: large
  gemma: {}
`),
      ),
    ).toEqual({
      strategy: 'most_headroom',
      crossCheck: 'other_model',
      unknownQuota: 'skip',
      nearLimit: 'last',
      retryDiversity: 'off',
      strictUnavailable: 'fallback_prefer',
      sameProviderFallback: 'stronger_model',
      sameProviderAccount: 'strategy',
      modelTiers: { 'minimax-m3': 'large' },
      contextReserve: 4_000,
    });
  });
});

describe('quotaFactOf', () => {
  it('carries state, cause and the end of an exhaustion', () => {
    expect(quotaFactOf(status({ state: 'exhausted', cause: 'budget', untilReset: 9_000 }))).toEqual(
      {
        state: 'exhausted',
        cause: 'budget',
        untilReset: 9_000,
        headroom: null,
      },
    );
  });

  it('takes the headroom from the fullest fresh window, as a fraction', () => {
    expect(quotaFactOf(status({ windows: [window(20), window(60)] })).headroom).toBeCloseTo(0.4);
    expect(quotaFactOf(status({ windows: [window(100)] })).headroom).toBe(0);
  });

  it('ignores a stale window, and has no headroom when none is fresh', () => {
    expect(quotaFactOf(status({ windows: [window(10), window(90, false)] })).headroom).toBeCloseTo(
      0.9,
    );
    expect(quotaFactOf(status({ windows: [window(90, false)] })).headroom).toBeNull();
    expect(quotaFactOf(status()).headroom).toBeNull();
  });
});

describe('executorSelectedPayload', () => {
  const build = (id: string): ResolvedExecutor => {
    const parsed = parseExecutorId(id);
    const entry: ExecutorEntry = {
      id,
      client: parsed.client,
      profile: parsed.profile,
      model: parsed.model,
      effort: parsed.effort,
      provider: parsed.client === 'codex' ? 'openai' : 'anthropic',
    };
    return { id, entry, validity: 'valid', invalidReason: null, shortfalls: [], origin: 'config' };
  };
  const A = 'claude-opus-high@claude-code/empresa';
  const B = 'codex-sol-high@codex/conta-1';
  const facts = (over: Partial<ExecutorFacts> = {}): ExecutorFacts => ({
    profileState: 'active',
    healthy: true,
    quota: { state: 'ok', cause: null, untilReset: null, headroom: 0.5 },
    admission: { slot: 'free', ram: 'ok' },
    ...over,
  });
  const run = (first: Partial<ExecutorFacts>, second: Partial<ExecutorFacts> = {}) =>
    selectExecutor({
      role: { role: 'author', executors: [build(A), build(B)], whenExhausted: 'next' },
      facts: new Map([
        [A, facts(first)],
        [B, facts(second)],
      ]),
      settings: DEFAULT_SELECTION_SETTINGS,
    });
  const dry: Partial<ExecutorFacts> = {
    quota: { state: 'exhausted', cause: 'quota', untilReset: 5_000, headroom: 0 },
  };

  it('turns a selection into a valid event, with the skipped Executors', () => {
    const payload = executorSelectedPayload(run(dry), { playId: 'P1', now: 1_000 });
    expect(payload).toMatchObject({
      role: 'author',
      playId: 'P1',
      outcome: 'selected',
      executor: B,
      profile: 'codex/conta-1',
      waiting: null,
      occurredAt: 1_000,
    });
    expect(payload.skipped).toEqual([
      {
        executor: A,
        profile: 'claude-code/empresa',
        reason: 'quota',
        detail: 'exhausted',
        untilReset: 5_000,
      },
    ]);
    expect(validateEventPayload('executor.selected', 2, payload)).toEqual(payload);
  });

  it('turns a wait into a valid event: no Executor, and what it waits for', () => {
    const payload = executorSelectedPayload(run(dry, dry), { playId: null, now: 2_000 });
    expect(payload).toMatchObject({
      outcome: 'waiting',
      executor: null,
      profile: null,
      playId: null,
      waiting: { mode: 'next', on: [A, B], until: 5_000, notify: false },
    });
    expect(validateEventPayload('executor.selected', 2, payload)).toEqual(payload);
  });

  it('always carries the skipped list, empty when the first one was taken', () => {
    const payload = executorSelectedPayload(run({}), { playId: 'P1', now: 1 });
    expect(payload.executor).toBe(A);
    expect(payload.skipped).toEqual([]);
    expect(validateEventPayload('executor.selected', 2, payload)).toEqual(payload);
  });
});
