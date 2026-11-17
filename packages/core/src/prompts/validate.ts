// SPDX-License-Identifier: MPL-2.0
import type { PromptSource } from '../ports/prompt-source.js';
import {
  assertNoRegistryProblems,
  ProblemCollector,
  type RegistryProblem,
} from '../registries/problems.js';
import type { RoleDefinition } from '../registries/roles.js';
import type { ToolDefinition } from '../registries/tools.js';

const INLINE_CODE = /`([^`\n]+)`/g;
const TOOL_CALL = /^([a-z][a-z0-9_]*)\(/;
const BARE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * [proposta] The tools a prompt cites. A prompt cites a tool in an inline code span, written as a
 * call (`` `ask_producer(questions)` ``) or as the bare name of a tool of the registry
 * (`` `submit_plan` ``). Words in code spans that are neither (`` `blocked` ``, a field name)
 * are not tool citations, and a name in plain prose is not either: the convention keeps the
 * check free of false alarms, at the price of asking the prompt author to quote tools. The names
 * come back once each, in order of appearance. Fenced blocks are not read specially: write
 * prompts without them.
 */
export function citedTools(text: string, knownTools: ReadonlySet<string>): readonly string[] {
  const cited = new Set<string>();
  for (const match of text.matchAll(INLINE_CODE)) {
    const span = (match[1] ?? '').trim();
    const call = TOOL_CALL.exec(span);
    if (call?.[1] !== undefined) cited.add(call[1]);
    else if (BARE_NAME.test(span) && knownTools.has(span)) cited.add(span);
  }
  return [...cited];
}

/** The tools of `role`, in registration order: the ones its prompt may cite. */
export function toolsOfRole(tools: readonly ToolDefinition[], role: string): ToolDefinition[] {
  return tools.filter((tool) => tool.roles.includes(role));
}

/**
 * Checks the prompts of the roles against the role and tool registries and returns ALL the
 * problems (an empty list means valid). One entry per role (`prompts/<role>`):
 * - a role of the registry without a prompt (`missing_prompt`), or with an empty one
 *   (`empty_prompt`);
 * - a prompt for a role that is not in the registry (`unknown_role`);
 * - a cited tool that is not in the tool registry (`unknown_tool`) or that the role does not see
 *   (`tool_not_for_role`): a prompt that sends the model to a tool it cannot call.
 */
export function validatePrompts(
  prompts: ReadonlyMap<string, string>,
  roles: readonly RoleDefinition[],
  tools: readonly ToolDefinition[],
): readonly RegistryProblem[] {
  const collector = new ProblemCollector('prompts');
  const roleIds = new Set(roles.map((role) => role.id));
  const toolNames = new Set(tools.map((tool) => tool.name));

  for (const role of roleIds) {
    if (!prompts.has(role)) {
      collector.report(role, 'missing_prompt', `Role "${role}" has no prompt`);
    }
  }
  for (const [role, text] of prompts) {
    if (!roleIds.has(role)) {
      collector.report(role, 'unknown_role', `There is a prompt for the unknown role "${role}"`);
      continue;
    }
    if (text.trim() === '') {
      collector.report(role, 'empty_prompt', `The prompt of role "${role}" is empty`);
      continue;
    }
    const allowed = new Set(toolsOfRole(tools, role).map((tool) => tool.name));
    for (const name of citedTools(text, toolNames)) {
      if (!toolNames.has(name)) {
        collector.report(
          role,
          'unknown_tool',
          `The prompt of role "${role}" cites the tool "${name}", which is not in the tool registry`,
        );
      } else if (!allowed.has(name)) {
        collector.report(
          role,
          'tool_not_for_role',
          `The prompt of role "${role}" cites the tool "${name}", which that role cannot call`,
        );
      }
    }
  }
  return collector.problems;
}

/**
 * Loads every prompt the source has and validates them against the registries (`validatePrompts`).
 * Throws `InvalidInput` listing every problem as `prompts/<role>: <message> [<code>]`, like the
 * registries do, and returns the prompts by role when there is none. A source that cannot be
 * read rejects with its own error (`AdapterUnavailable`).
 */
export async function assertValidPrompts(
  source: PromptSource,
  registries: {
    readonly roles: { list(): readonly RoleDefinition[] };
    readonly tools: { list(): readonly ToolDefinition[] };
  },
): Promise<ReadonlyMap<string, string>> {
  const prompts = new Map<string, string>();
  for (const role of await source.roles()) prompts.set(role, await source.get(role));
  assertNoRegistryProblems(
    'Invalid prompts',
    validatePrompts(prompts, registries.roles.list(), registries.tools.list()),
  );
  return prompts;
}
