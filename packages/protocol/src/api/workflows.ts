// SPDX-License-Identifier: MPL-2.0
import {
  JsonObjectSchema,
  WORKFLOW_BINDING_ID_PATTERN,
  WORKFLOW_BINDING_STATES,
  WORKFLOW_BUDGET_PERIODS,
  WORKFLOW_DEFINITION_STATES,
  WORKFLOW_HASH_PATTERN,
  WORKFLOW_ID_PATTERN,
  WORKFLOW_ON_BUSY,
  WORKFLOW_SOURCES,
  WORKFLOW_VERSION_PATTERN,
  WorkflowBindingRecordSchema,
  WorkflowDefinitionRecordSchema,
} from '@otheater/core';
import { z } from 'zod';
import { IdempotencyHeadersSchema, PageQuerySchema, pageOf } from './page.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The workflows over REST (Phase 11b, P10b of docs/26): the library (validate, simulate, save,
 * activate, deactivate, diff, list), the installed packages, the bindings of the scenarios and the
 * runs. Every route and every shape here is [proposta]; the plan only says "the routes of
 * validate, simulate, save, activate, deactivate, diff, list, install, bindings and runs".
 * A definition travels as text (`yaml`) or as the parsed document (`definition`), never both.
 */

/** The largest definition as text; the validator has its own limit (`YamlLimits`), this one keeps the body small. */
export const WORKFLOW_YAML_MAX_CHARS = 300_000;

const WorkflowIdSchema = z.string().regex(WORKFLOW_ID_PATTERN);
const WorkflowVersionSchema = z.string().regex(WORKFLOW_VERSION_PATTERN);

/** The workflow of the routes with `:workflowId` and `:version`. */
export const WorkflowVersionParamsSchema = z.strictObject({
  workflowId: WorkflowIdSchema,
  version: WorkflowVersionSchema,
});
export const WorkflowParamsSchema = z.strictObject({ workflowId: WorkflowIdSchema });

/** A definition as the Producer hands it over: the YAML text or the parsed document. */
export const WorkflowDocumentBodySchema = z.union([
  z.strictObject({ yaml: z.string().min(1).max(WORKFLOW_YAML_MAX_CHARS) }),
  z.strictObject({ definition: JsonObjectSchema }),
]);
export type WorkflowDocumentBody = z.infer<typeof WorkflowDocumentBodySchema>;

/** A problem of a definition: where (`nodes.review.params`), which rule and, from a YAML, the line. */
export const ApiWorkflowIssueSchema = z.strictObject({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  line: z.int().min(1).optional(),
  column: z.int().min(1).optional(),
});
export type ApiWorkflowIssue = z.infer<typeof ApiWorkflowIssueSchema>;

/** A saved version without its document (the list); the detail adds `definition`. */
export const ApiWorkflowVersionSchema = WorkflowDefinitionRecordSchema.omit({ definition: true });
export type ApiWorkflowVersion = z.infer<typeof ApiWorkflowVersionSchema>;

export const ApiWorkflowVersionDetailSchema = z.strictObject({
  version: ApiWorkflowVersionSchema,
  definition: JsonObjectSchema,
});
export type ApiWorkflowVersionDetail = z.infer<typeof ApiWorkflowVersionDetailSchema>;

// ---------------------------------------------------------------------------------------------
// validate and simulate
// ---------------------------------------------------------------------------------------------

export const ValidateWorkflowResultSchema = z.strictObject({
  ok: z.boolean(),
  /** `yaml`: the text does not parse; `definition`: it parsed and the validator ran. */
  stage: z.enum(['yaml', 'definition']),
  /** What the document is, when it is valid. */
  workflow: z
    .strictObject({
      id: WorkflowIdSchema,
      version: WorkflowVersionSchema,
      hash: z.string().regex(WORKFLOW_HASH_PATTERN),
    })
    .nullable(),
  errors: z.array(ApiWorkflowIssueSchema),
  warnings: z.array(ApiWorkflowIssueSchema),
});
export type ValidateWorkflowResult = z.infer<typeof ValidateWorkflowResultSchema>;

export const validateWorkflow = defineRoute({
  id: 'validateWorkflow',
  method: 'POST',
  path: '/v1/workflows/validate',
  summary:
    'Checks a definition (YAML text or document) against the validator of the library, saving nothing; the answer is 200 with `ok: false` and the issues, with the line of each when it came as YAML',
  body: WorkflowDocumentBodySchema,
  response: ValidateWorkflowResultSchema,
});

/** What to walk: a document, or a version of the library (the active one when `version` is absent). */
export const SimulateSourceSchema = z.union([
  z.strictObject({ yaml: z.string().min(1).max(WORKFLOW_YAML_MAX_CHARS) }),
  z.strictObject({ definition: JsonObjectSchema }),
  z.strictObject({ workflowId: WorkflowIdSchema, version: WorkflowVersionSchema.optional() }),
]);

export const SimulateWorkflowBodySchema = z.intersection(
  SimulateSourceSchema,
  z.strictObject({
    /** The values of the inputs of the definition. */
    inputs: JsonObjectSchema.optional(),
    /**
     * The output a node gives, by node, to follow another path: one object, or a list for the
     * visits in order (the last repeats). What is not set is made up from the typed output of the
     * step type.
     */
    outputs: z
      .record(z.string(), z.union([JsonObjectSchema, z.array(JsonObjectSchema).min(1)]))
      .optional(),
    /** Nodes whose step fails when the walk gets there. */
    fail: z.array(z.string().min(1)).max(200).optional(),
  }),
);
export type SimulateWorkflowBody = z.infer<typeof SimulateWorkflowBodySchema>;

const SimulatedStepSchema = z.strictObject({
  node: z.string(),
  step: z.string(),
  role: z.string().nullable(),
  output: JsonObjectSchema,
  /** What a real run of the node could cause (`read_code_host`, `write_code_host`, `agent`...). */
  effects: z.array(z.string()),
  via: z.enum(['edge', 'limit', 'no_edge', 'step_failed']),
  edge: z.int().min(0).optional(),
  to: z.string(),
});

export const SimulateWorkflowResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    workflow: z.strictObject({ id: z.string(), version: z.string() }),
    /** `truncated`: the walk reached `workflows.simulate.max_steps` before an end. */
    status: z.enum(['done', 'cancelled', 'failed', 'truncated']),
    ended: z.string(),
    inputs: JsonObjectSchema,
    path: z.array(SimulatedStepSchema),
    counts: z.record(z.string(), z.int().min(0)),
    warnings: z.array(ApiWorkflowIssueSchema),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(['invalid_definition', 'invalid_inputs', 'invalid_outputs', 'step_limit']),
    detail: z.string(),
    errors: z.array(ApiWorkflowIssueSchema),
  }),
]);
export type SimulateWorkflowResult = z.infer<typeof SimulateWorkflowResultSchema>;

export const simulateWorkflow = defineRoute({
  id: 'simulateWorkflow',
  method: 'POST',
  path: '/v1/workflows/simulate',
  summary:
    'Walks a definition (a document, or a saved version) from its start to an end without running a step, opening a session or spending anything; stops at `workflows.simulate.max_steps`',
  body: SimulateWorkflowBodySchema,
  response: SimulateWorkflowResultSchema,
  errors: ['not_found'],
});

// ---------------------------------------------------------------------------------------------
// the library
// ---------------------------------------------------------------------------------------------

export const SaveWorkflowBodySchema = z.intersection(
  WorkflowDocumentBodySchema,
  z.strictObject({
    /** `true` makes it the version new runs are born in; absent, only when the workflow has none yet. */
    activate: z.boolean().optional(),
  }),
);
export type SaveWorkflowBody = z.infer<typeof SaveWorkflowBodySchema>;

export const saveWorkflow = defineRoute({
  id: 'saveWorkflow',
  method: 'POST',
  path: '/v1/workflows',
  summary:
    'Validates and saves a version in the library, as `user`; the same version with the same content is a no-op and with other content is 409 `conflict`; `invalid_input` lists the issues in `details.issues`',
  headers: IdempotencyHeadersSchema,
  body: SaveWorkflowBodySchema,
  response: z.strictObject({ version: ApiWorkflowVersionSchema }),
  errors: ['conflict'],
});

export const ListWorkflowsQuerySchema = PageQuerySchema.extend({
  workflowId: WorkflowIdSchema.optional(),
  state: z.enum(WORKFLOW_DEFINITION_STATES).optional(),
  source: z.enum(WORKFLOW_SOURCES).optional(),
});
export type ListWorkflowsQuery = z.input<typeof ListWorkflowsQuerySchema>;

export const listWorkflows = defineRoute({
  id: 'listWorkflows',
  method: 'GET',
  path: '/v1/workflows',
  summary:
    'The saved versions of the library, by workflow and then by order of saving, without their documents; filter by workflow, state and source',
  query: ListWorkflowsQuerySchema,
  response: pageOf(ApiWorkflowVersionSchema),
});

export const getWorkflowVersion = defineRoute({
  id: 'getWorkflowVersion',
  method: 'GET',
  path: '/v1/workflows/:workflowId/versions/:version',
  summary: 'One saved version with its document',
  params: WorkflowVersionParamsSchema,
  response: ApiWorkflowVersionDetailSchema,
  errors: ['not_found'],
});

/** What activating does to the runs that are open (`workflows.running_on_change`, N295). */
export const ActivateWorkflowResultSchema = z.strictObject({
  version: ApiWorkflowVersionSchema,
  /** `pin`: the open runs stay in their version; `migrate_at_safe_point`: they move at their next safe point. */
  runningOnChange: z.enum(['pin', 'migrate_at_safe_point']),
});
export type ActivateWorkflowResult = z.infer<typeof ActivateWorkflowResultSchema>;

export const activateWorkflow = defineRoute({
  id: 'activateWorkflow',
  method: 'POST',
  path: '/v1/workflows/:workflowId/versions/:version/activate',
  summary:
    'Makes a saved version the one new runs are born in, without restarting the daemon; the open runs follow `workflows.running_on_change`',
  headers: IdempotencyHeadersSchema,
  params: WorkflowVersionParamsSchema,
  response: ActivateWorkflowResultSchema,
  errors: ['not_found'],
});

export const deactivateWorkflow = defineRoute({
  id: 'deactivateWorkflow',
  method: 'POST',
  path: '/v1/workflows/:workflowId/versions/:version/deactivate',
  summary:
    'Turns the active version off, so the workflow has none and a package that brought it can leave; the open runs keep their version, and activating it again is the way back',
  headers: IdempotencyHeadersSchema,
  params: WorkflowVersionParamsSchema,
  response: z.strictObject({ version: ApiWorkflowVersionSchema }),
  errors: ['not_found'],
});

export const WorkflowDiffQuerySchema = z.strictObject({
  from: WorkflowVersionSchema,
  to: WorkflowVersionSchema,
});

/** One difference: the part of the document (`nodes`, `edges`, `inputs`...), the item in it, and both sides. */
export const ApiWorkflowChangeSchema = z.strictObject({
  area: z.string(),
  key: z.string(),
  change: z.enum(['added', 'removed', 'changed']),
  before: z.json().nullable(),
  after: z.json().nullable(),
});
export type ApiWorkflowChange = z.infer<typeof ApiWorkflowChangeSchema>;

export const WorkflowDiffResultSchema = z.strictObject({
  workflowId: WorkflowIdSchema,
  from: z.strictObject({ version: WorkflowVersionSchema, hash: z.string() }),
  to: z.strictObject({ version: WorkflowVersionSchema, hash: z.string() }),
  same: z.boolean(),
  changes: z.array(ApiWorkflowChangeSchema),
});
export type WorkflowDiffResult = z.infer<typeof WorkflowDiffResultSchema>;

export const diffWorkflow = defineRoute({
  id: 'diffWorkflow',
  method: 'GET',
  path: '/v1/workflows/:workflowId/diff',
  summary:
    'What changed between two saved versions, part by part (inputs, limits, nodes, edges, triggers...), not line by line',
  params: WorkflowParamsSchema,
  query: WorkflowDiffQuerySchema,
  response: WorkflowDiffResultSchema,
  errors: ['not_found'],
});

// ---------------------------------------------------------------------------------------------
// the packages
// ---------------------------------------------------------------------------------------------

const PackageOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('git'),
    url: z.string().min(1),
    ref: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  }),
]);
const SignatureStateSchema = z.enum(['verified', 'invalid', 'unverified', 'absent', 'skipped']);

/** What the Producer sees before a package is installed. */
export const ApiPackagePreviewSchema = z.strictObject({
  packageId: z.string().min(1),
  version: z.string().min(1),
  description: z.string().nullable(),
  origin: PackageOriginSchema,
  hash: z.string().regex(WORKFLOW_HASH_PATTERN),
  workflows: z.array(
    z.strictObject({
      id: z.string(),
      version: z.string(),
      path: z.string(),
      description: z.string().nullable(),
    }),
  ),
  permissions: z.strictObject({
    tools: z.array(z.string()),
    plugins: z.array(z.string()),
    effects: z.array(z.string()),
    publicWrites: z.array(z.string()),
  }),
  /** The permission keys the Producer had not approved before (all of them in a first install). */
  newPermissions: z.array(z.string()),
  previousVersion: z.string().nullable(),
  signature: z.strictObject({
    state: SignatureStateSchema,
    signer: z.string().nullable(),
    detail: z.string(),
  }),
  outcome: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('refused'),
      reason: z.enum(['invalid', 'not_signed', 'not_verified']),
      detail: z.string(),
    }),
    z.strictObject({
      kind: z.literal('ready'),
      /** Why the approval cannot be a formality. */
      confirm: z.array(z.enum(['unsigned', 'new_permissions'])),
    }),
  ]),
});
export type ApiPackagePreview = z.infer<typeof ApiPackagePreviewSchema>;

export const InstallWorkflowPackageBodySchema = z.strictObject({
  /** A folder, a file, or `git:<url>#<ref>`. */
  origin: z.string().min(1).max(4096),
  /**
   * The `hash` of the preview the Producer approved. Without it the route only previews
   * (`status: preview`); with it, the package is installed when its hash is still that one, and
   * 409 `conflict` otherwise (the package changed between the preview and the approval).
   */
  approvedHash: z.string().regex(WORKFLOW_HASH_PATTERN).optional(),
});
export type InstallWorkflowPackageBody = z.infer<typeof InstallWorkflowPackageBodySchema>;

export const InstallWorkflowPackageResultSchema = z.strictObject({
  /** `preview`: nothing was saved. `unchanged`: the same version with the same content was already there. */
  status: z.enum(['preview', 'installed', 'updated', 'unchanged']),
  preview: ApiPackagePreviewSchema,
  workflows: z.array(z.strictObject({ id: z.string(), version: z.string(), active: z.boolean() })),
});
export type InstallWorkflowPackageResult = z.infer<typeof InstallWorkflowPackageResultSchema>;

export const installWorkflowPackage = defineRoute({
  id: 'installWorkflowPackage',
  method: 'POST',
  path: '/v1/workflow-packages/install',
  summary:
    'Reads and checks a package (folder, file or git:<url>#<ref>) and answers its preview; with `approvedHash` equal to the preview it installs it. The permissions are always in the preview',
  body: InstallWorkflowPackageBodySchema,
  response: InstallWorkflowPackageResultSchema,
  errors: ['conflict', 'unavailable'],
});

export const ApiInstalledPackageSchema = z.strictObject({
  id: z.string(),
  version: z.string(),
  hash: z.string().regex(WORKFLOW_HASH_PATTERN),
  origin: PackageOriginSchema,
  workflows: z.array(z.string()),
  signature: SignatureStateSchema,
  signer: z.string().nullable(),
  confirmedUnsigned: z.boolean(),
  permissions: z.array(z.string()),
  installedAt: z.int().min(0),
  updatedAt: z.int().min(0),
});
export type ApiInstalledPackage = z.infer<typeof ApiInstalledPackageSchema>;

export const listWorkflowPackages = defineRoute({
  id: 'listWorkflowPackages',
  method: 'GET',
  path: '/v1/workflow-packages',
  summary: 'The installed workflow packages, by id',
  response: z.strictObject({ items: z.array(ApiInstalledPackageSchema) }),
  errors: ['unavailable'],
});

export const removeWorkflowPackage = defineRoute({
  id: 'removeWorkflowPackage',
  method: 'DELETE',
  path: '/v1/workflow-packages/:packageId',
  summary:
    'Removes a package and the versions it brought; 409 `conflict` while one of them is the active version (deactivate or replace it first) or a live run is in it',
  headers: IdempotencyHeadersSchema,
  params: z.strictObject({ packageId: z.string().min(1).max(64) }),
  response: z.strictObject({ removed: z.string() }),
  errors: ['not_found', 'conflict', 'unavailable'],
});

// ---------------------------------------------------------------------------------------------
// the bindings
// ---------------------------------------------------------------------------------------------

export const BindingParamsSchema = z.strictObject({
  bindingId: z.string().regex(WORKFLOW_BINDING_ID_PATTERN),
});

export const ListWorkflowBindingsQuerySchema = PageQuerySchema.extend({
  scenarioId: z.string().min(1).max(256).optional(),
  workflowId: WorkflowIdSchema.optional(),
  state: z.enum(WORKFLOW_BINDING_STATES).optional(),
});
export type ListWorkflowBindingsQuery = z.input<typeof ListWorkflowBindingsQuerySchema>;

export const listWorkflowBindings = defineRoute({
  id: 'listWorkflowBindings',
  method: 'GET',
  path: '/v1/workflow-bindings',
  summary:
    'The bindings of scenarios to workflows, oldest first; filter by scenario, workflow and state',
  query: ListWorkflowBindingsQuerySchema,
  response: pageOf(WorkflowBindingRecordSchema),
});

export const BindWorkflowBodySchema = z.strictObject({
  scenarioId: z.string().min(1).max(256),
  workflowId: WorkflowIdSchema,
  versionRange: z.string().min(1).max(64).optional(),
  params: JsonObjectSchema.optional(),
  /**
   * The triggers of the binding. Absent, the daemon copies the `triggers` of the definition the
   * range reaches (a binding does not inherit them by itself); `[]` means none.
   */
  triggers: z.array(JsonObjectSchema).max(50).optional(),
  /** Epoch ms, a duration from now (`7d`), `none` or null. */
  until: z.union([z.int().min(0), z.string().min(1).max(32), z.null()]).optional(),
  budgetUsd: z.number().positive().nullable().optional(),
  budgetPeriod: z.enum(WORKFLOW_BUDGET_PERIODS).optional(),
  concurrency: z.int().min(1).max(100).optional(),
  onBusy: z.enum(WORKFLOW_ON_BUSY).optional(),
});
export type BindWorkflowBody = z.infer<typeof BindWorkflowBodySchema>;

export const bindWorkflow = defineRoute({
  id: 'bindWorkflow',
  method: 'POST',
  path: '/v1/workflow-bindings',
  summary:
    'Binds a scenario to a workflow (`workflows.allowed` applies); without `triggers` it takes those of the definition; what is left out takes the value of `workflows.binding` and `workflows.budget`',
  headers: IdempotencyHeadersSchema,
  body: BindWorkflowBodySchema,
  response: WorkflowBindingRecordSchema,
  errors: ['not_found', 'conflict', 'unavailable'],
});

export const pauseWorkflowBinding = defineRoute({
  id: 'pauseWorkflowBinding',
  method: 'POST',
  path: '/v1/workflow-bindings/:bindingId/pause',
  summary: 'Pauses a binding: its triggers stop firing until it is resumed',
  headers: IdempotencyHeadersSchema,
  params: BindingParamsSchema,
  response: WorkflowBindingRecordSchema,
  errors: ['not_found', 'conflict', 'unavailable'],
});

export const resumeWorkflowBinding = defineRoute({
  id: 'resumeWorkflowBinding',
  method: 'POST',
  path: '/v1/workflow-bindings/:bindingId/resume',
  summary: 'Resumes a paused binding; 409 `conflict` past its deadline or with no budget left',
  headers: IdempotencyHeadersSchema,
  params: BindingParamsSchema,
  response: WorkflowBindingRecordSchema,
  errors: ['not_found', 'conflict', 'unavailable'],
});

export const stopWorkflowBinding = defineRoute({
  id: 'stopWorkflowBinding',
  method: 'POST',
  path: '/v1/workflow-bindings/:bindingId/stop',
  summary: 'Ends a binding for good; the runs it started go on',
  headers: IdempotencyHeadersSchema,
  params: BindingParamsSchema,
  response: WorkflowBindingRecordSchema,
  errors: ['not_found', 'conflict', 'unavailable'],
});

// ---------------------------------------------------------------------------------------------
// the runs
// ---------------------------------------------------------------------------------------------

const RunRefSchema = z.strictObject({
  id: z.string(),
  version: z.string(),
  hash: z.string(),
});

/** A run of the workflow engine: a play row whose snapshot is that of the engine. */
export const ApiWorkflowRunSchema = z.strictObject({
  /** The id of the run, also its play. */
  runId: z.string(),
  scenarioId: z.string(),
  workflow: RunRefSchema,
  /** The version it was born in, when it migrated (N295) and is in another one now. */
  born: RunRefSchema.nullable(),
  /** The node it is in (or the end it reached). */
  state: z.string(),
  /** How many nodes it went through. */
  steps: z.int().min(0),
  /** A migration asked and waiting for a safe point. */
  migrationPending: z.boolean(),
  need: z.string(),
  createdAt: z.int().min(0),
  updatedAt: z.int().min(0),
  finishedAt: z.int().min(0).nullable(),
});
export type ApiWorkflowRun = z.infer<typeof ApiWorkflowRunSchema>;

export const ListWorkflowRunsQuerySchema = PageQuerySchema.extend({
  scenarioId: z.string().min(1).max(256).optional(),
  workflowId: WorkflowIdSchema.optional(),
  status: z.enum(['open', 'finished']).optional(),
});
export type ListWorkflowRunsQuery = z.input<typeof ListWorkflowRunsQuerySchema>;

export const listWorkflowRuns = defineRoute({
  id: 'listWorkflowRuns',
  method: 'GET',
  path: '/v1/workflow-runs',
  summary:
    'The runs of the workflow engine (not the plays of the play machine), oldest first; filter by scenario, workflow and open or finished',
  query: ListWorkflowRunsQuerySchema,
  response: pageOf(ApiWorkflowRunSchema),
});

export const WORKFLOW_ROUTES = defineRoutes(
  validateWorkflow,
  simulateWorkflow,
  saveWorkflow,
  listWorkflows,
  getWorkflowVersion,
  activateWorkflow,
  deactivateWorkflow,
  diffWorkflow,
  installWorkflowPackage,
  listWorkflowPackages,
  removeWorkflowPackage,
  listWorkflowBindings,
  bindWorkflow,
  pauseWorkflowBinding,
  resumeWorkflowBinding,
  stopWorkflowBinding,
  listWorkflowRuns,
);
