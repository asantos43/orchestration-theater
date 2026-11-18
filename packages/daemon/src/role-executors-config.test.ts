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
    expect(config.executors).toEqual({ cross_client: 'api_only', on_register: 'ask', entries: {} });
    expect(config.roles).toEqual({});
    expect(config.orchestration.executor).toBeUndefined();
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
