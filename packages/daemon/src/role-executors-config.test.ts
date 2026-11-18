// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

const refusal = (yaml: string): string => {
  try {
    parseConfig(yaml);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInput);
    return (error as Error).message;
  }
  throw new Error('expected the configuration to be refused');
};

describe('the defaults', () => {
  it('change nothing: no Executor, no list, the modes of 5.7', () => {
    const config = parseConfig('');
    expect(config.executors).toEqual({
      cross_client: 'api_only',
      on_register: 'ask',
      test_session: 'off',
      entries: {},
      budgets: {},
    });
    expect(config.roles).toEqual({});
    expect(config.orchestration.executor).toBeUndefined();
  });
});

describe('executors.test_session (P14, [proposta])', () => {
  it('is off by default and takes run', () => {
    expect(parseConfig('').executors.test_session).toBe('off');
    expect(parseConfig('executors:\n  test_session: run\n').executors.test_session).toBe('run');
    expect(parseConfig('executors:\n  test_session: off\n').executors.test_session).toBe('off');
  });

  it('refuses a mode it does not know, naming the key', () => {
    expect(refusal('executors:\n  test_session: always\n')).toMatch(/executors\.test_session: /u);
  });
});

describe('executors', () => {
  const yaml = `
executors:
  cross_client: any
  on_register: preset_only
  claude-opus-high@claude-code/empresa:
    client: claude-code
    profile: empresa
    model: claude-opus
    effort: high
  minimax-m2-medium@opencode/minimax-api:
    client: opencode
    profile: minimax-api
    model: minimax-m2
    effort: medium
    provider: minimax
  gemma4@opencode/local:
    client: opencode
    profile: local
    model: gemma4
`;

  it('reads the modes and the Executors, the provider settled by the client', () => {
    const { executors } = parseConfig(yaml);
    expect(executors.cross_client).toBe('any');
    expect(executors.on_register).toBe('preset_only');
    expect(executors.entries['claude-opus-high@claude-code/empresa']).toEqual({
      id: 'claude-opus-high@claude-code/empresa',
      client: 'claude-code',
      profile: 'empresa',
      model: 'claude-opus',
      effort: 'high',
      provider: 'anthropic',
    });
    expect(executors.entries['minimax-m2-medium@opencode/minimax-api']?.provider).toBe('minimax');
    expect(executors.entries['gemma4@opencode/local']).toMatchObject({
      effort: null,
      provider: 'unknown',
    });
  });

  it('reads preset_expand (N136): absent leaves the Executor out of the entry, false is kept', () => {
    const { entries } = parseConfig(`
executors:
  claude-opus-high@claude-code/empresa:
    client: claude-code
    profile: empresa
    model: claude-opus
    effort: high
  gemma4@opencode/local:
    client: opencode
    profile: local
    model: gemma4
    preset_expand: false
  codex-sol-high@codex/conta-1:
    client: codex
    profile: conta-1
    model: codex-sol
    effort: high
    preset_expand: true
`).executors;
    expect(entries['claude-opus-high@claude-code/empresa']?.presetExpand).toBeUndefined();
    expect(entries['gemma4@opencode/local']?.presetExpand).toBe(false);
    expect(entries['codex-sol-high@codex/conta-1']?.presetExpand).toBe(true);
    expect(
      refusal(
        'executors:\n  gemma4@opencode/local:\n    client: opencode\n    profile: local\n    model: gemma4\n    preset_expand: never\n',
      ),
    ).toMatch(/executors\.gemma4@opencode\/local\.preset_expand/u);
  });

  it('refuses a malformed name, naming the key', () => {
    expect(
      refusal('executors:\n  opus-high:\n    client: a\n    profile: b\n    model: m\n'),
    ).toMatch(/executors\.opus-high: /u);
  });

  it('refuses a name that disagrees with its fields', () => {
    const message = refusal(
      'executors:\n  claude-opus-high@claude-code/empresa:\n    client: claude-code\n    profile: outra\n    model: claude-opus\n    effort: high\n',
    );
    expect(message).toMatch(
      /executors\.claude-opus-high@claude-code\/empresa: the name says claude-code\/empresa/u,
    );
    const effort = refusal(
      'executors:\n  claude-opus-high@claude-code/empresa:\n    client: claude-code\n    profile: empresa\n    model: claude-opus\n    effort: low\n',
    );
    expect(effort).toMatch(/\.effort: the name says effort high/u);
  });

  it('refuses an effort outside low, medium and high', () => {
    expect(
      refusal(
        'executors:\n  m-high@opencode/x:\n    client: opencode\n    profile: x\n    model: m\n    effort: max\n',
      ),
    ).toMatch(/effort/u);
  });

  it('refuses a provider that the client does not allow, naming the key', () => {
    expect(
      refusal(
        'executors:\n  claude-opus-high@claude-code/empresa:\n    client: claude-code\n    profile: empresa\n    model: claude-opus\n    effort: high\n    provider: minimax\n',
      ),
    ).toMatch(/executors\.claude-opus-high@claude-code\/empresa\.provider: "minimax" is refused/u);
  });

  it('refuses a bad mode, naming the key', () => {
    expect(refusal('executors:\n  cross_client: sometimes\n')).toMatch(
      /executors\.cross_client: .*"api_only"/u,
    );
    expect(refusal('executors:\n  on_register: always\n')).toMatch(/executors\.on_register: /u);
  });
});

describe('roles', () => {
  it('reads the lists, the modes and the minimums', () => {
    const { roles } = parseConfig(`
roles:
  preset: balanced
  capability_check: block
  allowed_profiles: [claude-code/empresa, codex/conta-1]
  critic:
    executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1]
    when_exhausted: wait
    requires:
      context: 200k
      reasoning: true
  actor:
    requires: { context: 64000 }
`);
    expect(roles.preset).toBe('balanced');
    expect(roles.capability_check).toBe('block');
    expect(roles.allowed_profiles).toEqual(['claude-code/empresa', 'codex/conta-1']);
    expect(roles.critic?.executors).toHaveLength(2);
    expect(roles.critic?.when_exhausted).toBe('wait');
    expect(roles.critic?.requires).toEqual({ context: 200_000, reasoning: true });
    expect(roles.actor?.requires).toEqual({ context: 64_000 });
  });

  it('refuses a malformed Executor name in a list, with the index', () => {
    expect(
      refusal('roles:\n  author:\n    executors: [claude-opus-high@claude-code/empresa, opus]\n'),
    ).toMatch(/roles\.author\.executors\.1: /u);
  });

  it('refuses an empty list', () => {
    expect(refusal('roles:\n  author:\n    executors: []\n')).toMatch(
      /roles\.author\.executors: the list is empty/u,
    );
  });

  it('refuses an Executor twice in a list', () => {
    expect(
      refusal(
        'roles:\n  author:\n    executors: [codex-sol-high@codex/conta-1, codex-sol-high@codex/conta-1]\n',
      ),
    ).toMatch(/roles\.author\.executors\.1: .*appears twice/u);
  });

  it('refuses a repeated profile and an empty list in allowed_profiles', () => {
    expect(refusal('roles:\n  allowed_profiles: [codex/conta-1, codex/conta-1]\n')).toMatch(
      /roles\.allowed_profiles\.1: profile "codex\/conta-1" appears twice/u,
    );
    expect(refusal('roles:\n  allowed_profiles: []\n')).toMatch(/roles\.allowed_profiles: /u);
    expect(refusal('roles:\n  allowed_profiles: [conta-1]\n')).toMatch(
      /roles\.allowed_profiles\.0: /u,
    );
  });

  it('refuses bad values, naming the key', () => {
    expect(refusal('roles:\n  preset: premium\n')).toMatch(/roles\.preset: /u);
    expect(refusal('roles:\n  capability_check: strict\n')).toMatch(/roles\.capability_check: /u);
    expect(refusal('roles:\n  author:\n    when_exhausted: forever\n')).toMatch(
      /roles\.author\.when_exhausted: /u,
    );
    expect(refusal('roles:\n  author:\n    requires:\n      context: huge\n')).toMatch(
      /roles\.author\.requires\.context: "huge" is not a size/u,
    );
    expect(refusal('roles:\n  author:\n    requires:\n      thinking: true\n')).toMatch(
      /roles\.author\.requires/u,
    );
  });
});

describe('selection (5.7; P15)', () => {
  it('has the defaults of the architecture and of N124 when the block is absent', () => {
    expect(parseConfig('').selection).toEqual({
      strategy: 'ordered',
      cross_check: 'prefer_other_provider',
      unknown_quota: 'allow',
      near_limit: 'keep_order',
      retry_diversity: 'rotate',
      context_reserve: 0,
      unregistered_profiles: 'allow',
      recheck_every: 30_000,
      director_wait: 'wait',
      waiting_holds_slot: false,
      strict_unavailable: 'wait_notify',
      same_provider_fallback: 'stronger_then_effort',
      same_provider_account: 'prefer_other',
    });
    expect(parseConfig('').models).toEqual({});
  });

  it('takes every key, and the reserve as a size', () => {
    const { selection } = parseConfig(`
selection:
  strategy: round_robin
  cross_check: require_other_provider
  unknown_quota: skip
  near_limit: last
  retry_diversity: forward_only
  context_reserve: 8k
  unregistered_profiles: refuse
  recheck_every: 2m
  director_wait: fail
  waiting_holds_slot: true
  strict_unavailable: fallback_prefer
  same_provider_fallback: higher_effort
  same_provider_account: strategy
`);
    expect(selection).toEqual({
      strategy: 'round_robin',
      cross_check: 'require_other_provider',
      unknown_quota: 'skip',
      near_limit: 'last',
      retry_diversity: 'forward_only',
      context_reserve: 8_000,
      unregistered_profiles: 'refuse',
      recheck_every: 120_000,
      director_wait: 'fail',
      waiting_holds_slot: true,
      strict_unavailable: 'fallback_prefer',
      same_provider_fallback: 'higher_effort',
      same_provider_account: 'strategy',
    });
  });

  it('takes every mode of the fall to the provider of the work, and refuses the rest (N150)', () => {
    for (const mode of ['stronger_then_effort', 'stronger_model', 'higher_effort', 'any']) {
      expect(
        parseConfig(`selection:\n  same_provider_fallback: ${mode}\n`).selection
          .same_provider_fallback,
      ).toBe(mode);
    }
    for (const mode of ['prefer_other', 'strategy']) {
      expect(
        parseConfig(`selection:\n  same_provider_account: ${mode}\n`).selection
          .same_provider_account,
      ).toBe(mode);
    }
    expect(refusal('selection:\n  same_provider_fallback: weaker\n')).toMatch(
      /selection\.same_provider_fallback: /u,
    );
    expect(refusal('selection:\n  same_provider_account: any\n')).toMatch(
      /selection\.same_provider_account: /u,
    );
  });

  it('declares the tier of a model, optional, on one scale (N150)', () => {
    const { models } = parseConfig(`
models:
  minimax-m3:
    tier: medium
  claude-opus:
    tier: frontier
  gemma: {}
`);
    expect(models).toEqual({
      'minimax-m3': { tier: 'medium' },
      'claude-opus': { tier: 'frontier' },
      gemma: {},
    });
    expect(refusal('models:\n  gemma:\n    tier: huge\n')).toMatch(/models\.gemma\.tier: /u);
    expect(refusal('models:\n  gemma:\n    rank: 3\n')).toMatch(/models\.gemma/u);
  });

  it('takes recheck_every as a duration or off, and refuses the rest (P16)', () => {
    expect(parseConfig('selection:\n  recheck_every: 45s\n').selection.recheck_every).toBe(45_000);
    expect(parseConfig('selection:\n  recheck_every: off\n').selection.recheck_every).toBe(0);
    expect(refusal('selection:\n  recheck_every: soon\n')).toMatch(/selection\.recheck_every/u);
    expect(refusal('selection:\n  recheck_every: 0s\n')).toMatch(/selection\.recheck_every/u);
    expect(refusal('selection:\n  unregistered_profiles: maybe\n')).toMatch(
      /selection\.unregistered_profiles: /u,
    );
    expect(refusal('selection:\n  director_wait: never\n')).toMatch(/selection\.director_wait: /u);
    expect(refusal('selection:\n  waiting_holds_slot: sometimes\n')).toMatch(
      /selection\.waiting_holds_slot: /u,
    );
  });

  it('takes the other modes of the keys', () => {
    expect(parseConfig('selection:\n  strategy: most_headroom\n').selection.strategy).toBe(
      'most_headroom',
    );
    expect(parseConfig('selection:\n  cross_check: other_model\n').selection.cross_check).toBe(
      'other_model',
    );
    expect(parseConfig('selection:\n  cross_check: off\n').selection.cross_check).toBe('off');
    expect(parseConfig('selection:\n  retry_diversity: off\n').selection.retry_diversity).toBe(
      'off',
    );
    expect(parseConfig('selection:\n  near_limit: skip\n').selection.near_limit).toBe('skip');
    expect(
      parseConfig('selection:\n  strict_unavailable: wait\n').selection.strict_unavailable,
    ).toBe('wait');
  });

  it('refuses a mode it does not know, naming the key, and an unknown key', () => {
    expect(refusal('selection:\n  strategy: random\n')).toMatch(/selection\.strategy: /u);
    expect(refusal('selection:\n  cross_check: strict\n')).toMatch(/selection\.cross_check: /u);
    expect(refusal('selection:\n  unknown_quota: maybe\n')).toMatch(/selection\.unknown_quota: /u);
    expect(refusal('selection:\n  near_limit: first\n')).toMatch(/selection\.near_limit: /u);
    expect(refusal('selection:\n  retry_diversity: always\n')).toMatch(
      /selection\.retry_diversity: /u,
    );
    expect(refusal('selection:\n  context_reserve: huge\n')).toMatch(/selection\.context_reserve/u);
    expect(refusal('selection:\n  strict_unavailable: ask\n')).toMatch(
      /selection\.strict_unavailable: .*"wait_notify"/u,
    );
    expect(refusal('selection:\n  strategie: ordered\n')).toMatch(/selection/u);
  });
});

describe('the old format', () => {
  it('still loads next to the new keys', () => {
    const config = parseConfig(`
orchestration:
  executor: { client: claude-code, profile: empresa, model: sonnet }
  roles:
    author: { client: codex, profile: conta-1, model: gpt-6-sol, effort: high }
`);
    expect(config.orchestration.executor?.profile).toBe('empresa');
    expect(config.orchestration.roles.author?.client).toBe('codex');
  });
});
