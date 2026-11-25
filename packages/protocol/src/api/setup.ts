// SPDX-License-Identifier: MPL-2.0
import {
  PROFILE_KINDS,
  PROFILE_STATES,
  ROLE_IDS,
  ROLE_PRESET_NAMES,
  SETUP_FLOWS,
  SETUP_RUN_ID_PATTERN,
  SETUP_RUN_STATES,
  WHEN_EXHAUSTED_MODES,
} from '@otheater/core';
import { z } from 'zod';
import { LOCAL_SERVERS } from '../config.js';
import { IdempotencyHeadersSchema } from './page.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The setup assistant (architecture 5.7, "Primeira execução e assistente de configuração"; N121;
 * P4 of docs/18). [proposta] The assistant is a flow of steps kept by the daemon: each step has a
 * schema of input and one of output, the run lives in the store (so it survives the TUI closing
 * and the daemon restarting), and nothing enters `config.yaml` before `confirm`, which writes the
 * whole result at once through the same editor as `PUT /v1/config`. The interfaces only draw it.
 *
 * Three flows share the mechanism: `first_run` (the steps of 5.7), `add_account` and
 * `change_preset` (the reuse of 5.7). Each flow is a list of steps ({@link SETUP_FLOW_STEPS}); the
 * last one is always `review`, which takes no input: the run reaches it when the others are done,
 * shows the plan, and `confirm` is what leaves it.
 */

export const SetupFlowSchema = z.enum(SETUP_FLOWS);
export const SetupRunIdSchema = z.string().regex(SETUP_RUN_ID_PATTERN);

/** The steps of the assistant; a flow uses some of them. */
export const SETUP_STEP_IDS = ['detect', 'account', 'preset', 'executors', 'review'] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
export const SetupStepIdSchema = z.enum(SETUP_STEP_IDS);

/** The steps of each flow, in order. `review` is last: it has no input. */
export const SETUP_FLOW_STEPS: Readonly<
  Record<(typeof SETUP_FLOWS)[number], readonly SetupStepId[]>
> = {
  first_run: ['detect', 'preset', 'executors', 'review'],
  add_account: ['account', 'executors', 'review'],
  change_preset: ['preset', 'review'],
};

const profileId = z.string().min(1).max(129);

// ---- what the detection found -----------------------------------------------------------------

/**
 * Why the daemon put a client on or left it out (P18, N321), so the assistant can say why a client
 * was not found and what to do on the screen. [proposta] The same names as the choice of the
 * daemon: `disabled` (turned off in the config), `command_configured`, `found_in_path`,
 * `adapter_configured`, `managed_installed`, `managed_pending` (the adapter is being installed),
 * `adapter_missing` (the client is there, its ACP adapter is not), `not_found` (the client is not
 * in the `PATH`) and `forced_not_found` (turned on, and not in the `PATH`).
 */
export const SETUP_CLIENT_REASONS = [
  'disabled',
  'command_configured',
  'found_in_path',
  'adapter_configured',
  'managed_installed',
  'managed_pending',
  'adapter_missing',
  'not_found',
  'forced_not_found',
] as const;
export const SetupClientReasonSchema = z.enum(SETUP_CLIENT_REASONS);
export type SetupClientReason = z.infer<typeof SetupClientReasonSchema>;

/** A client and whether its adapter can run on this machine. State only: nothing is read from it. */
export const SetupDetectedClientSchema = z.strictObject({
  client: z.string().min(1),
  installed: z.boolean(),
  /** Why (P18): absent when the daemon did not look at the client (a test, an old daemon). */
  reason: SetupClientReasonSchema.optional(),
});
export type SetupDetectedClient = z.infer<typeof SetupDetectedClientSchema>;

/**
 * An account the daemon knows. `hasSecret` and `login` are states (the vault holds a key, the
 * client says it is logged in); the content of a key or a token is never read here.
 */
export const SetupDetectedProfileSchema = z.strictObject({
  profileId,
  client: z.string().min(1),
  kind: z.enum(PROFILE_KINDS),
  state: z.enum(PROFILE_STATES),
  hasSecret: z.boolean(),
  login: z.enum(['logged_in', 'logged_out', 'unknown']).nullable(),
  /** Can serve the roles now: active, and an API key present or the login not known to be gone. */
  usable: z.boolean(),
});
export type SetupDetectedProfile = z.infer<typeof SetupDetectedProfileSchema>;

// ---- what a plan holds ------------------------------------------------------------------------

/** The `profiles.<id>.local` block the cadastro writes: the server and its URL; the rest is the default. */
export const SetupLocalSchema = z.strictObject({
  server: z.enum(LOCAL_SERVERS),
  url: z.string().min(1).max(512),
});
export type SetupLocal = z.infer<typeof SetupLocalSchema>;

/** An Executor the confirmation registers: `executors.<id>` of the configuration and its table row. */
export const SetupExecutorSchema = z.strictObject({
  id: z.string().min(1),
  profileId,
  /** The model id the client takes (the catalog id). */
  model: z.string().min(1),
  /** The name of the model inside the id (`claude-opus`, `minimax-m2`). */
  alias: z.string().min(1),
  effort: z.string().min(1).nullable(),
  provider: z.string().min(1),
  /** `discovered`: found by the catalog of Claude Code or Codex; `registered`: given by the Producer. */
  source: z.enum(['discovered', 'registered']),
  /** `false` keeps it out of the expansion of a preset (`executors.on_register: none`, N136). */
  presetExpand: z.boolean(),
  /** The `profiles.<id>.local` block a local model needs, when the profile has none yet. */
  local: SetupLocalSchema.nullable(),
});
export type SetupExecutor = z.infer<typeof SetupExecutorSchema>;

/** A spending cap of an API account (5.6). `null`: no cap in that period. */
export const SetupBudgetSchema = z.strictObject({
  profileId,
  dailyUsd: z.number().gt(0).nullable(),
  monthlyUsd: z.number().gt(0).nullable(),
});
export type SetupBudget = z.infer<typeof SetupBudgetSchema>;

export const SetupNoteSchema = z.strictObject({
  severity: z.enum(['info', 'warning']),
  code: z.string().min(1),
  role: z.enum(ROLE_IDS).nullable(),
  message: z.string(),
});
export type SetupNote = z.infer<typeof SetupNoteSchema>;

export const SetupRoleListSchema = z.strictObject({
  role: z.enum(ROLE_IDS),
  executors: z.array(z.string().min(1)),
  whenExhausted: z.enum(WHEN_EXHAUSTED_MODES),
});
export type SetupRoleList = z.infer<typeof SetupRoleListSchema>;

/** What `confirm` will write: shown at `review`, and the same data `confirm` applies. */
export const SetupPlanSchema = z.strictObject({
  flow: SetupFlowSchema,
  /** The `roles.preset` to write; `null` when the flow leaves it as it is. */
  preset: z.enum(ROLE_PRESET_NAMES).nullable(),
  /** The list of each role as it will be after the confirmation (resolved, whether or not written). */
  roles: z.array(SetupRoleListSchema),
  executors: z.array(SetupExecutorSchema),
  budgets: z.array(SetupBudgetSchema),
  /** The keys of `config.yaml` the confirmation writes, as dotted paths, for the screen to list. */
  writes: z.array(z.string().min(1)),
  notes: z.array(SetupNoteSchema),
});
export type SetupPlan = z.infer<typeof SetupPlanSchema>;

// ---- the schemas of each step -----------------------------------------------------------------

/** `detect`: the Producer confirms which accounts take part, in order. Absent: all the usable ones. */
export const SetupDetectInputSchema = z.strictObject({
  accounts: z.array(profileId).max(64).optional(),
});
export const SetupDetectOutputSchema = z.strictObject({
  clients: z.array(SetupDetectedClientSchema),
  profiles: z.array(SetupDetectedProfileSchema),
  /** The accounts confirmed, in the order the lists take them. */
  accounts: z.array(profileId),
});

/** `account`: the registered account the flow brings into the roles. */
export const SetupAccountInputSchema = z.strictObject({ profileId });
export const SetupAccountOutputSchema = z.strictObject({
  profile: SetupDetectedProfileSchema,
  /** What the catalog of an official client gave for the heads of the preset in force. */
  discovered: z.array(SetupExecutorSchema),
  notes: z.array(SetupNoteSchema),
});

/** `preset`: the preset to apply. */
export const SetupPresetInputSchema = z.strictObject({ preset: z.enum(ROLE_PRESET_NAMES) });
export const SetupPresetOutputSchema = z.strictObject({
  preset: z.enum(ROLE_PRESET_NAMES),
  /** What the catalogs of the official clients gave for the heads of the preset. */
  discovered: z.array(SetupExecutorSchema),
  /** The lists this preset gives over the accounts confirmed, before any API Executor. */
  roles: z.array(SetupRoleListSchema),
  notes: z.array(SetupNoteSchema),
});

/** An Executor the Producer registers in the flow (the data of `ot executor add`). */
export const SetupExecutorRequestSchema = z.strictObject({
  profileId,
  /** The model id as the catalog lists it. */
  model: z.string().min(1).max(256),
  effort: z.string().min(1).max(32).optional(),
  family: z.string().min(1).max(64).optional(),
  alias: z.string().min(1).max(64).optional(),
  localUrl: z.string().min(1).max(512).optional(),
  localServer: z.enum(LOCAL_SERVERS).optional(),
});
export type SetupExecutorRequest = z.infer<typeof SetupExecutorRequestSchema>;

/**
 * `executors`: the Executors by API (or local) and the cap of each API account. An API account with
 * an Executor and no entry in `budgets` takes the suggested cap (`setup.suggested_budget`); an entry
 * with both fields `null` is an explicit "no cap". An empty step is valid: no API key, no Executor.
 */
export const SetupExecutorsInputSchema = z.strictObject({
  executors: z.array(SetupExecutorRequestSchema).max(32).default([]),
  budgets: z.array(SetupBudgetSchema).max(32).default([]),
});
export const SetupExecutorsOutputSchema = z.strictObject({
  executors: z.array(SetupExecutorSchema),
  /** The caps that will be written: the ones given plus the suggested ones, never one that exists. */
  budgets: z.array(SetupBudgetSchema),
  /** What the checks of the cadastro said that is not an error (a warning on the model). */
  notes: z.array(SetupNoteSchema),
});

/** What the Producer answers at a step: the id says which step, so a stale screen is refused. */
export const SetupStepSubmissionSchema = z.discriminatedUnion('step', [
  z.strictObject({ step: z.literal('detect'), input: SetupDetectInputSchema }),
  z.strictObject({ step: z.literal('account'), input: SetupAccountInputSchema }),
  z.strictObject({ step: z.literal('preset'), input: SetupPresetInputSchema }),
  z.strictObject({ step: z.literal('executors'), input: SetupExecutorsInputSchema }),
]);
export type SetupStepSubmission = z.input<typeof SetupStepSubmissionSchema>;

/** A step already answered, with what was asked and what the daemon made of it. */
export const SetupDoneStepSchema = z.discriminatedUnion('step', [
  z.strictObject({
    step: z.literal('detect'),
    input: SetupDetectInputSchema,
    output: SetupDetectOutputSchema,
  }),
  z.strictObject({
    step: z.literal('account'),
    input: SetupAccountInputSchema,
    output: SetupAccountOutputSchema,
  }),
  z.strictObject({
    step: z.literal('preset'),
    input: SetupPresetInputSchema,
    output: SetupPresetOutputSchema,
  }),
  z.strictObject({
    step: z.literal('executors'),
    input: SetupExecutorsInputSchema,
    output: SetupExecutorsOutputSchema,
  }),
]);
export type SetupDoneStep = z.infer<typeof SetupDoneStepSchema>;

/** What the screen of the current step needs to draw: read at every view, never stored. */
export const SetupPromptSchema = z.discriminatedUnion('step', [
  z.strictObject({
    step: z.literal('detect'),
    clients: z.array(SetupDetectedClientSchema),
    profiles: z.array(SetupDetectedProfileSchema),
  }),
  z.strictObject({
    step: z.literal('account'),
    profiles: z.array(SetupDetectedProfileSchema),
  }),
  z.strictObject({
    step: z.literal('preset'),
    /** The preset in `config.yaml` now; `null` when the file does not name one. */
    current: z.enum(ROLE_PRESET_NAMES).nullable(),
    options: z.array(z.enum(ROLE_PRESET_NAMES)),
  }),
  z.strictObject({
    step: z.literal('executors'),
    /** The API accounts among the confirmed ones, with a key in the vault. */
    apiProfiles: z.array(SetupDetectedProfileSchema),
    suggestedBudget: z.strictObject({
      dailyUsd: z.number().gt(0),
      monthlyUsd: z.number().gt(0),
    }),
  }),
  z.strictObject({ step: z.literal('review'), plan: SetupPlanSchema }),
]);
export type SetupPrompt = z.infer<typeof SetupPromptSchema>;

/** What `confirm` wrote. */
export const SetupResultSchema = z.strictObject({
  preset: z.enum(ROLE_PRESET_NAMES).nullable(),
  /** The Executors registered, by id. */
  executors: z.array(z.string().min(1)),
  /** The keys of `config.yaml` written. */
  written: z.array(z.string().min(1)),
});
export type SetupResult = z.infer<typeof SetupResultSchema>;

export const SetupRunViewSchema = z.strictObject({
  id: SetupRunIdSchema,
  flow: SetupFlowSchema,
  state: z.enum(SETUP_RUN_STATES),
  /** The step the run is at (the last one, `review`, when the others are done). */
  step: SetupStepIdSchema,
  /** The steps of the flow, in order. */
  steps: z.array(SetupStepIdSchema),
  done: z.array(SetupDoneStepSchema),
  /** What to draw at `step`; `null` once the run is confirmed or cancelled. */
  prompt: SetupPromptSchema.nullable(),
  /** Set when the run is confirmed. */
  result: SetupResultSchema.nullable(),
  createdAt: z.int().min(0),
  updatedAt: z.int().min(0),
  finishedAt: z.int().min(0).nullable(),
});
export type SetupRunView = z.infer<typeof SetupRunViewSchema>;

export const SetupFlowStatusSchema = z.strictObject({
  flow: SetupFlowSchema,
  steps: z.array(SetupStepIdSchema),
  /** The run in progress, to resume; at most one per flow. */
  active: SetupRunViewSchema.nullable(),
  /** The last run that ended, confirmed or cancelled. */
  lastFinished: z
    .strictObject({
      id: SetupRunIdSchema,
      state: z.enum(['confirmed', 'cancelled']),
      finishedAt: z.int().min(0),
    })
    .nullable(),
});
export type SetupFlowStatus = z.infer<typeof SetupFlowStatusSchema>;

export const SetupOverviewSchema = z.strictObject({
  /** No first run was confirmed and the configuration names no preset and no Executor. */
  firstRunNeeded: z.boolean(),
  flows: z.array(SetupFlowStatusSchema),
});
export type SetupOverview = z.infer<typeof SetupOverviewSchema>;

/** What a search for the clients again did (P18, N321): the clients it added, and all as they are. */
export const SetupRedetectResultSchema = z.strictObject({
  added: z.array(z.string().min(1)),
  clients: z.array(SetupDetectedClientSchema),
});
export type SetupRedetectResult = z.infer<typeof SetupRedetectResultSchema>;

// ---- the routes -------------------------------------------------------------------------------

const FlowParamsSchema = z.strictObject({ flow: SetupFlowSchema });
const RunParamsSchema = z.strictObject({ runId: SetupRunIdSchema });

export const getSetup = defineRoute({
  id: 'getSetup',
  method: 'GET',
  path: '/v1/setup',
  summary: 'The setup assistant: whether a first run is needed, and the run to resume in each flow',
  response: SetupOverviewSchema,
});

export const redetectSetupClients = defineRoute({
  id: 'redetectSetupClients',
  method: 'POST',
  path: '/v1/setup/redetect',
  summary:
    'Looks for the clients again without a restart (on Windows also in the Path of the registry); a client found enters the pool',
  headers: IdempotencyHeadersSchema,
  response: SetupRedetectResultSchema,
});

export const startSetup = defineRoute({
  id: 'startSetup',
  method: 'POST',
  path: '/v1/setup/:flow/start',
  summary: 'Starts a run of a setup flow (a run in progress of the flow is a conflict: resume it)',
  params: FlowParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: SetupRunViewSchema,
  errors: ['conflict'],
});

export const submitSetupStep = defineRoute({
  id: 'submitSetupStep',
  method: 'POST',
  path: '/v1/setup/:runId/step',
  summary: 'Answers the current step of a run; the daemon validates it and moves to the next',
  params: RunParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: SetupStepSubmissionSchema,
  response: SetupRunViewSchema,
  errors: ['not_found', 'conflict'],
});

export const backSetup = defineRoute({
  id: 'backSetup',
  method: 'POST',
  path: '/v1/setup/:runId/back',
  summary: 'Goes back one step, undoing only the state of the step it leaves',
  params: RunParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: SetupRunViewSchema,
  errors: ['not_found', 'conflict'],
});

export const confirmSetup = defineRoute({
  id: 'confirmSetup',
  method: 'POST',
  path: '/v1/setup/:runId/confirm',
  summary: 'Confirms the review: writes the whole result to the configuration at once',
  params: RunParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: SetupRunViewSchema,
  errors: ['not_found', 'conflict'],
});

export const cancelSetup = defineRoute({
  id: 'cancelSetup',
  method: 'POST',
  path: '/v1/setup/:runId/cancel',
  summary: 'Cancels a run; nothing was written to the configuration',
  params: RunParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: SetupRunViewSchema,
  errors: ['not_found', 'conflict'],
});

export const SETUP_ROUTES = defineRoutes(
  getSetup,
  redetectSetupClients,
  startSetup,
  submitSetupStep,
  backSetup,
  confirmSetup,
  cancelSetup,
);
