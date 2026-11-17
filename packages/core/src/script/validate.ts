// SPDX-License-Identifier: MPL-2.0
import type { z } from 'zod';
import { dependencyGraph, findDependencyCycles, transitiveDependencies } from './dag.js';
import { ScriptSchema, type Script } from './schema.js';

/**
 * Validation of the script in code, before any Actor is spent (architecture 5.4, "Validacao do
 * roteiro"; `limits.script_validations` bounds how many times the script goes back to the
 * Scriptwriter). The result is a list of problems with a stable `code` the pipeline can branch on,
 * and a `message` written to the Scriptwriter, in English like every role prompt (5.22).
 *
 * Nothing here throws: a script with many problems gets all of them in one pass.
 */

/** Stable codes. Once published they are never renamed or reused for another meaning. */
export const SCRIPT_ISSUE_CODES = {
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  EMPTY_SCRIPT: 'EMPTY_SCRIPT',
  DUPLICATE_DEMAND_ID: 'DUPLICATE_DEMAND_ID',
  DUPLICATE_CONTRACT_ID: 'DUPLICATE_CONTRACT_ID',
  UNKNOWN_DEPENDENCY: 'UNKNOWN_DEPENDENCY',
  DEPENDENCY_CYCLE: 'DEPENDENCY_CYCLE',
  UNKNOWN_CONTRACT: 'UNKNOWN_CONTRACT',
  INVALID_EXPECTED_FILE: 'INVALID_EXPECTED_FILE',
  PARALLEL_FILE_OVERLAP: 'PARALLEL_FILE_OVERLAP',
  TIMEOUT_ABOVE_MAX: 'TIMEOUT_ABOVE_MAX',
  MISSING_ACCEPTANCE_CRITERIA: 'MISSING_ACCEPTANCE_CRITERIA',
  MISSING_OUTPUT_CONTRACT: 'MISSING_OUTPUT_CONTRACT',
  MISSING_EXPECTED_FILES: 'MISSING_EXPECTED_FILES',
  MISSING_VERIFICATION: 'MISSING_VERIFICATION',
  VERIFY_AND_WAIVER: 'VERIFY_AND_WAIVER',
} as const;

export type ScriptIssueCode = (typeof SCRIPT_ISSUE_CODES)[keyof typeof SCRIPT_ISSUE_CODES];

export interface ScriptIssue {
  readonly code: ScriptIssueCode;
  /** Demands involved, in script order (the cycle order for `DEPENDENCY_CYCLE`). Empty when the problem is the whole script. */
  readonly demandIds: readonly string[];
  /** For the contract rules: the contract id involved. */
  readonly contractId?: string;
  /** Written to the Scriptwriter, in English. */
  readonly message: string;
}

export interface ValidateScriptOptions {
  /** `limits.demand_timeout_max`, in minutes. Without it, `timeoutMin` is not capped. */
  readonly demandTimeoutMaxMin?: number;
}

export type ParseScriptResult =
  | { readonly success: true; readonly script: Script }
  | { readonly success: false; readonly issues: readonly ScriptIssue[] };

/**
 * Checks the shape of a submitted script (what `submit_script` receives). A malformed submission
 * becomes `SCHEMA_INVALID` issues, one per field, so it goes back to the Scriptwriter like any other
 * problem. A well-formed one still needs `validateScript`.
 */
export function parseScript(input: unknown): ParseScriptResult {
  const parsed = ScriptSchema.safeParse(input);
  if (parsed.success) return { success: true, script: parsed.data };
  const issues = parsed.error.issues.map((issue) => {
    const where = formatPath(issue.path);
    const demandId = demandIdAt(input, issue.path);
    return {
      code: SCRIPT_ISSUE_CODES.SCHEMA_INVALID,
      demandIds: demandId === undefined ? [] : [demandId],
      message: `Invalid field ${where}: ${describeZodIssue(issue)}. Fix it and submit the script again.`,
    } satisfies ScriptIssue;
  });
  return { success: false, issues };
}

/** Every problem found in a well-formed script, in a stable order (rule by rule, script order within a rule). */
export function validateScript(script: Script, options: ValidateScriptOptions = {}): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const { demands } = script;

  if (demands.length === 0) {
    issues.push({
      code: SCRIPT_ISSUE_CODES.EMPTY_SCRIPT,
      demandIds: [],
      message: 'The script has no demands. Divide the plan into at least one demand.',
    });
  }

  // Ids: unique, so that every other rule can talk about "demand X" without ambiguity.
  const seenDemands = new Set<string>();
  const reportedDemands = new Set<string>();
  for (const demand of demands) {
    if (seenDemands.has(demand.id) && !reportedDemands.has(demand.id)) {
      reportedDemands.add(demand.id);
      issues.push({
        code: SCRIPT_ISSUE_CODES.DUPLICATE_DEMAND_ID,
        demandIds: [demand.id],
        message: `More than one demand has the id "${demand.id}". Give each demand a unique id.`,
      });
    }
    seenDemands.add(demand.id);
  }
  const seenContracts = new Set<string>();
  const reportedContracts = new Set<string>();
  for (const contract of script.contracts) {
    if (seenContracts.has(contract.id) && !reportedContracts.has(contract.id)) {
      reportedContracts.add(contract.id);
      issues.push({
        code: SCRIPT_ISSUE_CODES.DUPLICATE_CONTRACT_ID,
        demandIds: [],
        contractId: contract.id,
        message: `More than one contract has the id "${contract.id}". Give each contract a unique id.`,
      });
    }
    seenContracts.add(contract.id);
  }

  // Dependencies: they must point at demands of this script.
  for (const demand of demands) {
    for (const dep of unique(demand.dependsOn)) {
      if (!seenDemands.has(dep)) {
        issues.push({
          code: SCRIPT_ISSUE_CODES.UNKNOWN_DEPENDENCY,
          demandIds: [demand.id],
          message: `Demand "${demand.id}" depends on "${dep}", but no demand has that id. Add the demand or remove "${dep}" from dependsOn.`,
        });
      }
    }
  }

  // DAG without cycles. The path reads "A -> B": A depends on B.
  const graph = dependencyGraph(script);
  for (const cycle of findDependencyCycles(graph)) {
    const members = cycle.slice(0, -1);
    issues.push({
      code: SCRIPT_ISSUE_CODES.DEPENDENCY_CYCLE,
      demandIds: members,
      message:
        `Dependency cycle: ${cycle.join(' -> ')} ("A -> B" means A depends on B). ` +
        'The demands cannot all wait for each other. Remove a dependsOn entry that no contract or ' +
        'ordering requirement justifies, or merge the demands.',
    });
  }

  // Contracts cited by each demand must be declared in the script.
  for (const demand of demands) {
    const cited = [
      ...unique(demand.contract.inputs).map((id) => ['inputs', id] as const),
      ...unique(demand.contract.outputs).map((id) => ['outputs', id] as const),
    ];
    for (const [side, id] of cited) {
      if (!seenContracts.has(id)) {
        issues.push({
          code: SCRIPT_ISSUE_CODES.UNKNOWN_CONTRACT,
          demandIds: [demand.id],
          contractId: id,
          message: `Demand "${demand.id}" cites contract "${id}" in contract.${side}, but the script declares no contract with that id. Declare the contract in "contracts" or fix the reference.`,
        });
      }
    }
  }

  // Parallel demands do not share files.
  const scoped: { id: string; scopes: ExpectedFileScope[] }[] = [];
  for (const demand of demands) {
    if (scoped.some((s) => s.id === demand.id)) continue;
    const parsed: ExpectedFileScope[] = [];
    for (const raw of demand.expectedFiles) {
      const scope = normalizeExpectedFile(raw);
      if (scope === undefined) {
        issues.push({
          code: SCRIPT_ISSUE_CODES.INVALID_EXPECTED_FILE,
          demandIds: [demand.id],
          message: `Demand "${demand.id}" lists expectedFiles entry "${raw}", which is not a path inside the repository. Use a path relative to the repository root, without "..", without a leading "/", and end a directory with "/".`,
        });
      } else {
        parsed.push(scope);
      }
    }
    scoped.push({ id: demand.id, scopes: parsed });
  }
  const ancestors = transitiveDependencies(graph);
  for (const [i, a] of scoped.entries()) {
    for (const b of scoped.slice(i + 1)) {
      if (ancestors.get(a.id)?.has(b.id) === true || ancestors.get(b.id)?.has(a.id) === true) {
        continue; // ordered, not parallel
      }
      const shared = sharedPaths(a.scopes, b.scopes);
      if (shared.length === 0) continue;
      issues.push({
        code: SCRIPT_ISSUE_CODES.PARALLEL_FILE_OVERLAP,
        demandIds: [a.id, b.id],
        message:
          `Demands "${a.id}" and "${b.id}" can run in parallel but both declare ${shared.map((p) => `"${p}"`).join(', ')} in expectedFiles. ` +
          `Make one depend on the other (dependsOn), or move the shared work into its own demand that both depend on.`,
      });
    }
  }

  // Timeout within the ceiling.
  const max = options.demandTimeoutMaxMin;
  if (max !== undefined) {
    for (const demand of demands) {
      if (demand.timeoutMin !== undefined && demand.timeoutMin > max) {
        issues.push({
          code: SCRIPT_ISSUE_CODES.TIMEOUT_ABOVE_MAX,
          demandIds: [demand.id],
          message: `Demand "${demand.id}" asks for timeoutMin ${String(demand.timeoutMin)}, above the maximum of ${String(max)} minutes. Lower timeoutMin, or split the demand into smaller ones.`,
        });
      }
    }
  }

  // Every demand is ready: the fields the Actor needs are there. The Author judges the content.
  for (const demand of demands) {
    const id = demand.id;
    if (demand.acceptanceCriteria.length === 0) {
      issues.push({
        code: SCRIPT_ISSUE_CODES.MISSING_ACCEPTANCE_CRITERIA,
        demandIds: [id],
        message: `Demand "${id}" has no acceptanceCriteria. List at least one observable criterion that tells the Actor when the demand is done.`,
      });
    }
    if (demand.contract.outputs.length === 0) {
      issues.push({
        code: SCRIPT_ISSUE_CODES.MISSING_OUTPUT_CONTRACT,
        demandIds: [id],
        message: `Demand "${id}" has no output contract. Declare in contract.outputs what it delivers (files, API, types, schema).`,
      });
    }
    if (demand.expectedFiles.length === 0) {
      issues.push({
        code: SCRIPT_ISSUE_CODES.MISSING_EXPECTED_FILES,
        demandIds: [id],
        message: `Demand "${id}" has no expectedFiles. List the files or directories it will touch; they are used to detect conflicts between parallel demands.`,
      });
    }
    const hasVerify = demand.verify.length > 0;
    const hasWaiver = demand.verifyWaiver !== undefined;
    if (!hasVerify && !hasWaiver) {
      issues.push({
        code: SCRIPT_ISSUE_CODES.MISSING_VERIFICATION,
        demandIds: [id],
        message: `Demand "${id}" has no verify step and no verifyWaiver. Add at least one verify step (a test or lint command), or explain in verifyWaiver why none applies.`,
      });
    } else if (hasVerify && hasWaiver) {
      issues.push({
        code: SCRIPT_ISSUE_CODES.VERIFY_AND_WAIVER,
        demandIds: [id],
        message: `Demand "${id}" has both verify steps and a verifyWaiver. Keep the verify steps and drop the waiver, or drop the steps and keep the waiver.`,
      });
    }
  }

  return issues;
}

// -- expectedFiles ---------------------------------------------------------------------------

export interface ExpectedFileScope {
  /** Normalized repository-relative path, without a trailing slash. */
  readonly path: string;
  /** The entry ended with "/": it stands for everything under the path. */
  readonly directory: boolean;
}

/**
 * Normalizes an `expectedFiles` entry: "\" becomes "/", "." and empty segments go away, ".." folds
 * into the parent. Returns `undefined` for an absolute path, one that leaves the repository, or the
 * repository root itself. Globs are not interpreted: `src/*.ts` is just a name (the architecture
 * asks for the same file, not for patterns). [proposta] A trailing "/" marks a directory.
 */
export function normalizeExpectedFile(raw: string): ExpectedFileScope | undefined {
  const slashed = raw.trim().replaceAll('\\', '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return undefined;
  const parts: string[] = [];
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.pop() === undefined) return undefined;
    } else {
      parts.push(segment);
    }
  }
  if (parts.length === 0) return undefined;
  return { path: parts.join('/'), directory: slashed.endsWith('/') };
}

function overlaps(a: ExpectedFileScope, b: ExpectedFileScope): boolean {
  if (a.path === b.path) return true;
  if (a.directory && b.path.startsWith(`${a.path}/`)) return true;
  if (b.directory && a.path.startsWith(`${b.path}/`)) return true;
  return false;
}

/** Paths both sides touch, naming the more specific one of each pair. Sorted, without repeats. */
function sharedPaths(a: readonly ExpectedFileScope[], b: readonly ExpectedFileScope[]): string[] {
  const shared = new Set<string>();
  for (const x of a) {
    for (const y of b) {
      if (!overlaps(x, y)) continue;
      const deeper = x.path.length >= y.path.length ? x : y;
      shared.add(deeper.directory ? `${deeper.path}/` : deeper.path);
    }
  }
  return [...shared].sort();
}

// -- helpers -----------------------------------------------------------------------------------

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(script)';
  let out = '';
  for (const part of path) {
    out +=
      typeof part === 'number'
        ? `[${String(part)}]`
        : out === ''
          ? String(part)
          : `.${String(part)}`;
  }
  return out;
}

function describeZodIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    return `unknown field(s) ${issue.keys.map((k) => `"${k}"`).join(', ')}`;
  }
  return issue.message;
}

/** The id of the demand a schema issue points into, when `path` is `demands[i]...` and it has a string id. */
function demandIdAt(input: unknown, path: readonly PropertyKey[]): string | undefined {
  if (path[0] !== 'demands' || typeof path[1] !== 'number') return undefined;
  const demands = (input as { demands?: unknown } | null | undefined)?.demands;
  if (!Array.isArray(demands)) return undefined;
  const id = (demands[path[1]] as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
}
