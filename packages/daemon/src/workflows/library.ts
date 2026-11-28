// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  InvalidInput,
  NotFound,
  type JsonObject,
  type Store,
  type WorkflowDefinitionListFilter,
  type WorkflowDefinitionRecord,
  type WorkflowSource,
} from '@otheater/core';
import {
  validateWorkflow,
  workflowHash,
  type ValidateOptions,
  type ValidationIssue,
} from '@otheater/workflows';
import semver from 'semver';
import { type WorkflowsSettings, WORKFLOWS_ALL_INSTALLED } from './config.js';

/**
 * The workflow library of the daemon (docs/24 section 7, N296; plan of Phase 11b, P5): the global
 * set of definitions, kept in `store.workflowDefinitions`. The library is global (it does not
 * belong to a scenario); a scenario reaches a definition through a binding (`bindings.ts`). The
 * store keeps the definition as opaque JSON; this class is what validates it
 * (`@otheater/workflows`) and what computes its hash. Every rule below that is not in docs/24 is
 * [proposta].
 */

/** What the library needs. The settings are read live (the configuration can be reloaded). */
export interface WorkflowLibraryDeps {
  readonly store: Pick<Store, 'workflowDefinitions' | 'plays'>;
  readonly settings: () => WorkflowsSettings;
  /** The registries `validateWorkflow` checks against (roles, step types, installed plugins). */
  readonly validateOptions?: (() => ValidateOptions) | undefined;
  /**
   * Whether a run that is still live was born in this version. Old versions stay while one
   * exists. The default is conservative: any play that is not finished and whose `flowId` is the
   * workflow counts as a live run in every version of it, because a play records an integer
   * `flowVersion` and a definition has a semantic version. [proposta]
   */
  readonly liveRuns?: ((workflowId: string, version: string) => Promise<boolean>) | undefined;
}

export interface InstallOptions {
  readonly source: WorkflowSource;
  /** The installed package it came from; required when `source` is `package`. */
  readonly packageId?: string | undefined;
  /**
   * `true` makes it the version new runs are born in; `false` only saves it. Omitted: it becomes
   * the active version only when the workflow has none yet. [proposta]
   */
  readonly activate?: boolean | undefined;
}

/** The text of the first errors of a validation, for the message of `InvalidInput`. */
export function describeIssues(issues: readonly ValidationIssue[], max = 5): string {
  const shown = issues
    .slice(0, max)
    .map((issue) => `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`);
  const more = issues.length > max ? `; and ${String(issues.length - max)} more` : '';
  return shown.join('; ') + more;
}

export class WorkflowLibrary {
  readonly #deps: WorkflowLibraryDeps;

  constructor(deps: WorkflowLibraryDeps) {
    this.#deps = deps;
  }

  /**
   * Validates the document and saves it as a version of the library. The same version with the
   * same content is idempotent; the same version with other content is a `Conflict` (a version
   * never changes: change the `version` field).
   */
  async install(document: unknown, options: InstallOptions): Promise<WorkflowDefinitionRecord> {
    const result = validateWorkflow(document, this.#deps.validateOptions?.() ?? {});
    if (!result.ok) {
      throw new InvalidInput(`the workflow is not valid: ${describeIssues(result.errors)}`);
    }
    const { definition } = result.workflow;
    const hash = await workflowHash(definition);
    const plain = JSON.parse(JSON.stringify(definition)) as JsonObject;
    const registry = this.#deps.store.workflowDefinitions;
    const saved = await registry.put({
      workflowId: result.workflow.id,
      version: result.workflow.version,
      hash,
      definition: plain,
      source: options.source,
      packageId: options.source === 'package' ? (options.packageId ?? null) : null,
    });
    const hasActive = (await registry.active(saved.workflowId)) !== undefined;
    if (options.activate === true || (options.activate === undefined && !hasActive)) {
      return registry.activate(saved.workflowId, saved.version);
    }
    return saved;
  }

  get(workflowId: string, version: string): Promise<WorkflowDefinitionRecord | undefined> {
    return this.#deps.store.workflowDefinitions.get(workflowId, version);
  }

  active(workflowId: string): Promise<WorkflowDefinitionRecord | undefined> {
    return this.#deps.store.workflowDefinitions.active(workflowId);
  }

  list(filter?: WorkflowDefinitionListFilter): Promise<readonly WorkflowDefinitionRecord[]> {
    return this.#deps.store.workflowDefinitions.list(filter);
  }

  /** Makes a saved version the one new runs are born in. */
  activate(workflowId: string, version: string): Promise<WorkflowDefinitionRecord> {
    return this.#deps.store.workflowDefinitions.activate(workflowId, version);
  }

  /**
   * Deletes a saved version. The active version is kept (`Conflict`), and so is any version while
   * a live run is born in it (`Conflict`): old versions stay while a run uses them.
   */
  async remove(workflowId: string, version: string): Promise<void> {
    const registry = this.#deps.store.workflowDefinitions;
    const record = await registry.get(workflowId, version);
    if (record === undefined) {
      throw new NotFound(`the workflow ${workflowId} has no version ${version}`);
    }
    if (record.state === 'active') {
      throw new Conflict(
        `${workflowId}@${version} is the active version; activate another one first`,
      );
    }
    if (await this.#hasLiveRuns(workflowId, version)) {
      throw new Conflict(
        `${workflowId}@${version} cannot be removed while a live run was born in it`,
      );
    }
    await registry.remove(workflowId, version);
  }

  /**
   * The stored version a binding with this `versionRange` gets: `*` is the active version; an
   * exact version is that one; `1.x` and `1.2.x` are the highest saved version that matches.
   * `undefined` when none does.
   */
  async resolve(
    workflowId: string,
    versionRange: string,
  ): Promise<WorkflowDefinitionRecord | undefined> {
    const registry = this.#deps.store.workflowDefinitions;
    if (versionRange === '*') return registry.active(workflowId);
    if (semver.valid(versionRange) !== null) return registry.get(workflowId, versionRange);
    const saved = await registry.list({ workflowId });
    const matching = saved
      .filter((record) => semver.satisfies(record.version, versionRange))
      .sort((a, b) => semver.rcompare(a.version, b.version));
    return matching[0];
  }

  /** `workflows.default`: the workflow a play is born in when nobody chose one. */
  defaultWorkflowId(): string {
    return this.#deps.settings().default;
  }

  /** Whether `workflows.allowed` lets this workflow be chosen (the library may hold more). */
  isAllowed(workflowId: string): boolean {
    const { allowed } = this.#deps.settings();
    return allowed === WORKFLOWS_ALL_INSTALLED || allowed.includes(workflowId);
  }

  /** Throws `InvalidInput` when `workflows.allowed` does not let this workflow be chosen. */
  assertAllowed(workflowId: string): void {
    if (!this.isAllowed(workflowId)) {
      throw new InvalidInput(`the workflow ${workflowId} is not in workflows.allowed`);
    }
  }

  async #hasLiveRuns(workflowId: string, version: string): Promise<boolean> {
    const probe = this.#deps.liveRuns;
    if (probe !== undefined) return probe(workflowId, version);
    const open = await this.#deps.store.plays.list({ open: true });
    return open.some((play) => play.flowId === workflowId);
  }
}
