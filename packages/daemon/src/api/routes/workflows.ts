// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  NotFound,
  type JsonObject,
  type JsonValue,
  type PlayRecord,
  type WorkflowDefinitionRecord,
} from '@otheater/core';
import type {
  ApiInstalledPackage,
  ApiPackagePreview,
  ApiWorkflowIssue,
  ApiWorkflowRun,
  ApiWorkflowVersion,
  InstallWorkflowPackageResult,
  SimulateWorkflowResult,
  ValidateWorkflowResult,
  WorkflowDiffResult,
} from '@otheater/protocol';
import {
  validateWorkflow,
  validateWorkflowYaml,
  workflowHash,
  type ValidateOptions,
  type ValidationIssue,
  type WorkflowDefinition,
} from '@otheater/workflows';
import { z } from 'zod';
import { diffWorkflows } from '../../workflows/diff.js';
import type { WorkflowPackageInstaller } from '../../workflows/packages/index.js';
import { simulateWorkflow } from '../../workflows/simulate.js';
import { ApiFailure, type ApiHandlers } from '../handlers.js';
import type { CommandRegistrar } from './command.js';
import type { CommandRouteDeps, ReadRouteDeps, WorkflowRouteServices } from './deps.js';
import { paginate } from './paging.js';

/**
 * The workflows over REST (Phase 11b, P10b of docs/26). Every rule below that the plan does not
 * state is [proposta]:
 * - the routes read the library, the bindings and the installer through {@link WorkflowRouteServices};
 *   a daemon that composes none of them answers 503 `unavailable`;
 * - `validate` always answers 200: an invalid definition is an answer, not a failure of the route;
 *   `save` is the one that refuses (`invalid_input`, with the issues in `details.issues`);
 * - `simulate` is the walk of `simulate.ts` (no step runs, nothing is spent), cut at
 *   `workflows.simulate.max_steps`; `on_limit: fail` answers 200 with `ok: false`;
 * - installing a package takes two calls: without `approvedHash` it only previews; with the hash
 *   of the preview it installs, and a package that changed in between is a `conflict`;
 * - a binding without `triggers` takes those of the definition its range reaches (the store does
 *   not inherit them); `triggers: []` is none.
 */

export type { WorkflowRouteServices } from './deps.js';

function servicesOf(deps: { readonly workflows?: WorkflowRouteServices | undefined }) {
  const services = deps.workflows;
  if (services === undefined) {
    throw new ApiFailure('unavailable', 'This daemon runs no workflow engine');
  }
  return services;
}

function packagesOf(services: WorkflowRouteServices): WorkflowPackageInstaller {
  if (services.packages === undefined) {
    throw new ApiFailure('unavailable', 'This daemon has no workflow package installer');
  }
  return services.packages;
}

function issueOf(
  issue: ValidationIssue<string>,
  positions?: ReadonlyMap<ValidationIssue<string>, { line: number; column: number }>,
): ApiWorkflowIssue {
  const at = positions?.get(issue);
  return {
    path: issue.path,
    code: issue.code,
    message: issue.message,
    ...(at === undefined ? {} : { line: at.line, column: at.column }),
  };
}

type Document = { readonly yaml: string } | { readonly definition: JsonObject };

/** The text of the plain issues of a YAML that did not parse. */
function yamlIssues(
  errors: readonly { message: string; position?: { line: number; column: number } }[],
): ApiWorkflowIssue[] {
  return errors.map((error) => ({
    path: '',
    code: 'yaml',
    message: error.message,
    ...(error.position === undefined
      ? {}
      : { line: error.position.line, column: error.position.column }),
  }));
}

/** Validates a document of the body; the same answer for `validate` and `save`. */
export async function checkDocument(
  document: Document,
  options: ValidateOptions,
): Promise<
  | { readonly ok: true; readonly result: ValidateWorkflowResult; readonly definition: JsonObject }
  | { readonly ok: false; readonly result: ValidateWorkflowResult }
> {
  if ('yaml' in document) {
    const checked = validateWorkflowYaml(document.yaml, options);
    if (checked.stage === 'yaml') {
      return {
        ok: false,
        result: {
          ok: false,
          stage: 'yaml',
          workflow: null,
          errors: yamlIssues(checked.errors),
          warnings: [],
        },
      };
    }
    const errors = checked.errors.map((issue) => issueOf(issue, checked.positions));
    const warnings = checked.warnings.map((issue) => issueOf(issue, checked.positions));
    if (!checked.ok) {
      return {
        ok: false,
        result: { ok: false, stage: 'definition', workflow: null, errors, warnings },
      };
    }
    return await finish(checked.workflow, errors, warnings);
  }
  const checked = validateWorkflow(document.definition, options);
  const errors = checked.errors.map((issue) => issueOf(issue));
  const warnings = checked.warnings.map((issue) => issueOf(issue));
  if (!checked.ok) {
    return {
      ok: false,
      result: { ok: false, stage: 'definition', workflow: null, errors, warnings },
    };
  }
  return await finish(checked.workflow, errors, warnings);
}

async function finish(
  workflow: { id: string; version: string; definition: WorkflowDefinition },
  errors: ApiWorkflowIssue[],
  warnings: ApiWorkflowIssue[],
) {
  const definition = JSON.parse(JSON.stringify(workflow.definition)) as JsonObject;
  return {
    ok: true as const,
    definition,
    result: {
      ok: true,
      stage: 'definition' as const,
      workflow: {
        id: workflow.id,
        version: workflow.version,
        hash: await workflowHash(workflow.definition),
      },
      errors,
      warnings,
    },
  };
}

function versionOf(record: WorkflowDefinitionRecord): ApiWorkflowVersion {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the body is dropped on purpose
  const { definition: _definition, ...rest } = record;
  return rest;
}

function runOf(play: PlayRecord): ApiWorkflowRun | undefined {
  const saved = SavedRunShape.safeParse(play.snapshot);
  if (!saved.success) return undefined;
  const { workflow, born, runtime } = saved.data;
  return {
    runId: play.id,
    scenarioId: play.scenarioId,
    workflow,
    born: born ?? null,
    state: play.state,
    steps: runtime.steps,
    migrationPending: runtime.migration !== null && runtime.migration !== undefined,
    need: play.need,
    createdAt: play.createdAt,
    updatedAt: play.updatedAt,
    finishedAt: play.finishedAt,
  };
}

/** The part of the snapshot of a run these routes read (the whole shape is the runtime's). */
const RefShape = z.object({ id: z.string(), version: z.string(), hash: z.string() });
const SavedRunShape = z.object({
  workflow: RefShape,
  born: RefShape.optional(),
  runtime: z.object({
    steps: z.int().min(0),
    migration: z.unknown().optional(),
  }),
});

export function registerWorkflowRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  handlers.register('listWorkflows', async ({ query }) => {
    const { library } = servicesOf(deps);
    const records = await library.list({
      ...(query.workflowId === undefined ? {} : { workflowId: query.workflowId }),
      ...(query.state === undefined ? {} : { states: [query.state] }),
      ...(query.source === undefined ? {} : { source: query.source }),
    });
    return paginate(records.map(versionOf), (item) => [item.workflowId, item.seq], {
      after: query.after,
      limit: query.limit,
    });
  });

  handlers.register('getWorkflowVersion', async ({ params }) => {
    const { library } = servicesOf(deps);
    const record = await library.get(params.workflowId, params.version);
    if (record === undefined) {
      throw new ApiFailure(
        'not_found',
        `The library has no ${params.workflowId}@${params.version}`,
      );
    }
    return { version: versionOf(record), definition: record.definition };
  });

  handlers.register('diffWorkflow', async ({ params, query }) => {
    const { library } = servicesOf(deps);
    const [from, to] = await Promise.all([
      library.get(params.workflowId, query.from),
      library.get(params.workflowId, query.to),
    ]);
    for (const [record, version] of [
      [from, query.from],
      [to, query.to],
    ] as const) {
      if (record === undefined) {
        throw new ApiFailure('not_found', `The library has no ${params.workflowId}@${version}`);
      }
    }
    if (from === undefined || to === undefined) throw new NotFound('unreachable');
    const changes = diffWorkflows(from.definition, to.definition);
    const result: WorkflowDiffResult = {
      workflowId: params.workflowId,
      from: { version: from.version, hash: from.hash },
      to: { version: to.version, hash: to.hash },
      same: from.hash === to.hash,
      changes: changes.map((change) => ({ ...change })),
    };
    return result;
  });

  handlers.register('listWorkflowBindings', async ({ query }) => {
    const { bindings } = servicesOf(deps);
    const records = await bindings.list({
      ...(query.scenarioId === undefined ? {} : { scenarioId: query.scenarioId }),
      ...(query.workflowId === undefined ? {} : { workflowId: query.workflowId }),
      ...(query.state === undefined ? {} : { states: [query.state] }),
    });
    return paginate(records, (item) => [item.seq], { after: query.after, limit: query.limit });
  });

  handlers.register('listWorkflowRuns', async ({ query }) => {
    servicesOf(deps);
    const plays = await deps.store.plays.list({
      ...(query.scenarioId === undefined ? {} : { scenarioId: query.scenarioId }),
      ...(query.status === undefined ? {} : { open: query.status === 'open' }),
    });
    const runs = plays
      .map(runOf)
      .filter((run): run is ApiWorkflowRun => run !== undefined)
      .filter((run) => query.workflowId === undefined || run.workflow.id === query.workflowId);
    return paginate(runs, (item) => [item.createdAt, item.runId], {
      after: query.after,
      limit: query.limit,
    });
  });

  handlers.register('listWorkflowPackages', async () => {
    const installer = packagesOf(servicesOf(deps));
    return { items: [...(await installer.list())] satisfies ApiInstalledPackage[] };
  });
}

export function registerWorkflowCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  register('validateWorkflow', async ({ body }) => {
    const { validateOptions } = servicesOf(deps);
    return (await checkDocument(body, validateOptions())).result;
  });

  register('simulateWorkflow', async ({ body }) => {
    const services = servicesOf(deps);
    const options = services.validateOptions();
    const { max_steps: maxSteps, on_limit: onLimit } = services.settings().simulate;
    let definition: unknown;
    if ('workflowId' in body) {
      const record =
        body.version === undefined
          ? await services.library.active(body.workflowId)
          : await services.library.get(body.workflowId, body.version);
      if (record === undefined) {
        throw new ApiFailure(
          'not_found',
          body.version === undefined
            ? `${body.workflowId} has no active version`
            : `The library has no ${body.workflowId}@${body.version}`,
        );
      }
      definition = record.definition;
    } else if ('yaml' in body) {
      const checked = await checkDocument({ yaml: body.yaml }, options);
      if (!checked.ok) {
        return {
          ok: false,
          reason: 'invalid_definition',
          detail: 'the definition is not valid',
          errors: checked.result.errors,
        } satisfies SimulateWorkflowResult;
      }
      definition = checked.definition;
    } else {
      definition = body.definition;
    }
    const result = simulateWorkflow(definition, {
      maxSteps,
      onLimit,
      validate: options,
      inputs: body.inputs,
      outputs: body.outputs,
      fail: body.fail,
    });
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        detail: result.detail,
        errors: result.errors.map((issue) => issueOf(issue)),
      } satisfies SimulateWorkflowResult;
    }
    return {
      ok: true,
      workflow: result.workflow,
      status: result.status,
      ended: result.ended,
      inputs: result.inputs,
      path: result.path.map((step) => ({ ...step, effects: [...step.effects] })),
      counts: { ...result.counts },
      warnings: result.warnings.map((issue) => issueOf(issue)),
    } satisfies SimulateWorkflowResult;
  });

  register('saveWorkflow', async ({ body }) => {
    const { library, validateOptions } = servicesOf(deps);
    const document: Document =
      'yaml' in body ? { yaml: body.yaml } : { definition: body.definition };
    const checked = await checkDocument(document, validateOptions());
    if (!checked.ok) {
      const first = checked.result.errors[0];
      throw new ApiFailure(
        'invalid_input',
        first === undefined
          ? 'The workflow is not valid'
          : `The workflow is not valid: ${first.path === '' ? '(root)' : first.path}: ${first.message}`,
        { details: { issues: checked.result.errors as unknown as JsonValue } },
      );
    }
    const record = await library.install(checked.definition, {
      source: 'user',
      activate: body.activate,
    });
    return { version: versionOf(record) };
  });

  register('activateWorkflow', async ({ params }) => {
    const { library, settings } = servicesOf(deps);
    const record = await library.activate(params.workflowId, params.version);
    return { version: versionOf(record), runningOnChange: settings().running_on_change };
  });

  register('deactivateWorkflow', async ({ params }) => {
    const { library } = servicesOf(deps);
    return { version: versionOf(await library.deactivate(params.workflowId, params.version)) };
  });

  register('installWorkflowPackage', async ({ body }) => {
    const installer = packagesOf(servicesOf(deps));
    const preview = await installer.preview(body.origin);
    if (body.approvedHash === undefined) {
      return {
        status: 'preview',
        preview: plain(preview) as ApiPackagePreview,
        workflows: [],
      } satisfies InstallWorkflowPackageResult;
    }
    if (body.approvedHash !== preview.hash) {
      throw new Conflict(
        `The package changed since it was previewed (it is ${preview.hash} now); preview it again`,
      );
    }
    // A refused package is refused by the installer (`invalid_input`), which also writes the situation.
    const result = await installer.install(body.origin, {
      approve: (current) => current.hash === body.approvedHash,
    });
    return {
      status: result.status,
      preview: plain(result.preview) as ApiPackagePreview,
      workflows: result.workflows.map((workflow) => ({ ...workflow })),
    } satisfies InstallWorkflowPackageResult;
  });

  register('removeWorkflowPackage', async ({ params }) => {
    await packagesOf(servicesOf(deps)).remove(params.packageId);
    return { removed: params.packageId };
  });

  register('bindWorkflow', async ({ body }) => {
    const { bindings, library } = servicesOf(deps);
    let triggers = body.triggers;
    if (triggers === undefined) {
      // The store does not inherit the triggers of the definition: the route copies them.
      const reached = await library.resolve(body.workflowId, body.versionRange ?? '*');
      const declared = reached?.definition.triggers;
      triggers = Array.isArray(declared)
        ? declared.filter(
            (item): item is JsonObject =>
              typeof item === 'object' && item !== null && !Array.isArray(item),
          )
        : [];
    }
    return await bindings.create({
      scenarioId: body.scenarioId,
      workflowId: body.workflowId,
      versionRange: body.versionRange,
      params: body.params,
      triggers,
      until: body.until,
      budgetUsd: body.budgetUsd,
      budgetPeriod: body.budgetPeriod,
      concurrency: body.concurrency,
      onBusy: body.onBusy,
    });
  });

  register('pauseWorkflowBinding', async ({ params }) => {
    return await servicesOf(deps).bindings.pause(params.bindingId);
  });
  register('resumeWorkflowBinding', async ({ params }) => {
    return await servicesOf(deps).bindings.resume(params.bindingId);
  });
  register('stopWorkflowBinding', async ({ params }) => {
    return await servicesOf(deps).bindings.stop(params.bindingId);
  });
}

/** The same value with every `readonly` of the types dropped (a copy through JSON, for what the API answers). */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
