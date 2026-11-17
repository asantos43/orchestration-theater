// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { InMemoryPromptSource } from '../testing/in-memory-prompt-source.js';
import { OFFICIAL_ROLES } from '../registries/roles.js';
import { OFFICIAL_TOOLS } from '../registries/tools.js';
import { assertValidPrompts, citedTools, validatePrompts } from './validate.js';

const toolNames = new Set(OFFICIAL_TOOLS.map((tool) => tool.name));
const registries = { roles: { list: () => OFFICIAL_ROLES }, tools: { list: () => OFFICIAL_TOOLS } };

function fullSet(overrides: Record<string, string> = {}): Record<string, string> {
  const prompts: Record<string, string> = {};
  for (const role of OFFICIAL_ROLES) prompts[role.id] = `You are the ${role.id}.`;
  return { ...prompts, ...overrides };
}

describe('citedTools', () => {
  it('finds tools written as a call or as the bare name of a known tool, once each', () => {
    const text = 'Use `run_tests(target)`, then `run_tests` again, and `submit` at the end.';
    expect(citedTools(text, toolNames)).toEqual(['run_tests', 'submit']);
  });

  it('finds an unknown tool only when it is written as a call', () => {
    expect(citedTools('Call `fly_away(now)`.', toolNames)).toEqual(['fly_away']);
    expect(citedTools('The field `blocked` and `open_questions` are data.', toolNames)).toEqual([]);
  });

  it('ignores names in plain prose and mixed-case code', () => {
    expect(
      citedTools('The Author uses submit_plan. Read `dependsOn` and `a.b`.', toolNames),
    ).toEqual([]);
  });
});

describe('validatePrompts', () => {
  it('has no problem when every role has a prompt that cites only its own tools', () => {
    const prompts = new Map(
      Object.entries(fullSet({ actor: 'Run `run_tests(target)` and `submit`.' })),
    );
    expect(validatePrompts(prompts, OFFICIAL_ROLES, OFFICIAL_TOOLS)).toEqual([]);
  });

  it('reports a tool of another role as tool_not_for_role, with the role as the entry', () => {
    const prompts = new Map(Object.entries(fullSet({ reviewer: 'Call `submit_plan(plan)`.' })));
    const problems = validatePrompts(prompts, OFFICIAL_ROLES, OFFICIAL_TOOLS);
    expect(problems).toEqual([
      expect.objectContaining({
        registry: 'prompts',
        entry: 'reviewer',
        code: 'tool_not_for_role',
      }),
    ]);
  });

  it('reports a tool that is in no registry as unknown_tool', () => {
    const prompts = new Map(Object.entries(fullSet({ actor: 'Call `fly_away(now)`.' })));
    expect(validatePrompts(prompts, OFFICIAL_ROLES, OFFICIAL_TOOLS)).toEqual([
      expect.objectContaining({ entry: 'actor', code: 'unknown_tool' }),
    ]);
  });

  it('reports a missing prompt, an empty one and a prompt for an unknown role', () => {
    const prompts = new Map(Object.entries(fullSet({ ghost: 'Boo.', critic: '   ' })));
    prompts.delete('author');
    const codes = validatePrompts(prompts, OFFICIAL_ROLES, OFFICIAL_TOOLS)
      .map((problem) => `${problem.entry}:${problem.code}`)
      .sort();
    expect(codes).toEqual(['author:missing_prompt', 'critic:empty_prompt', 'ghost:unknown_role']);
  });
});

describe('assertValidPrompts', () => {
  it('returns the prompts by role when they are valid', async () => {
    const prompts = await assertValidPrompts(new InMemoryPromptSource(fullSet()), registries);
    expect([...prompts.keys()].sort()).toEqual(OFFICIAL_ROLES.map((role) => role.id).sort());
  });

  it('throws InvalidInput in the registry format, naming every problem', async () => {
    const source = new InMemoryPromptSource(
      fullSet({ reviewer: 'Call `submit_plan(plan)`.', actor: 'Call `fly_away(now)`.' }),
    );
    const failure: unknown = await assertValidPrompts(source, registries).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'INVALID_INPUT' });
    const message = (failure as Error).message;
    expect(message).toContain('prompts/reviewer:');
    expect(message).toContain('[tool_not_for_role]');
    expect(message).toContain('prompts/actor:');
    expect(message).toContain('[unknown_tool]');
  });
});
