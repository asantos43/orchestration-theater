// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { InvalidInput } from '../errors.js';

/** The registries of architecture 5.18 that the daemon validates at start-up. */
export const REGISTRY_NAMES = [
  'roles',
  'tools',
  'ruleKeys',
  'events',
  'flows',
  'scenarioTypes',
  /** Not a registry of entries: the role prompts, checked against `roles` and `tools` (P11). */
  'prompts',
] as const;
export type RegistryName = (typeof REGISTRY_NAMES)[number];

/** Why an entry failed validation. Stable: tests and messages branch on it. */
export const REGISTRY_PROBLEM_CODES = [
  /** Two entries of the same registry share a name. */
  'duplicate',
  /** The name does not follow the pattern of its registry. */
  'invalid_name',
  /** A list that must name at least one entry is empty. */
  'empty_list',
  /** A tool or flow names a role that is not in the role registry. */
  'unknown_role',
  /** A flow names a tool that is not in the tool registry. */
  'unknown_tool',
  /** A scenario type names a flow that is not in the flow registry. */
  'unknown_flow',
  /** The default flow of a scenario type is not among the flows it accepts. */
  'default_flow_not_accepted',
  /** An entry that must carry a zod schema does not. */
  'missing_schema',
  /** The version of an event schema or of a flow is not an integer >= 1. */
  'invalid_version',
  /** The effect class is not `read`, `local_write`, `network` or `external_write`. */
  'invalid_effect_class',
  /** A `network` or `external_write` tool has no idempotency key (architecture 5.16, 5.18). */
  'missing_idempotency_key',
  /** A plugin event outside `plugin.<id>.*`, or an official event inside it. */
  'plugin_prefix',
  /** A role of the registry has no prompt in the prompt source. */
  'missing_prompt',
  /** A prompt has no text. */
  'empty_prompt',
  /** A prompt cites a tool that exists but is not in the tool set of its role. */
  'tool_not_for_role',
  /** A `rule` key in a family `rule` may never change (permissions, architecture 5.8 and 5.17). */
  'reserved_rule_key',
] as const;
export type RegistryProblemCode = (typeof REGISTRY_PROBLEM_CODES)[number];

/** One thing wrong in one entry of one registry. */
export interface RegistryProblem {
  readonly registry: RegistryName;
  /** The name of the entry (a role id, a tool name, an event type...). */
  readonly entry: string;
  readonly code: RegistryProblemCode;
  readonly message: string;
}

/** Collects problems with the registry name fixed, so a validator reads `report(entry, code, msg)`. */
export class ProblemCollector {
  readonly problems: RegistryProblem[] = [];

  constructor(readonly registry: RegistryName) {}

  report(entry: string, code: RegistryProblemCode, message: string): void {
    this.problems.push({ registry: this.registry, entry, code, message });
  }
}

/** One line per problem, each saying the registry and the entry that failed. */
export function describeRegistryProblems(problems: readonly RegistryProblem[]): string {
  return problems
    .map((problem) => `${problem.registry}/${problem.entry}: ${problem.message} [${problem.code}]`)
    .join('\n');
}

/** Throws `InvalidInput` listing every problem, or returns when there is none. */
export function assertNoRegistryProblems(what: string, problems: readonly RegistryProblem[]): void {
  if (problems.length === 0) return;
  const noun = problems.length === 1 ? 'problem' : 'problems';
  throw new InvalidInput(
    `${what} (${String(problems.length)} ${noun}):\n${describeRegistryProblems(problems)}`,
  );
}

/** True for a zod schema (zod 4 supports `instanceof` on the base class). */
export function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

/**
 * A registry after validation: lookup by key and the entries in registration order. Immutable:
 * the entries are frozen and there is no way to add one.
 */
export interface Registry<T> {
  readonly size: number;
  has(key: string): boolean;
  get(key: string): T | undefined;
  /** The entries, in registration order. */
  list(): readonly T[];
  /** The keys, in registration order. */
  keys(): readonly string[];
}

/** Builds the frozen {@link Registry} of already validated, unique-keyed entries. */
export function createRegistry<T extends object>(
  entries: readonly T[],
  keyOf: (entry: T) => string,
): Registry<T> {
  const byKey = new Map<string, T>();
  for (const entry of entries) byKey.set(keyOf(entry), Object.freeze({ ...entry }));
  const list = Object.freeze([...byKey.values()]);
  const keys = Object.freeze([...byKey.keys()]);
  return Object.freeze({
    size: byKey.size,
    has: (key: string) => byKey.has(key),
    get: (key: string) => byKey.get(key),
    list: () => list,
    keys: () => keys,
  });
}

/** Reports every name that appears more than once. */
export function reportDuplicates(
  collector: ProblemCollector,
  names: readonly string[],
  what: string,
): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const name of names) {
    if (seen.has(name) && !reported.has(name)) {
      reported.add(name);
      collector.report(name, 'duplicate', `${what} "${name}" is registered more than once`);
    }
    seen.add(name);
  }
}
