// SPDX-License-Identifier: MPL-2.0
import { ROLE_IDS } from '@otheater/core';
import type { z } from 'zod';
import {
  checkCondition,
  ConditionSyntaxError,
  DEFAULT_CONDITION_LIMITS,
  parseCondition,
  type Condition,
  type ConditionLimits,
} from './condition.js';
import {
  compareVersions,
  DURATION_PATTERN,
  isTerminal,
  normalizeEdge,
  RESERVED_LIMITS,
  startNode,
  TERMINALS,
  WorkflowDefinitionSchema,
  type InputType,
  type WorkflowDefinition,
  type WorkflowInput,
  type WorkflowTrigger,
} from './definition.js';
import type { FieldType } from './field-types.js';
import {
  BUILTIN_STEP_TYPES,
  PUBLIC_WRITES,
  stepTypeRegistry,
  type PublicWrite,
  type StepTypeSpec,
} from './step-types.js';

/** The version of the engine of this package; `engine` of a definition is a range over it. */
export const ENGINE_VERSION = 1;

export const VALIDATION_CODES = [
  'schema',
  'engine',
  'start',
  'input_default',
  'unknown_step',
  'unknown_role',
  'role_not_allowed',
  'params',
  'unknown_source',
  'unknown_target',
  'shadowed_edge',
  'no_out_edge',
  'condition_syntax',
  'condition_type',
  'unknown_limit',
  'unreachable',
  'no_terminal',
  'unbounded_cycle',
  'unknown_trigger',
  'missing_plugin',
  'missing_tool',
  'approval_missing',
  'migration_version',
  'migration_target',
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];

export const WARNING_CODES = ['unused_limit'] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface ValidationIssue<C extends string = ValidationCode> {
  /** Where in the document: `nodes.review.params.subject`, `edges[3].when`. */
  readonly path: string;
  /** The same path as segments, to find the place in the YAML. */
  readonly segments: readonly (string | number)[];
  readonly code: C;
  readonly message: string;
}

export interface ValidateOptions {
  /** The step registry; default {@link BUILTIN_STEP_TYPES}. */
  readonly stepTypes?: readonly StepTypeSpec[];
  /** Default {@link ENGINE_VERSION}. */
  readonly engineVersion?: number;
  /** The roles that exist; default the ones of the core. */
  readonly roles?: readonly string[];
  /** The trigger types that exist; absent, `triggers[].type` is not checked here. */
  readonly triggerTypes?: readonly string[];
  /** What is installed; absent, `requires` and `call_tool` are not checked here. */
  readonly installed?: { readonly plugins?: readonly string[]; readonly tools?: readonly string[] };
  /**
   * `workflows.security.require_approval`: the public writes that need an approval before them;
   * default all ({@link PUBLIC_WRITES}). `[]` is the `none` of the key.
   */
  readonly requireApproval?: readonly PublicWrite[];
  readonly conditionLimits?: ConditionLimits;
}

export interface WorkflowEdge {
  /** The index in `edges` of the document. */
  readonly index: number;
  readonly from: string;
  readonly to: string;
  readonly when?: string;
  readonly condition?: Condition;
  readonly limit?: string;
  readonly onLimit?: string;
}

export interface CompiledNode {
  readonly id: string;
  readonly step: string;
  readonly role: string | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly safePoint: boolean;
  /** The edges that leave it, in the order of the document: the first that matches is taken. */
  readonly edges: readonly WorkflowEdge[];
}

/** A definition that passed the validator, ready for the compiler and the runtime. */
export interface ValidWorkflow {
  readonly definition: WorkflowDefinition;
  readonly id: string;
  readonly version: string;
  readonly start: string;
  readonly nodes: Readonly<Record<string, CompiledNode>>;
  readonly edges: readonly WorkflowEdge[];
  /** The counters of the edges (`limits` minus the reserved keys). */
  readonly counters: Readonly<Record<string, number>>;
  readonly limits: Readonly<Record<string, unknown>>;
}

export type ValidationResult =
  | {
      readonly ok: true;
      readonly workflow: ValidWorkflow;
      readonly errors: readonly [];
      readonly warnings: readonly ValidationIssue<WarningCode>[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationIssue[];
      readonly warnings: readonly ValidationIssue<WarningCode>[];
    };

/** `nodes.review.params`, `edges[3].when`. */
export function formatPath(segments: readonly (string | number)[]): string {
  let out = '';
  for (const segment of segments) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

/** The field type of an input, for the conditions. */
export function inputFieldType(type: InputType): FieldType {
  if (typeof type === 'string') {
    return type === 'number' || type === 'boolean' ? type : 'string';
  }
  if ('enum' in type) return { enum: type.enum };
  return { list: type.list };
}

function defaultFits(type: InputType, value: unknown): boolean {
  if (typeof type === 'string') {
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'duration') return typeof value === 'string' && DURATION_PATTERN.test(value);
    return typeof value === 'string';
  }
  if ('enum' in type) return typeof value === 'string' && type.enum.includes(value);
  const kind = type.list;
  return Array.isArray(value) && value.every((item) => typeof item === kind);
}

/**
 * Checks one comparator range over an integer engine version: `>=1 <2`, `1`, `=1`, `<3`.
 * Returns `null` when the text is not a range. [proposta]
 */
export function engineInRange(range: string, version: number): boolean | null {
  const parts = range.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return null;
  let ok = true;
  for (const part of parts) {
    const match = /^(>=|<=|>|<|=)?(\d+)$/.exec(part);
    if (match === null) return null;
    const op = match[1] ?? '=';
    const n = Number(match[2]);
    const fits =
      op === '>='
        ? version >= n
        : op === '<='
          ? version <= n
          : op === '>'
            ? version > n
            : op === '<'
              ? version < n
              : version === n;
    ok &&= fits;
  }
  return ok;
}

function zodIssues(
  error: z.ZodError,
  prefix: readonly (string | number)[],
  code: ValidationCode,
): ValidationIssue[] {
  return error.issues.map((issue) => {
    const segments = [
      ...prefix,
      ...issue.path.filter((p): p is string | number => typeof p !== 'symbol'),
    ];
    return { path: formatPath(segments), segments, code, message: issue.message };
  });
}

/**
 * Validates a definition (docs/24, §5). Everything that can be said before a run starts is said
 * here: the schema, the step types, roles and params, the edges and their conditions against the
 * typed outputs, reachability, that every node reaches an end, that every cycle is bounded, what
 * is required, and the approval before the public writes. The same function runs on the daemon
 * start, in the API, on the install of a package and on the activation.
 */
export function validateWorkflow(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const warnings: ValidationIssue<WarningCode>[] = [];
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodIssues(parsed.error, [], 'schema'), warnings };
  }
  const definition = parsed.data;
  const errors: ValidationIssue[] = [];
  const fail = (segments: readonly (string | number)[], code: ValidationCode, message: string) => {
    errors.push({ path: formatPath(segments), segments, code, message });
  };

  const registry = stepTypeRegistry(options.stepTypes ?? BUILTIN_STEP_TYPES);
  const roles = new Set(options.roles ?? ROLE_IDS);
  const conditionLimits = options.conditionLimits ?? DEFAULT_CONDITION_LIMITS;
  const requireApproval = new Set(options.requireApproval ?? PUBLIC_WRITES);

  // Engine.
  const engine = engineInRange(definition.engine, options.engineVersion ?? ENGINE_VERSION);
  if (engine === null)
    fail(['engine'], 'engine', `"${definition.engine}" is not a range like >=1 <2`);
  else if (!engine) {
    fail(
      ['engine'],
      'engine',
      `this engine is version ${String(options.engineVersion ?? ENGINE_VERSION)}`,
    );
  }

  // Inputs.
  const inputs: Record<string, WorkflowInput> = definition.inputs ?? {};
  const inputTypes: Record<string, FieldType> = {};
  for (const [name, declared] of Object.entries(inputs)) {
    inputTypes[name] = inputFieldType(declared.type);
    if (declared.default !== undefined && !defaultFits(declared.type, declared.default)) {
      fail(['inputs', name, 'default'], 'input_default', 'the default does not fit the type');
    }
  }
  const inputScope: FieldType = { object: inputTypes };

  // Triggers.
  const triggerTypes = options.triggerTypes === undefined ? null : new Set(options.triggerTypes);
  (definition.triggers ?? []).forEach((trigger: WorkflowTrigger, i) => {
    if (triggerTypes !== null && !triggerTypes.has(trigger.type)) {
      fail(['triggers', i, 'type'], 'unknown_trigger', `no trigger type ${trigger.type}`);
    }
  });

  // Nodes.
  const nodeIds = Object.keys(definition.nodes);
  const nodeSet = new Set(nodeIds);
  const specs = new Map<string, StepTypeSpec>();
  const resolvedRoles = new Map<string, string | null>();
  const resolvedParams = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [id, node] of Object.entries(definition.nodes)) {
    const spec = registry.get(node.step);
    if (spec === undefined) {
      fail(['nodes', id, 'step'], 'unknown_step', `no step type ${node.step}`);
      continue;
    }
    specs.set(id, spec);
    if (spec.role === null) {
      if (node.role !== undefined) {
        fail(['nodes', id, 'role'], 'role_not_allowed', `${node.step} takes no role`);
      }
      resolvedRoles.set(id, null);
    } else if (node.role === undefined) {
      resolvedRoles.set(id, spec.role.default);
    } else if (!roles.has(node.role)) {
      fail(['nodes', id, 'role'], 'unknown_role', `no role ${node.role}`);
    } else if (!(spec.role.allowed as readonly string[]).includes(node.role)) {
      fail(
        ['nodes', id, 'role'],
        'role_not_allowed',
        `${node.step} takes ${spec.role.allowed.join(' or ')}`,
      );
    } else {
      resolvedRoles.set(id, node.role);
    }
    const params = spec.params.safeParse(node.params ?? {});
    if (!params.success) errors.push(...zodIssues(params.error, ['nodes', id, 'params'], 'params'));
    else resolvedParams.set(id, (params.data ?? {}) as Readonly<Record<string, unknown>>);
  }

  const start = startNode(definition);
  if (start === undefined || !nodeSet.has(start)) {
    fail(['start'], 'start', `start ${start ?? ''} is not a node`);
  }

  // Limits.
  const limits: Record<string, unknown> = definition.limits ?? {};
  const counters: Record<string, number> = {};
  for (const [key, value] of Object.entries(limits)) {
    if (!(RESERVED_LIMITS as readonly string[]).includes(key) && typeof value === 'number') {
      counters[key] = value;
    }
  }

  // The migration map (N295): the versions it names are older than this one, and every target is a
  // node of this definition. The source nodes are checked against the old definition at migration.
  for (const [from, map] of Object.entries(definition.migrate_from ?? {})) {
    if (compareVersions(from, definition.version) >= 0) {
      fail(
        ['migrate_from', from],
        'migration_version',
        `${from} is not older than ${definition.version}`,
      );
    }
    for (const [node, target] of Object.entries(map)) {
      if (!nodeSet.has(target)) {
        fail(['migrate_from', from, node], 'migration_target', `${target} is not a node`);
      }
    }
  }

  // Edges.
  const edges: WorkflowEdge[] = [];
  const unconditional = new Map<string, number>();
  const usedCounters = new Set<string>();
  definition.edges.forEach((raw, index) => {
    const normalized = normalizeEdge(raw);
    if (!normalized.ok) {
      fail(['edges', index], 'schema', normalized.message);
      return;
    }
    const { from, to, when, limit, on_limit: onLimit } = normalized.edge;
    let bad = false;
    if (!nodeSet.has(from)) {
      fail(
        ['edges', index],
        'unknown_source',
        isTerminal(from) ? `${from} is an end: no edge leaves it` : `no node ${from}`,
      );
      bad = true;
    }
    if (!nodeSet.has(to) && !isTerminal(to)) {
      fail(
        ['edges', index],
        'unknown_target',
        `no node ${to} (the ends are ${TERMINALS.join(', ')})`,
      );
      bad = true;
    }
    if (onLimit !== undefined && !nodeSet.has(onLimit) && !isTerminal(onLimit)) {
      fail(['edges', index, 'on_limit'], 'unknown_target', `no node ${onLimit}`);
      bad = true;
    }
    if (onLimit !== undefined && limit === undefined) {
      fail(['edges', index, 'on_limit'], 'unknown_limit', 'on_limit without a limit');
      bad = true;
    }
    if (limit !== undefined) {
      usedCounters.add(limit);
      if (counters[limit] === undefined) {
        fail(
          ['edges', index, 'limit'],
          'unknown_limit',
          (RESERVED_LIMITS as readonly string[]).includes(limit)
            ? `${limit} is not a loop counter`
            : `no limits.${limit}`,
        );
        bad = true;
      }
    }
    const shadowedBy = unconditional.get(from);
    if (shadowedBy !== undefined) {
      fail(
        ['edges', index],
        'shadowed_edge',
        `edges[${String(shadowedBy)}] leaves ${from} with no condition, so this one is never taken`,
      );
      bad = true;
    }
    let condition: Condition | undefined;
    if (when === undefined) {
      if (nodeSet.has(from)) unconditional.set(from, index);
    } else {
      try {
        condition = parseCondition(when, conditionLimits);
      } catch (error) {
        if (!(error instanceof ConditionSyntaxError)) throw error;
        fail(['edges', index, 'when'], 'condition_syntax', error.message);
        bad = true;
      }
      const spec = specs.get(from);
      if (condition !== undefined && spec !== undefined) {
        for (const problem of checkCondition(condition, {
          output: spec.output,
          inputs: inputScope,
        })) {
          fail(['edges', index, 'when'], 'condition_type', problem);
          bad = true;
        }
      }
    }
    if (bad) return;
    edges.push({
      index,
      from,
      to,
      ...(when === undefined ? {} : { when }),
      ...(condition === undefined ? {} : { condition }),
      ...(limit === undefined ? {} : { limit }),
      ...(onLimit === undefined ? {} : { onLimit }),
    });
  });

  for (const key of Object.keys(counters)) {
    if (!usedCounters.has(key)) {
      const segments = ['limits', key];
      warnings.push({
        path: formatPath(segments),
        segments,
        code: 'unused_limit',
        message: `no edge has limit ${key}`,
      });
    }
  }

  const outEdges = new Map<string, WorkflowEdge[]>(nodeIds.map((id) => [id, []]));
  for (const edge of edges) outEdges.get(edge.from)?.push(edge);
  const declaredSources = new Set(
    definition.edges.map((raw) => normalizeEdge(raw)).flatMap((r) => (r.ok ? [r.edge.from] : [])),
  );
  for (const id of nodeIds) {
    if (!declaredSources.has(id)) fail(['nodes', id], 'no_out_edge', `no edge leaves ${id}`);
  }

  // From here on the graph checks need a sound graph; stop with what there is.
  if (errors.length > 0) return { ok: false, errors, warnings };
  // The checks above made sure the start is a node.
  const first = start ?? '';

  const targets = (edge: WorkflowEdge): string[] =>
    edge.onLimit === undefined ? [edge.to] : [edge.to, edge.onLimit];

  // Reachability from the start.
  const reached = new Set<string>([first]);
  const queue = [first];
  while (queue.length > 0) {
    const id = queue.shift() ?? first;
    for (const edge of outEdges.get(id) ?? []) {
      for (const target of targets(edge)) {
        if (nodeSet.has(target) && !reached.has(target)) {
          reached.add(target);
          queue.push(target);
        }
      }
    }
  }
  for (const id of nodeIds) {
    if (!reached.has(id))
      fail(['nodes', id], 'unreachable', `${id} is not reachable from ${first}`);
  }

  // Every node reaches an end (backwards from the ends).
  const reaches = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of edges) {
      if (reaches.has(edge.from)) continue;
      if (targets(edge).some((t) => isTerminal(t) || reaches.has(t))) {
        reaches.add(edge.from);
        grew = true;
      }
    }
  }
  for (const id of nodeIds) {
    if (reached.has(id) && !reaches.has(id)) {
      fail(['nodes', id], 'no_terminal', `${id} never reaches ${TERMINALS.join(', ')}`);
    }
  }

  // Cycles: without the limited edges, the graph has none. The way to `on_limit` does not count,
  // so it stays in the graph: once the counter is used up it can be taken any number of times.
  const unbounded = (edge: WorkflowEdge): string | undefined =>
    edge.limit === undefined ? edge.to : edge.onLimit;
  const color = new Map<string, 'grey' | 'black'>();
  const path: string[] = [];
  const reportedCycles = new Set<string>();
  const visit = (id: string): void => {
    color.set(id, 'grey');
    path.push(id);
    for (const edge of outEdges.get(id) ?? []) {
      const to = unbounded(edge);
      if (to === undefined || !nodeSet.has(to)) continue;
      const state = color.get(to);
      if (state === 'grey') {
        const cycle = [...path.slice(path.indexOf(to)), to];
        const key = [...new Set(cycle)].sort().join(',');
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          fail(
            ['edges', edge.index],
            'unbounded_cycle',
            `the cycle ${cycle.join(' -> ')} has no edge with a limit`,
          );
        }
      } else if (state === undefined) {
        visit(to);
      }
    }
    path.pop();
    color.set(id, 'black');
  };
  for (const id of nodeIds) if (!color.has(id)) visit(id);

  // Required plugins and tools.
  if (options.installed !== undefined) {
    const plugins = new Set(options.installed.plugins ?? []);
    const tools = new Set(options.installed.tools ?? []);
    (definition.requires?.plugins ?? []).forEach((plugin, i) => {
      if (!plugins.has(plugin))
        fail(['requires', 'plugins', i], 'missing_plugin', `${plugin} is not installed`);
    });
    (definition.requires?.tools ?? []).forEach((tool, i) => {
      if (!tools.has(tool))
        fail(['requires', 'tools', i], 'missing_tool', `${tool} is not installed`);
    });
    for (const id of nodeIds) {
      const tool = specs.get(id)?.id === 'call_tool' ? resolvedParams.get(id)?.tool : undefined;
      if (typeof tool === 'string' && !tools.has(tool)) {
        fail(['nodes', id, 'params', 'tool'], 'missing_tool', `${tool} is not installed`);
      }
    }
  }

  // Approval before the public writes: from the start, without crossing a node that approves,
  // no node may write in public what `require_approval` names.
  if (requireApproval.size > 0) {
    const approves = (id: string): boolean =>
      specs.get(id)?.approves(resolvedParams.get(id) ?? {}) ?? false;
    const seen = new Set<string>([first]);
    const open = [first];
    while (open.length > 0) {
      const id = open.shift() ?? first;
      if (approves(id)) continue;
      const writes = (specs.get(id)?.publicWrites(resolvedParams.get(id) ?? {}) ?? []).filter((w) =>
        requireApproval.has(w),
      );
      if (writes.length > 0) {
        fail(
          ['nodes', id],
          'approval_missing',
          `${id} can ${writes.join(', ')} with no approval before it (workflows.security.require_approval)`,
        );
      }
      for (const edge of outEdges.get(id) ?? []) {
        for (const target of targets(edge)) {
          if (nodeSet.has(target) && !seen.has(target)) {
            seen.add(target);
            open.push(target);
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const nodes: Record<string, CompiledNode> = {};
  for (const [id, node] of Object.entries(definition.nodes)) {
    // With no error, every node has its step type.
    const safePoint = specs.get(id)?.safePoint ?? false;
    nodes[id] = {
      id,
      step: node.step,
      role: resolvedRoles.get(id) ?? null,
      params: resolvedParams.get(id) ?? {},
      safePoint,
      edges: outEdges.get(id) ?? [],
    };
  }
  return {
    ok: true,
    workflow: {
      definition,
      id: definition.id,
      version: definition.version,
      start: first,
      nodes,
      edges,
      counters,
      limits,
    },
    errors: [],
    warnings,
  };
}
