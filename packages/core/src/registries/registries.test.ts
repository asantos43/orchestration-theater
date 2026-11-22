// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InvalidInput } from '../errors.js';
import {
  buildRegistries,
  createEventRegistry,
  defineEventType,
  describeRegistryProblems,
  EXECUTOR_ROLE_IDS,
  OFFICIAL_FLOWS,
  OFFICIAL_ROLES,
  OFFICIAL_RULE_KEYS,
  OFFICIAL_SCENARIO_TYPES,
  OFFICIAL_TOOLS,
  officialRegistryEntries,
  planOutput,
  PLUGIN_DAEMON_EVENT_NAMES,
  reviewOutput,
  scriptOutput,
  ROLE_IDS,
  SCENARIO_TYPE_IDS,
  validateRegistries,
  type EventTypeDefinition,
  type RegistryEntries,
  type RegistryProblem,
  type RegistryProblemCode,
  type ToolDefinition,
} from './index.js';

const PING = defineEventType({
  type: 'test.ping',
  schemaVersion: 1,
  payload: z.strictObject({ n: z.int() }),
});

function valid(): RegistryEntries {
  return officialRegistryEntries([PING]);
}

function replace(overrides: Partial<RegistryEntries>): RegistryEntries {
  return { ...valid(), ...overrides };
}

function codes(problems: readonly RegistryProblem[]): RegistryProblemCode[] {
  return problems.map((problem) => problem.code);
}

function only(problems: readonly RegistryProblem[]): RegistryProblem {
  expect(problems).toHaveLength(1);
  const [problem] = problems;
  if (problem === undefined) throw new Error('unreachable');
  return problem;
}

const BAD_SCHEMA = {} as unknown as z.ZodType;

describe('the official entries', () => {
  it('validate with no problem and build the registries', () => {
    expect(validateRegistries(valid())).toEqual([]);
    const registries = buildRegistries(valid());
    expect(registries.roles.keys()).toEqual([...ROLE_IDS]);
    expect(registries.scenarioTypes.keys()).toEqual([...SCENARIO_TYPE_IDS]);
    expect(registries.events.has('test.ping')).toBe(true);
    expect(registries.tools.size).toBe(OFFICIAL_TOOLS.length);
  });

  it('have the seven roles, the six rule keys, the three scenario types and four flows', () => {
    expect(OFFICIAL_ROLES.map((role) => role.id)).toEqual([
      'director',
      'consultant',
      'author',
      'reviewer',
      'scriptwriter',
      'actor',
      'critic',
    ]);
    expect(OFFICIAL_RULE_KEYS).toHaveLength(6);
    expect(OFFICIAL_SCENARIO_TYPES.map((type) => type.id)).toEqual(['project', 'task', 'chat']);
    expect(OFFICIAL_FLOWS.map((flow) => flow.id)).toEqual([
      'play',
      'task.define',
      'task.run',
      'chat',
    ]);
  });

  it('register the tools of architecture 5.3 for the right roles', () => {
    const registries = buildRegistries(valid());
    const rolesOf = (name: string): readonly string[] => registries.tools.get(name)?.roles ?? [];
    expect(rolesOf('next_action')).toEqual(['director']);
    expect(rolesOf('submit')).toEqual([...EXECUTOR_ROLE_IDS]);
    expect(rolesOf('git_commit')).toEqual(['actor']);
    expect(rolesOf('submit_critique')).toEqual(['critic']);
    expect(registries.tools.get('open_pr')?.effect).toBe('external_write');
    expect(registries.tools.get('open_pr')?.idempotencyKey).toBe('attempt_step');
    expect(registries.tools.get('git_commit')?.effect).toBe('local_write');
  });

  it('give the stage tools the schemas of the stage outputs, one source for tool and daemon', () => {
    const registries = buildRegistries(valid());
    const inputOf = (name: string): unknown => registries.tools.get(name)?.input;
    expect(inputOf('submit_plan')).toBe(planOutput);
    expect(inputOf('submit_plan_review')).toBe(reviewOutput);
    expect(inputOf('submit_script_review')).toBe(reviewOutput);
    expect(inputOf('submit_critique')).toBe(reviewOutput);
    expect(inputOf('submit_script')).toBe(scriptOutput);
  });

  it('read a plan: text plan, plain-string questions that default to none', () => {
    expect(planOutput.parse({ plan: 'p' })).toEqual({ plan: 'p', openQuestions: [] });
    expect(planOutput.parse({ plan: 'p', openQuestions: ['q?'], extra: 1 })).toEqual({
      plan: 'p',
      openQuestions: ['q?'],
      extra: 1,
    });
    for (const bad of [
      {},
      { plan: '' },
      { plan: { steps: ['a'] } },
      { plan: 'p', openQuestions: [{ question: 'q' }] },
      { plan: 'p', openQuestions: [''] },
      { plan: 'p', openQuestions: 'q' },
    ]) {
      expect(planOutput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('read a review: approved is a boolean and a veto carries its reason [proposta]', () => {
    expect(reviewOutput.safeParse({ approved: true }).success).toBe(true);
    expect(reviewOutput.safeParse({ approved: false, reason: 'no tests' }).success).toBe(true);
    for (const bad of [
      {},
      { approved: 'yes' },
      { approved: false },
      { approved: false, reason: '  ' },
    ]) {
      expect(reviewOutput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('read a script submission: the key must be there, its content is for parseScript', () => {
    expect(scriptOutput.safeParse({ script: { demands: [] } }).success).toBe(true);
    expect(scriptOutput.safeParse({ script: 'text' }).success).toBe(true);
    expect(scriptOutput.safeParse({}).success).toBe(false);
  });

  it('let read_blackboard and read_contract ask for a version, and read_decision not (P7)', () => {
    const registries = buildRegistries(valid());
    const accepts = (tool: string, input: unknown): boolean =>
      registries.tools.get(tool)?.input.safeParse(input).success ?? false;
    expect(accepts('read_blackboard', { key: 'plan' })).toBe(true);
    expect(accepts('read_blackboard', { key: 'plan', version: 3 })).toBe(true);
    expect(accepts('read_contract', { id: 'c1', version: 1 })).toBe(true);
    for (const version of [0, -1, 1.5, '2']) {
      expect(accepts('read_blackboard', { key: 'plan', version })).toBe(false);
      expect(accepts('read_contract', { id: 'c1', version })).toBe(false);
    }
    expect(accepts('read_decision', { id: 'D-1' })).toBe(true);
    expect(accepts('read_decision', { id: 'D-1', version: 1 })).toBe(false);
  });

  it('hold a value schema per rule key that accepts its example and refuses a bad one', () => {
    const registries = buildRegistries(valid());
    const schema = (key: string): z.ZodType => {
      const entry = registries.ruleKeys.get(key);
      if (entry === undefined) throw new Error(`missing ${key}`);
      return entry.value;
    };
    expect(schema('git.push_after_commit').safeParse(true).success).toBe(true);
    expect(schema('git.push_after_commit').safeParse('yes').success).toBe(false);
    expect(schema('delivery.mode').safeParse('pr').success).toBe(true);
    expect(schema('delivery.mode').safeParse('never').success).toBe(false);
    expect(schema('chat.producer_questions').safeParse('choices').success).toBe(true);
    expect(schema('chat.unanswered').safeParse({ mode: 'wait', wait_for: '30m' }).success).toBe(
      true,
    );
    expect(schema('chat.unanswered').safeParse({ mode: 'wait', wait_for: 'soon' }).success).toBe(
      false,
    );
    expect(schema('roles.when_exhausted').safeParse({ role: 'actor', mode: 'next' }).success).toBe(
      true,
    );
    expect(schema('roles.executors').safeParse({ role: 'actor' }).success).toBe(false);
    expect(
      schema('roles.executors').safeParse({ role: 'actor', exclude: ['a@claude-code/work'] })
        .success,
    ).toBe(true);
  });

  it('are immutable', () => {
    const registries = buildRegistries(valid());
    const role = registries.roles.get('actor');
    expect(Object.isFrozen(registries)).toBe(true);
    expect(Object.isFrozen(role)).toBe(true);
    expect(Object.isFrozen(registries.roles.list())).toBe(true);
    expect(() => {
      (registries.roles.list() as unknown[]).push({});
    }).toThrow(TypeError);
  });
});

describe('validateRegistries: one failing case per rule', () => {
  it('rejects a duplicated name in every registry', () => {
    const role = OFFICIAL_ROLES[0];
    const tool = OFFICIAL_TOOLS[0];
    const rule = OFFICIAL_RULE_KEYS[0];
    const flow = OFFICIAL_FLOWS[0];
    const scenario = OFFICIAL_SCENARIO_TYPES[0];
    if (!role || !tool || !rule || !flow || !scenario) throw new Error('unreachable');
    const problems = validateRegistries(
      replace({
        roles: [...OFFICIAL_ROLES, role],
        tools: [...OFFICIAL_TOOLS, tool],
        ruleKeys: [...OFFICIAL_RULE_KEYS, rule],
        events: [PING, PING],
        flows: [...OFFICIAL_FLOWS, flow],
        scenarioTypes: [...OFFICIAL_SCENARIO_TYPES, scenario],
      }),
    );
    expect(
      problems.filter((problem) => problem.code === 'duplicate').map((p) => p.registry),
    ).toEqual(['roles', 'tools', 'ruleKeys', 'events', 'flows', 'scenarioTypes']);
  });

  it('rejects a tool that names a role that does not exist', () => {
    const tool: ToolDefinition = { ...requireTool('next_action'), roles: ['director', 'ghost'] };
    const problem = only(validateRegistries(replace({ tools: swapTool(tool) })));
    expect(problem).toMatchObject({
      registry: 'tools',
      entry: 'next_action',
      code: 'unknown_role',
    });
    expect(problem.message).toContain('ghost');
  });

  it('rejects a tool with no role at all', () => {
    const tool: ToolDefinition = { ...requireTool('next_action'), roles: [] };
    expect(codes(validateRegistries(replace({ tools: swapTool(tool) })))).toEqual(['empty_list']);
  });

  it('rejects a flow that names a role or a tool that does not exist', () => {
    const flow = { ...requireFlow('chat'), roles: ['director', 'ghost'], tools: ['phantom'] };
    const problems = validateRegistries(
      replace({ flows: OFFICIAL_FLOWS.map((entry) => (entry.id === 'chat' ? flow : entry)) }),
    );
    expect(problems.map((p) => [p.registry, p.entry, p.code])).toEqual([
      ['flows', 'chat', 'unknown_role'],
      ['flows', 'chat', 'unknown_tool'],
    ]);
  });

  it('rejects a scenario type whose flow does not exist', () => {
    const scenario = { id: 'project', defaultFlow: 'missing', flows: ['missing'] };
    const problems = validateRegistries(
      replace({
        scenarioTypes: OFFICIAL_SCENARIO_TYPES.map((entry) =>
          entry.id === 'project' ? scenario : entry,
        ),
      }),
    );
    expect(codes(problems)).toEqual(['unknown_flow', 'unknown_flow']);
    expect(problems[0]).toMatchObject({ registry: 'scenarioTypes', entry: 'project' });
  });

  it('rejects a default flow outside the flows of the scenario type', () => {
    const scenario = { id: 'task', defaultFlow: 'chat', flows: ['task.run'] };
    const problems = validateRegistries(
      replace({
        scenarioTypes: OFFICIAL_SCENARIO_TYPES.map((entry) =>
          entry.id === 'task' ? scenario : entry,
        ),
      }),
    );
    expect(codes(problems)).toEqual(['default_flow_not_accepted']);
  });

  it('rejects an event with no payload schema', () => {
    const event = { type: 'test.broken', schemaVersion: 1, payload: BAD_SCHEMA };
    const problem = only(validateRegistries(replace({ events: [event] })));
    expect(problem).toMatchObject({
      registry: 'events',
      entry: 'test.broken',
      code: 'missing_schema',
    });
  });

  it('rejects an event with an invalid version, an invalid name or a misplaced plugin prefix', () => {
    const payload = z.strictObject({});
    const events: EventTypeDefinition[] = [
      { type: 'test.version', schemaVersion: 0, payload },
      { type: 'NoDots', schemaVersion: 1, payload },
      { type: 'plugin.mine.done', schemaVersion: 1, payload },
      { type: 'test.claim', schemaVersion: 1, payload, plugin: 'mine' },
      { type: 'plugin.other.done', schemaVersion: 1, payload, plugin: 'mine' },
    ];
    expect(validateRegistries(replace({ events })).map((p) => [p.entry, p.code])).toEqual([
      ['test.version', 'invalid_version'],
      ['NoDots', 'invalid_name'],
      ['plugin.mine.done', 'plugin_prefix'],
      ['test.claim', 'plugin_prefix'],
      ['plugin.other.done', 'plugin_prefix'],
    ]);
  });

  it('accepts a plugin event under plugin.<id>.*', () => {
    const events = [
      defineEventType({
        type: 'plugin.my-tool.finished',
        schemaVersion: 1,
        payload: z.strictObject({}),
        plugin: 'my-tool',
      }),
    ];
    expect(validateRegistries(replace({ events }))).toEqual([]);
  });

  it('accepts the plugin.<name> events of the daemon, and refuses a plugin that owns a reserved name', () => {
    const payload = z.strictObject({});
    const official = PLUGIN_DAEMON_EVENT_NAMES.map((name) =>
      defineEventType({ type: `plugin.${name}`, schemaVersion: 1, payload }),
    );
    expect(validateRegistries(replace({ events: official }))).toEqual([]);
    // A name that is not reserved is still the namespace of the plugins, so it needs an owner.
    const stray = [{ type: 'plugin.mystery', schemaVersion: 1, payload }];
    expect(validateRegistries(replace({ events: stray })).map((p) => p.code)).toEqual([
      'plugin_prefix',
    ]);
    const owned = [
      { type: 'plugin.installed.done', schemaVersion: 1, payload, plugin: 'installed' },
    ];
    expect(validateRegistries(replace({ events: owned })).map((p) => p.code)).toEqual([
      'plugin_prefix',
    ]);
  });

  it('rejects a rule key with no value schema, a bad name and a permission family', () => {
    const ruleKeys = [
      { key: 'git.push_after_commit', value: BAD_SCHEMA, appliesAt: 'vcs' as const },
      { key: 'Bad Key', value: z.boolean(), appliesAt: 'vcs' as const },
      { key: 'permissions.bypass', value: z.boolean(), appliesAt: 'selection' as const },
    ];
    expect(validateRegistries(replace({ ruleKeys })).map((p) => [p.entry, p.code])).toEqual([
      ['git.push_after_commit', 'missing_schema'],
      ['Bad Key', 'invalid_name'],
      ['permissions.bypass', 'reserved_rule_key'],
    ]);
  });

  it('rejects an external_write tool with no idempotency key', () => {
    const tool: ToolDefinition = { ...requireTool('open_pr'), idempotencyKey: undefined };
    const problem = only(validateRegistries(replace({ tools: swapTool(tool) })));
    expect(problem).toMatchObject({
      registry: 'tools',
      entry: 'open_pr',
      code: 'missing_idempotency_key',
    });
  });

  it('rejects the old effect vocabulary (none, worktree) and names the new one', () => {
    for (const old of ['none', 'worktree']) {
      const tool = {
        ...requireTool('next_action'),
        effect: old as unknown as ToolDefinition['effect'],
      };
      const problem = only(validateRegistries(replace({ tools: swapTool(tool) })));
      expect(problem).toMatchObject({ entry: 'next_action', code: 'invalid_effect_class' });
      expect(problem.message).toContain('read, local_write, network or external_write');
    }
  });

  it('rejects a network tool with no idempotency key, as it does an external_write one', () => {
    const tool: ToolDefinition = {
      ...requireTool('next_action'),
      effect: 'network',
      idempotencyKey: undefined,
    };
    const problem = only(validateRegistries(replace({ tools: swapTool(tool) })));
    expect(problem).toMatchObject({ entry: 'next_action', code: 'missing_idempotency_key' });
    const keyed: ToolDefinition = { ...tool, idempotencyKey: 'attempt_step' };
    expect(validateRegistries(replace({ tools: swapTool(keyed) }))).toEqual([]);
  });

  it('rejects a tool with a bad effect class, a missing schema and a bad name', () => {
    const base = requireTool('next_action');
    const tools: ToolDefinition[] = [
      ...OFFICIAL_TOOLS,
      { ...base, name: 'effect_tool', effect: 'worktree' as unknown as ToolDefinition['effect'] },
      { ...base, name: 'schema_tool', input: BAD_SCHEMA, output: BAD_SCHEMA },
      { ...base, name: 'Bad-Name' },
    ];
    expect(validateRegistries(replace({ tools })).map((p) => [p.entry, p.code])).toEqual([
      ['effect_tool', 'invalid_effect_class'],
      ['schema_tool', 'missing_schema'],
      ['schema_tool', 'missing_schema'],
      ['Bad-Name', 'invalid_name'],
    ]);
  });

  it('rejects a role or a flow with a bad id, and a flow with a bad version or no role', () => {
    const roles = [...OFFICIAL_ROLES, { id: 'Bad Role', summary: 'x' }];
    const flows = [
      ...OFFICIAL_FLOWS,
      { id: 'Bad Flow', version: 1, roles: ['director'], tools: [] },
      { id: 'late', version: 0, roles: [], tools: [] },
    ];
    expect(validateRegistries(replace({ roles, flows })).map((p) => [p.entry, p.code])).toEqual([
      ['Bad Role', 'invalid_name'],
      ['Bad Flow', 'invalid_name'],
      ['late', 'invalid_version'],
      ['late', 'empty_list'],
    ]);
  });

  it('returns ALL the problems at once, each naming its registry and entry', () => {
    const tool: ToolDefinition = { ...requireTool('open_pr'), idempotencyKey: undefined };
    const problems = validateRegistries(
      replace({
        tools: swapTool(tool),
        events: [{ type: 'test.broken', schemaVersion: 1, payload: BAD_SCHEMA }],
        scenarioTypes: [{ id: 'project', defaultFlow: 'nope', flows: ['nope'] }],
      }),
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
    const text = describeRegistryProblems(problems);
    expect(text).toContain('tools/open_pr');
    expect(text).toContain('events/test.broken');
    expect(text).toContain('scenarioTypes/project');
  });
});

describe('buildRegistries', () => {
  it('throws InvalidInput that lists every problem', () => {
    const entries = replace({
      events: [{ type: 'test.broken', schemaVersion: 1, payload: BAD_SCHEMA }],
    });
    expect(() => buildRegistries(entries)).toThrow(InvalidInput);
    expect(() => buildRegistries(entries)).toThrow(/events\/test\.broken/);
  });
});

describe('the event registry', () => {
  const registry = createEventRegistry([PING]);

  it('returns the parsed payload of a valid event', () => {
    expect(registry.parseEvent('test.ping', 1, { n: 3 })).toEqual({ n: 3 });
    expect(registry.checkEvent('test.ping', 1, { n: 3 })).toEqual({ ok: true, payload: { n: 3 } });
  });

  it('says why an event does not pass', () => {
    expect(registry.checkEvent('test.other', 1, {})).toMatchObject({
      ok: false,
      reason: 'unknown_type',
    });
    expect(registry.checkEvent('test.ping', 2, { n: 1 })).toMatchObject({
      ok: false,
      reason: 'unsupported_version',
    });
    expect(registry.checkEvent('test.ping', 1, { n: 'x' })).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
    expect(registry.checkEvent('test.ping', 1, { n: 1, extra: true })).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it('throws InvalidInput from parseEvent', () => {
    expect(() => registry.parseEvent('test.other', 1, {})).toThrow(InvalidInput);
    expect(() => registry.parseEvent('test.ping', 1, { n: 'x' })).toThrow(/test\.ping payload/);
  });
});

function requireTool(name: string): ToolDefinition {
  const found = OFFICIAL_TOOLS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found;
}

function requireFlow(id: string): (typeof OFFICIAL_FLOWS)[number] {
  const found = OFFICIAL_FLOWS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing flow ${id}`);
  return found;
}

function swapTool(tool: ToolDefinition): readonly ToolDefinition[] {
  return OFFICIAL_TOOLS.map((entry) => (entry.name === tool.name ? tool : entry));
}
