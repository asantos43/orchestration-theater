// SPDX-License-Identifier: MPL-2.0
import {
  BUILTIN_STEP_TYPES,
  type PublicWrite,
  type StepTypeSpec,
  type ValidWorkflow,
} from '@otheater/workflows';

/**
 * What a workflow package asks for, shown before it is installed (docs/24 section 9, N298; plan of
 * Phase 11b, P9). Read from the validated definitions, never from what the author says: the tools
 * a `call_tool` node names and a `requires.tools` entry, the plugins in `requires.plugins`, and
 * the effects and public writes of the step types its nodes use (`StepTypeSpec.effects` and
 * `publicWrites`). [proposta] The kinds of the keys below (`tool`, `plugin`, `effect`,
 * `public_write`) and the rule that `none` is not an effect worth showing.
 */
export interface PackagePermissions {
  /** The tools it may call (`call_tool` and `requires.tools`), sorted. */
  readonly tools: readonly string[];
  /** The plugins it requires (`requires.plugins`), sorted. */
  readonly plugins: readonly string[];
  /** What its steps can cause besides nothing: `agent`, `write_code_host`, `tool`..., sorted. */
  readonly effects: readonly string[];
  /** The writes others see (`push`, `comment`, `label`) that a node of it may do, sorted. */
  readonly publicWrites: readonly PublicWrite[];
}

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort();
}

/** The permissions of a set of validated definitions (the workflows of one package). */
export function describePermissions(
  workflows: readonly ValidWorkflow[],
  stepTypes: readonly StepTypeSpec[] = BUILTIN_STEP_TYPES,
): PackagePermissions {
  const specs = new Map(stepTypes.map((spec) => [spec.id, spec]));
  const tools = new Set<string>();
  const plugins = new Set<string>();
  const effects = new Set<string>();
  const publicWrites = new Set<PublicWrite>();
  for (const workflow of workflows) {
    for (const tool of workflow.definition.requires?.tools ?? []) tools.add(tool);
    for (const plugin of workflow.definition.requires?.plugins ?? []) plugins.add(plugin);
    for (const node of Object.values(workflow.nodes)) {
      const spec = specs.get(node.step);
      if (spec === undefined) continue;
      for (const effect of spec.effects) if (effect !== 'none') effects.add(effect);
      for (const write of spec.publicWrites(node.params)) publicWrites.add(write);
      const tool = node.step === 'call_tool' ? node.params.tool : undefined;
      if (typeof tool === 'string') tools.add(tool);
    }
  }
  return {
    tools: sorted(tools),
    plugins: sorted(plugins),
    effects: sorted(effects),
    publicWrites: sorted(publicWrites),
  };
}

/** The permissions as flat keys (`tool:x`, `plugin:x`, `effect:x`, `public_write:x`), to compare and to record. */
export function permissionKeys(permissions: PackagePermissions): string[] {
  return [
    ...permissions.tools.map((name) => `tool:${name}`),
    ...permissions.plugins.map((name) => `plugin:${name}`),
    ...permissions.effects.map((name) => `effect:${name}`),
    ...permissions.publicWrites.map((name) => `public_write:${name}`),
  ];
}

/**
 * The keys of `next` that the Producer had not approved: all of them in a first install, and only
 * what an update adds when the package was installed before (docs/24 section 9: an update that
 * brings a new permission asks again).
 */
export function addedPermissions(approved: readonly string[], next: PackagePermissions): string[] {
  const known = new Set(approved);
  return permissionKeys(next).filter((key) => !known.has(key));
}
