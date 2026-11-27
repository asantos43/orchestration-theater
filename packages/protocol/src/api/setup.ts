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
export const SETUP_STEP_IDS = [
  'detect',
  'account',
  'preset',
  'security',
  'executors',
  'review',
] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
export const SetupStepIdSchema = z.enum(SETUP_STEP_IDS);

/**
 * The steps of each flow, in order. `review` is last: it has no input. `security` (N334) is in the
 * list of `first_run` only when the daemon adds it (layer 3 missing, `security.unenforced:
 * refuse`, `setup.unenforced_prompt: ask`): the `steps` of a run and of a flow say whether it is
 * there. It comes before `executors` so the review still goes back to `executors` in one step.
 */
export const SETUP_FLOW_STEPS: Readonly<
  Record<(typeof SETUP_FLOWS)[number], readonly SetupStepId[]>
> = {
  first_run: ['detect', 'preset', 'security', 'executors', 'review'],
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
  /**
   * The `<model>-<effort>` of the preset a `no_account` (N324) or `effort_not_accepted` note is
   * about: the screens fold the notes of one family of models into one line. Absent on the other
   * notes and from older daemons.
   */
  head: z.string().min(1).optional(),
  /**
   * The Executor and the account the note is about, when it is about one (2026-11-26): the review
   * groups the notes by account and words them by `code`, with `message` as the fallback. Absent
   * on the other notes and from older daemons.
   */
  executorId: z.string().min(1).optional(),
  profileId: profileId.optional(),
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

/**
 * `security` (N334, 2026-11-26; [proposta]): the answer to "layer 3 (the sandbox) is missing and
 * `security.unenforced` is `refuse`: the Director will not open here. Write `warn`?". `warn: true`
 * puts `security.unenforced: warn` in the plan; `false` changes nothing, and the review says the
 * Director will not open. A daemon with layer 3, or with `unenforced` already `warn` or `allow`,
 * has no such step.
 */
export const SetupSecurityInputSchema = z.strictObject({ warn: z.boolean() });
export const SetupSecurityOutputSchema = z.strictObject({
  /** What `security.unenforced` was when the question was answered. */
  unenforced: z.enum(['refuse', 'warn', 'allow']),
  /** The value the plan writes; `null`: the file is left as it is. */
  write: z.literal('warn').nullable(),
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
 * N333 [proposta]: the roles the Producer gives to one Executor of the run, in the review.
 *
 * - `mode: add` (default, what N333 did): the Executor enters at the END of the list of each role
 *   named (a role whose list already holds it is left as it is); `roles` has at least one role.
 * - `mode: exact` (N335, 2026-11-27, decided by the owner): after the plan the Executor is in exactly the
 *   roles named. It leaves the lists of the roles not named (the preset may have given it some),
 *   enters at the END of the lists of the named roles that do not hold it yet, and keeps its place
 *   where it already is. `roles` may be empty: the Executor leaves every role.
 *
 * The Executor is named by `executorId` (one the catalogs found) or, when it is registered by the
 * same answer and has no id yet, by `request`: its index in `executors` of the answer (N335,
 * decided by the owner on 2026-11-27: from 0 to 31). Exactly one of the two; the daemon resolves
 * `request` to the id `executors.add` gave.
 */
export const SetupRolePlacementSchema = z
  .strictObject({
    executorId: z.string().min(1).max(512).optional(),
    request: z.number().int().min(0).max(31).optional(),
    mode: z.enum(['add', 'exact']).default('add'),
    roles: z.array(z.enum(ROLE_IDS)).max(ROLE_IDS.length),
  })
  .superRefine((placement, ctx) => {
    if ((placement.executorId === undefined) === (placement.request === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['executorId'],
        message: 'name the Executor by exactly one of executorId and request',
      });
    }
    if (placement.mode === 'add' && placement.roles.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'mode add takes at least one role; use mode exact to take the Executor out of all',
      });
    }
  });
export type SetupRolePlacement = z.infer<typeof SetupRolePlacementSchema>;

/**
 * `executors`: the Executors by API (or local) and the cap of each API account. An API account with
 * an Executor and no entry in `budgets` takes the suggested cap (`setup.suggested_budget`); an entry
 * with both fields `null` is an explicit "no cap". An empty step is valid: no API key, no Executor.
 */
export const SetupExecutorsInputSchema = z.strictObject({
  executors: z.array(SetupExecutorRequestSchema).max(32).default([]),
  budgets: z.array(SetupBudgetSchema).max(32).default([]),
  /**
   * N324 [proposta]: the ids of the Executors the catalogs found for the preset (the `discovered`
   * of the `account` or `preset` step) that the person unchecked: they are left out of the plan.
   * An id that is not one of them is refused.
   */
  exclude: z.array(z.string().min(1).max(512)).max(64).default([]),
  /**
   * N333 [proposta]: the roles given, at the review, to an Executor the preset leaves without one
   * (the review goes back to this step with the same answer plus this field). The id must be one
   * of the run: found by the catalogs and not excluded, or registered by this answer.
   */
  roles: z.array(SetupRolePlacementSchema).max(64).default([]),
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
  z.strictObject({ step: z.literal('security'), input: SetupSecurityInputSchema }),
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
    step: z.literal('security'),
    input: SetupSecurityInputSchema,
    output: SetupSecurityOutputSchema,
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
    step: z.literal('security'),
    /** Whether layer 3 (the sandbox) is there; the step exists only when it is not. */
    layer3: z.boolean(),
    /** The `security.unenforced` in `config.yaml` now. */
    unenforced: z.enum(['refuse', 'warn', 'allow']),
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
  /**
   * The keys written that only a restart of the daemon takes in (N334: `security.unenforced` is
   * read at the start). Absent from a daemon older than N334 and when there is none.
   */
  restart: z.array(z.string().min(1)).optional(),
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

/** The clients whose ACP adapter OTheater installs itself (P13 of Phase 10; the I key of P18). */
export const SETUP_ADAPTER_CLIENTS = ['claude-code', 'codex'] as const;
export const SetupAdapterClientSchema = z.enum(SETUP_ADAPTER_CLIENTS);
export type SetupAdapterClient = z.infer<typeof SetupAdapterClientSchema>;

/**
 * What the install of an adapter from the assistant did (P18, N321, the I key). A failed download
 * is an answer, not an error: the screen says why (`failure`) and the person may try again.
 * [proposta] After an install that worked the daemon looks for the clients again, so the client
 * enters the pool without a restart; `added` and `clients` are what that search gave.
 */
export const SetupAdapterInstallResultSchema = z.strictObject({
  client: SetupAdapterClientSchema,
  /** The package of the adapter (`claude-agent-acp`, `codex-acp`). */
  adapter: z.string().min(1),
  /** The pinned version that was installed (or that failed). */
  version: z.string().min(1),
  installed: z.boolean(),
  /** Why the install failed (`<code>: <message>`); `null` when it worked. */
  failure: z.string().min(1).nullable(),
  added: z.array(z.string().min(1)),
  clients: z.array(SetupDetectedClientSchema),
});
export type SetupAdapterInstallResult = z.infer<typeof SetupAdapterInstallResultSchema>;

// ---- the models of an account (N324) ----------------------------------------------------------

/**
 * How the catalog of the client answered: `listed` (it lists the models of the account),
 * `assisted` (it cannot list them, as OpenCode: the person types the model), `unavailable` (the
 * read failed: `reason` says why) and `none` (the client is not installed).
 */
export const SETUP_MODEL_CATALOG_STATES = ['listed', 'assisted', 'unavailable', 'none'] as const;
export type SetupModelCatalogState = (typeof SETUP_MODEL_CATALOG_STATES)[number];

/**
 * What a floating id stands for (the `floating` of a model): `account`, the model the client
 * recommends for the account, chosen by its plan; `family`, the newest model of a family.
 */
export const SETUP_MODEL_FLOATING_KINDS = ['account', 'family'] as const;
export type SetupModelFloating = (typeof SETUP_MODEL_FLOATING_KINDS)[number];

/** One model the catalog lists for the account, with what the preset and the configuration say of it. */
export const SetupModelSchema = z.strictObject({
  /** The model id as the catalog lists it (what `SetupExecutorRequest.model` takes). */
  id: z.string().min(1),
  name: z.string().min(1).nullable(),
  family: z.string().min(1).nullable(),
  efforts: z.array(z.string().min(1)),
  local: z.boolean(),
  contextWindow: z.int().min(0).nullable(),
  /**
   * The id is an alias the client resolves to a model that can change (N324, the owner on
   * 2026-11-26: the screen says so); null for a fixed id or when the catalog does not say.
   */
  floating: z.enum(SETUP_MODEL_FLOATING_KINDS).nullable(),
  /**
   * The Executors of the preset this model fills on the account (the `discovered` the `account`
   * step would give): empty when the preset does not name it. Unchecking the model is putting
   * these ids in `exclude`.
   */
  preset: z.array(z.strictObject({ id: z.string().min(1), effort: z.string().min(1).nullable() })),
  /** The ids of `executors.<id>` of the configuration that already run this model on the account. */
  registered: z.array(z.string().min(1)),
});
export type SetupModel = z.infer<typeof SetupModelSchema>;

/**
 * `GET /v1/setup/models/:client/:name` (N324): after the login of an account, whether the client
 * says it is logged in and the models its catalog lists, so a screen asks which ones enter.
 * [proposta] `login` is asked to the client now (the same probe as the `detect` step); `null` for
 * an API account. Nothing is written: the choice goes in the `executors` step (requests and
 * `exclude`).
 */
export const SetupModelsSchema = z.strictObject({
  profileId,
  kind: z.enum(PROFILE_KINDS),
  login: z.enum(['logged_in', 'logged_out', 'unknown']).nullable(),
  /** The preset the marks of `preset` follow: `roles.preset`, or the default one. */
  preset: z.enum(ROLE_PRESET_NAMES),
  catalog: z.enum(SETUP_MODEL_CATALOG_STATES),
  /** Why the catalog is `unavailable`; null otherwise. */
  reason: z.string().min(1).nullable(),
  models: z.array(SetupModelSchema),
  /** What the match with the preset said (an effort the model does not take, say). */
  notes: z.array(SetupNoteSchema),
});
export type SetupModels = z.infer<typeof SetupModelsSchema>;

// ---- the routes -------------------------------------------------------------------------------

const FlowParamsSchema = z.strictObject({ flow: SetupFlowSchema });
const RunParamsSchema = z.strictObject({ runId: SetupRunIdSchema });
const AdapterParamsSchema = z.strictObject({ client: SetupAdapterClientSchema });

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

export const installSetupAdapter = defineRoute({
  id: 'installSetupAdapter',
  method: 'POST',
  path: '/v1/setup/adapters/:client/install',
  summary:
    'Installs the ACP adapter of a client (the pinned version, from the npm registry) and looks for the clients again; a failed download is said in the answer',
  params: AdapterParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: SetupAdapterInstallResultSchema,
  errors: ['unavailable'],
});

export const getSetupModels = defineRoute({
  id: 'getSetupModels',
  method: 'GET',
  path: '/v1/setup/models/:client/:name',
  summary:
    'Whether an account is logged in (asked to the client) and the models its catalog lists, marked with the Executors of the preset each fills',
  params: z.strictObject({ client: z.string().min(1).max(64), name: z.string().min(1).max(128) }),
  response: SetupModelsSchema,
  errors: ['not_found', 'unavailable'],
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
  installSetupAdapter,
  getSetupModels,
  startSetup,
  submitSetupStep,
  backSetup,
  confirmSetup,
  cancelSetup,
);
