// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  InvalidInput,
  type Clock,
  type JsonObject,
  type JsonValue,
  type PlayRecord,
  type Store,
  type StoreTransaction,
} from '@otheater/core';
import {
  WorkflowRefSchema,
  buildDaemonEvent,
  type DaemonEventPayloads,
  type WorkflowMigrationRefusal,
  type WorkflowMigrationTrigger,
  type WorkflowRef,
  type WorkflowRunRefusal,
} from '@otheater/protocol';
import {
  BUILTIN_STEP_TYPES,
  compareVersions,
  DURATION_PATTERN,
  validateWorkflow,
  workflowHash,
  type InputType,
  type ValidWorkflow,
  type ValidateOptions,
} from '@otheater/workflows';
import {
  initialTransition,
  transition,
  createActor,
  type AnyMachineSnapshot,
  type AnyStateMachine,
} from 'xstate';
import { z } from 'zod';
import type { AskApproval } from '../browser/approval.js';
import { situationText } from '../situations.js';
import type { PluginEffectRegistry } from '../workspace/plugin-effects.js';
import type { WorkflowRunningOnChange } from './config.js';
import { buildWorkflowMachine, type RunContext, type RunEvent } from './machine.js';
import {
  carryCounts,
  hasOpenEffects,
  isSafeNode,
  mappingOf,
  mapState,
  MigrationRequestSchema,
  type MigrationCheck,
  type MigrationRequest,
} from './migrate.js';
import { DEFAULT_WORKFLOW_RUNTIME, type WorkflowRuntimeSettings } from './runtime-config.js';
import type { ToolCaller } from './steps/call-tool.js';
import type { CodeHostStepDeps } from './steps/codehost/deps.js';
import { GENERIC_STEP_RUNNERS } from './steps/index.js';
import type { StepContext, StepDeps, StepResult, StepRunner } from './steps/types.js';

/**
 * The runtime of the workflow engine (docs/24 §6; plan of Phase 11b, P2). It builds the XState
 * machine of a definition through the compiler of P1, drives it one node at a time, and keeps the
 * run in the store so a restart goes on from where it was. It is to a workflow what the
 * `PlayRunner` is to the `play`, and it follows it:
 *
 * - the transition is the pure `transition()`; each one is written in ONE `store.transaction` (the
 *   record of the run, its snapshot and the events of the transition), so the state on disk is
 *   always one the machine was in;
 * - the work of a node (`StepRunner`) runs after the state that asks for it is saved, and a restart
 *   runs it again with the same idempotency key: a node with a side effect goes through `runEffect`,
 *   so the effect is never repeated;
 * - the runs of one daemon run in parallel, each one by its own loop.
 *
 * [proposta] A run is a record of `plays` (so the open runs are found by the same recovery, and the
 * run id is the `playId` of its events): `flowId` is the id of the definition, `flowVersion` the
 * major of its semver (at least 1), `state` the current node or `done`, `cancelled` or `failed`,
 * and `counters` the uses of the limited edges. The snapshot is
 * `{workflow: {id, version, hash}, machine, runtime}` (docs/24 §6): `machine` is the persisted XState
 * snapshot, and `runtime` what the driver needs (the visits of each node, the memo of the node in
 * flight, the steps so far).
 *
 * A saved run is restored only with the definition it was started with: the runtime asks the
 * {@link WorkflowSource} for `{id, version}`, validates it again and compares the hash. A missing or
 * changed definition is a `workflow.run.refused` event, and the run is not touched (the migration
 * between versions is P3/P4).
 */

/** Where the runtime finds the definition a saved run needs (the library of P5, or a fake). [proposta] */
export interface WorkflowSource {
  /** The definition as written (a parsed document, or a promise of one) with this id and version; `undefined` when there is none. */
  resolve(ref: { id: string; version: string }): unknown;
}

/** What the runtime needs from a logger (pino fits). */
export interface WorkflowRuntimeLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface WorkflowRuntimeOptions {
  readonly store: Store;
  /** Stamps nothing itself: the waits (`wait_event`, the deadlines) read it. */
  readonly clock: Clock;
  /** `workflows.runtime`; the defaults when absent. */
  readonly settings?: WorkflowRuntimeSettings | undefined;
  /** The code of the step types; default the five generic ones. Whoever adds step types adds them here. */
  readonly steps?: readonly StepRunner[] | undefined;
  /** Calls the tools of the plugins (`call_tool`). */
  readonly tools?: ToolCaller | undefined;
  /** Opens a question to the Producer (`approval`). */
  readonly ask?: AskApproval | undefined;
  /** The verifiers of the effects of the plugins (`call_tool` uses the one of its tool). */
  readonly pluginEffects?: PluginEffectRegistry | undefined;
  /** The ports and the security settings of the code host steps (P8); without it they fail with `code_host_unavailable`. */
  readonly codeHost?: CodeHostStepDeps | undefined;
  /** The definitions of the saved runs; without it a run cannot be resumed. */
  readonly source?: WorkflowSource | undefined;
  /** The rest of the options of the validator (roles, installed plugins and tools, the approval rule...). */
  readonly validate?: Omit<ValidateOptions, 'stepTypes'> | undefined;
  readonly logger?: WorkflowRuntimeLogger | undefined;
  /**
   * `workflows.running_on_change`, read live (P4, N295): with `migrate_at_safe_point`, the
   * activation of a version (`onActivated`) asks the migration of the open runs of the workflow;
   * with `pin` (default) it asks nothing. A migration asked by name (`requestMigration`) is
   * allowed in both.
   */
  readonly runningOnChange?: (() => WorkflowRunningOnChange) | undefined;
}

export interface StartWorkflowInput {
  /** The id of the run: also its `playId` and the start of every idempotency key. */
  readonly runId: string;
  readonly scenarioId: string;
  /** The definition as written (a parsed document); the runtime validates it. */
  readonly definition: unknown;
  /** The values of the inputs of the definition; the defaults fill what is missing. */
  readonly inputs?: Readonly<Record<string, unknown>> | undefined;
  /** The `need` of the record; default `workflow:<id>`. */
  readonly need?: string | undefined;
}

export type StartWorkflowResult =
  | { readonly ok: true; readonly runId: string; readonly workflow: WorkflowRef }
  | {
      readonly ok: false;
      readonly refusal: WorkflowRunRefusal;
      readonly detail: string;
    };

/** What the driver keeps of a run beyond the machine. */
const RuntimeStateSchema = z.strictObject({
  /** How many visits of each node ended. */
  visits: z.record(z.string(), z.int().min(0)),
  /** What the node in flight saved for a restart (`StepMemo`); emptied when the node ends. */
  memo: z.record(z.string(), z.json()),
  /** How many nodes the run went through. */
  steps: z.int().min(0),
  /** The visit whose `workflow.step.started` was written and whose end was not. */
  inFlight: z.strictObject({ node: z.string().min(1), ordinal: z.int().min(1) }).nullable(),
  /** How many `approval` steps ended approved (P8: a public write checks it again). */
  approvals: z.int().min(0).default(0),
  /** A migration asked and not made yet (P4, N295): it waits for a safe point, and a restart keeps it. */
  migration: MigrationRequestSchema.nullable().default(null),
});
type RuntimeState = z.infer<typeof RuntimeStateSchema>;

/** The snapshot of a run in the record (docs/24 §6). */
const SavedRunSchema = z.object({
  workflow: WorkflowRefSchema,
  /** The version the run was born in (P4, N295); absent in a snapshot saved before it, where it is `workflow`. */
  born: WorkflowRefSchema.optional(),
  machine: z.record(z.string(), z.json()),
  runtime: RuntimeStateSchema,
});

function toJson(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** Whether a value fits the type of an input (the same rule the validator applies to a default). */
function inputFits(type: InputType, value: unknown): boolean {
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
 * The inputs of a run: what was given, then the defaults. [proposta] An input that is required
 * and missing, one that does not fit its type, and a name the definition does not declare are all
 * refusals (`invalid_inputs`), so a typo is never run in silence.
 */
export function resolveRunInputs(
  workflow: ValidWorkflow,
  given: Readonly<Record<string, unknown>> = {},
):
  | { readonly ok: true; readonly inputs: JsonObject }
  | { readonly ok: false; readonly detail: string } {
  const declared = workflow.definition.inputs ?? {};
  const problems: string[] = [];
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(declared, name)) problems.push(`the input ${name} is not declared`);
  }
  const inputs: Record<string, JsonValue> = {};
  for (const [name, spec] of Object.entries(declared)) {
    const supplied = Object.hasOwn(given, name) ? given[name] : undefined;
    const value = supplied ?? spec.default;
    if (value === undefined) {
      if (spec.required ?? spec.default === undefined)
        problems.push(`the input ${name} is required`);
      continue;
    }
    if (!inputFits(spec.type, value)) {
      problems.push(`the input ${name} does not fit its type`);
      continue;
    }
    inputs[name] = value as JsonValue;
  }
  return problems.length === 0 ? { ok: true, inputs } : { ok: false, detail: problems.join('; ') };
}

/** A run loaded in memory: its definition, machine and where it is. */
interface LoadedRun {
  readonly record: PlayRecord;
  readonly workflow: ValidWorkflow;
  readonly ref: WorkflowRef;
  /** The version the run was born in; `ref` is the one it is in now. */
  readonly born: WorkflowRef;
  readonly machine: AnyStateMachine;
  snapshot: AnyMachineSnapshot;
  runtime: RuntimeState;
}

/** A run whose loop is going in this process. */
interface ActiveRun {
  readonly runId: string;
  loaded: LoadedRun;
  /** The daemon is stopping: nothing more is written (a restart picks the run up). */
  readonly stop: AbortController;
  /** `cancel` was called. */
  readonly cancel: AbortController;
  cancelReason: string | undefined;
  done: Promise<void>;
  /** The writes of the run go one after the other (see `#serial`). */
  chain: Promise<void>;
}

/** What a migration asked gives back (P4, N295). */
export type MigrationOutcome =
  | {
      readonly status: 'applied';
      readonly from: WorkflowRef;
      readonly to: WorkflowRef;
      readonly toState: string;
    }
  | { readonly status: 'pending' }
  | {
      readonly status: 'refused';
      readonly reason: WorkflowMigrationRefusal;
      readonly detail: string;
    };

/** The new version of a run, ready to be written. */
interface PreparedMigration {
  readonly target: ValidWorkflow;
  readonly ref: WorkflowRef;
  readonly map: Readonly<Record<string, string>>;
  /** The inputs of the run as the new definition has them (the defaults of new inputs filled in). */
  readonly inputs: JsonObject;
}

const NO_LOGGER: WorkflowRuntimeLogger = { warn: () => undefined };

/** The first of the major of a semver, at least 1 (`PlayRecord.flowVersion` is an integer >= 1). */
function flowVersionOf(version: string): number {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= 1 ? major : 1;
}

/** Drives the runs of the workflow engine in this daemon. */
export class WorkflowRuntime {
  readonly #store: Store;
  readonly #deps: StepDeps;
  readonly #steps: ReadonlyMap<string, StepRunner>;
  readonly #source: WorkflowSource | undefined;
  readonly #validate: Omit<ValidateOptions, 'stepTypes'>;
  readonly #logger: WorkflowRuntimeLogger;
  readonly #runningOnChange: () => WorkflowRunningOnChange;
  readonly #active = new Map<string, ActiveRun>();
  #stopped = false;

  constructor(options: WorkflowRuntimeOptions) {
    this.#store = options.store;
    this.#deps = {
      store: options.store,
      clock: options.clock,
      settings: options.settings ?? DEFAULT_WORKFLOW_RUNTIME,
      tools: options.tools,
      ask: options.ask,
      pluginEffects: options.pluginEffects,
      codeHost: options.codeHost,
    };
    this.#steps = new Map(
      (options.steps ?? GENERIC_STEP_RUNNERS).map((runner) => [runner.type, runner]),
    );
    this.#source = options.source;
    this.#validate = options.validate ?? {};
    this.#logger = options.logger ?? NO_LOGGER;
    this.#runningOnChange = options.runningOnChange ?? (() => 'pin');
  }

  /**
   * Starts a run: validates the definition and the inputs, writes the record in its first node and
   * the `workflow.run.started` event, and begins the loop (which goes on in the background: `idle`
   * waits for it). A definition or inputs that cannot run give `ok: false` and a
   * `workflow.run.refused` event; nothing else is written. A `runId` already in use rejects with `Conflict`.
   */
  async start(input: StartWorkflowInput): Promise<StartWorkflowResult> {
    if (this.#stopped) throw new Conflict('The workflow runtime is stopped');
    const checked = await this.#check(input.definition);
    if (!checked.ok) {
      await this.#refuse(input.scenarioId, input.runId, checked);
      return { ok: false, refusal: checked.refusal, detail: checked.detail };
    }
    const { workflow, ref } = checked;
    const resolved = resolveRunInputs(workflow, input.inputs);
    if (!resolved.ok) {
      const refusal = { refusal: 'invalid_inputs', detail: resolved.detail, ref } as const;
      await this.#refuse(input.scenarioId, input.runId, refusal);
      return { ok: false, refusal: 'invalid_inputs', detail: resolved.detail };
    }
    const machine = buildWorkflowMachine(workflow);
    const [snapshot] = initialTransition(machine, { inputs: resolved.inputs });
    const runtime: RuntimeState = {
      visits: {},
      memo: {},
      steps: 0,
      inFlight: null,
      approvals: 0,
      migration: null,
    };
    const record = await this.#store.transaction(async (tx) => {
      const created = await tx.plays.create({
        id: input.runId,
        scenarioId: input.scenarioId,
        need: input.need ?? `workflow:${workflow.id}`,
        flowId: workflow.id,
        flowVersion: flowVersionOf(workflow.version),
        state: workflow.start,
        snapshot: toJson({
          workflow: ref,
          born: ref,
          machine: machine.getPersistedSnapshot(snapshot),
          runtime,
        }),
        counters: {},
        parentPlayId: null,
      });
      await this.#emit(tx, input.scenarioId, input.runId, 'workflow.run.started', {
        workflow: ref,
        start: workflow.start,
        inputs: Object.keys(resolved.inputs),
      });
      return created;
    });
    this.#launch({ record, workflow, ref, born: ref, machine, snapshot, runtime }, undefined);
    return { ok: true, runId: input.runId, workflow: ref };
  }

  /**
   * After a restart: loads the saved run and goes on from its node. A run that is finished, is
   * already going here, or is not a workflow run is left alone; one whose definition is missing or
   * changed is refused (`workflow.run.refused`) and not touched. Returns whether the run is going.
   */
  async resume(runId: string): Promise<boolean> {
    if (this.#stopped) throw new Conflict('The workflow runtime is stopped');
    if (this.#active.has(runId)) return true;
    const record = await this.#store.plays.get(runId);
    if (record?.finishedAt !== null) return false;
    const loaded = await this.#load(record);
    if (loaded === undefined) return false;
    this.#launch(loaded, undefined);
    return true;
  }

  /** Resumes every open run of the store that is a workflow run; the ids come back by outcome. */
  async resumeAll(): Promise<{ resumed: string[]; refused: string[] }> {
    const open = await this.#store.plays.list({ open: true });
    const resumed: string[] = [];
    const refused: string[] = [];
    for (const play of open) {
      if (!SavedRunSchema.safeParse(play.snapshot).success) continue;
      if (await this.resume(play.id)) resumed.push(play.id);
      else refused.push(play.id);
    }
    return { resumed: resumed.sort(), refused: refused.sort() };
  }

  /**
   * Cancels a run: the step in flight is aborted and the machine takes `workflow.cancel`, so the run
   * ends `cancelled`. A run that is not going here is loaded and cancelled the same way. Returns
   * `false` when there is no such run, it is finished, or its definition cannot be loaded.
   */
  async cancel(runId: string, reason = 'cancelled'): Promise<boolean> {
    const running = this.#active.get(runId);
    if (running !== undefined) {
      running.cancelReason ??= reason;
      running.cancel.abort();
      await running.done;
      return true;
    }
    const record = await this.#store.plays.get(runId);
    if (record?.finishedAt !== null) return false;
    const loaded = await this.#load(record);
    if (loaded === undefined) return false;
    const launched = this.#launch(loaded, reason);
    await launched.done;
    return true;
  }

  /** Whether the loop of this run is going in this process. */
  isActive(runId: string): boolean {
    return this.#active.has(runId);
  }

  /** Resolves when no run is going. */
  async idle(): Promise<void> {
    for (;;) {
      const going = [...this.#active.values()].map((run) => run.done);
      if (going.length === 0) return;
      await Promise.allSettled(going);
    }
  }

  /**
   * Stops every loop and writes nothing more: a run in the middle of a node stays as the store has
   * it, and `resume` takes it from there. It is what the end of the daemon (or a simulated kill in
   * a test) does.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const run of this.#active.values()) run.stop.abort();
    await this.idle();
  }

  /**
   * Asks the migration of a run to another version of its workflow (N295; P4). The new definition
   * must say where the run goes (`migrate_from`). The migration is made only at a safe point
   * (`migrate.ts`): a run that is at one now (not going in this process, nothing in flight, no
   * effect open) is migrated at once (`applied`); any other waits (`pending`), and the request is
   * saved with the run, so a restart keeps it. What can already be seen to be impossible (no such
   * version, no mapping, inputs that do not fit, a version that is not newer) is `refused` now,
   * with a `workflow.migration_refused` event; what depends on the node the run reaches (the
   * mapping of that node) is refused at the safe point, with the same event, and the run goes on
   * in its version. A new request replaces one still waiting.
   */
  async requestMigration(
    runId: string,
    toVersion: string,
    trigger: WorkflowMigrationTrigger = 'request',
  ): Promise<MigrationOutcome> {
    if (this.#stopped) throw new Conflict('The workflow runtime is stopped');
    const request: MigrationRequest = { toVersion, trigger };
    const active = this.#active.get(runId);
    const record = active?.loaded.record ?? (await this.#store.plays.get(runId));
    if (record === undefined) {
      return { status: 'refused', reason: 'run_finished', detail: `No run ${runId}` };
    }
    const saved = SavedRunSchema.safeParse(record.snapshot);
    if (!saved.success) {
      return {
        status: 'refused',
        reason: 'run_finished',
        detail: `${runId} is not a run of the workflow engine`,
      };
    }
    if (record.finishedAt !== null) {
      const refusal = { reason: 'run_finished', detail: `${runId} is finished` } as const;
      await this.#writeRefusal(record, saved.data.workflow, request, refusal);
      return { status: 'refused', ...refusal };
    }
    if (active !== undefined) {
      const prepared = await this.#prepare(active.loaded, toVersion);
      if (!prepared.ok) {
        await this.#refuseMigration(active.loaded, request, prepared, false);
        return { status: 'refused', reason: prepared.reason, detail: prepared.detail };
      }
      return this.#serial(active, async (): Promise<MigrationOutcome> => {
        active.loaded.runtime = { ...active.loaded.runtime, migration: request };
        await this.#store.plays.update(runId, { snapshot: this.#snapshotOf(active.loaded) });
        return { status: 'pending' };
      });
    }
    const loaded = await this.#load(record);
    if (loaded === undefined) {
      return {
        status: 'refused',
        reason: 'definition_missing',
        detail: `The run ${runId} cannot be restored (see workflow.run.refused)`,
      };
    }
    const prepared = await this.#prepare(loaded, toVersion);
    if (!prepared.ok) {
      await this.#refuseMigration(loaded, request, prepared, false);
      return { status: 'refused', reason: prepared.reason, detail: prepared.detail };
    }
    const state = String(loaded.snapshot.value);
    const atSafePoint =
      loaded.runtime.inFlight === null &&
      loaded.snapshot.status !== 'done' &&
      isSafeNode(loaded.workflow, state) &&
      !(await hasOpenEffects(this.#store, runId));
    if (atSafePoint) {
      return (await this.#applyMigration(loaded, prepared.prepared, request)).outcome;
    }
    const waiting = { ...loaded, runtime: { ...loaded.runtime, migration: request } };
    await this.#store.plays.update(runId, { snapshot: this.#snapshotOf(waiting) });
    return { status: 'pending' };
  }

  /**
   * A version of a workflow became the active one (the library calls this after `activate`). With
   * `workflows.running_on_change: migrate_at_safe_point`, the migration of every open run of the
   * workflow that is in an older version is asked (`activation`); with `pin` nothing happens.
   * Returns the ids of the runs it asked for.
   */
  async onActivated(workflowId: string, version: string): Promise<string[]> {
    if (this.#stopped || this.#runningOnChange() !== 'migrate_at_safe_point') return [];
    const asked: string[] = [];
    for (const play of await this.#store.plays.list({ open: true })) {
      if (play.flowId !== workflowId) continue;
      const saved = SavedRunSchema.safeParse(play.snapshot);
      if (!saved.success || !(compareVersions(version, saved.data.workflow.version) > 0)) continue;
      await this.requestMigration(play.id, version, 'activation');
      asked.push(play.id);
    }
    return asked;
  }

  // ---- internals ----

  /** Validates a definition against the step types this runtime can run, and hashes it. */
  async #check(definition: unknown): Promise<
    | { readonly ok: true; readonly workflow: ValidWorkflow; readonly ref: WorkflowRef }
    | {
        readonly ok: false;
        readonly refusal: WorkflowRunRefusal;
        readonly detail: string;
        readonly ref?: Pick<WorkflowRef, 'id' | 'version'> & { hash?: string };
      }
  > {
    const stepTypes = BUILTIN_STEP_TYPES.filter((spec) => this.#steps.has(spec.id));
    const result = validateWorkflow(definition, { ...this.#validate, stepTypes });
    if (!result.ok) {
      const unknown = result.errors.some((issue) => issue.code === 'unknown_step');
      return {
        ok: false,
        refusal: unknown ? 'unknown_step_type' : 'invalid_definition',
        detail: result.errors
          .slice(0, 5)
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; '),
        ...(isRecordWithIdAndVersion(definition)
          ? { ref: { id: definition.id, version: definition.version } }
          : {}),
      };
    }
    const hash = await workflowHash(result.workflow.definition);
    return {
      ok: true,
      workflow: result.workflow,
      ref: { id: result.workflow.id, version: result.workflow.version, hash },
    };
  }

  /** Loads a saved run; `undefined` (with a `workflow.run.refused` event) when it cannot be restored. */
  async #load(record: PlayRecord): Promise<LoadedRun | undefined> {
    const saved = SavedRunSchema.safeParse(record.snapshot);
    if (!saved.success) {
      // Not a workflow run (or damaged): other recoveries (the plays) look at it; nothing to tell.
      this.#logger.warn({ runId: record.id }, 'a run without a readable workflow snapshot');
      return undefined;
    }
    const { workflow: ref, machine: persisted, runtime } = saved.data;
    const born = saved.data.born ?? ref;
    const refuse = async (refusal: WorkflowRunRefusal, detail: string): Promise<undefined> => {
      await this.#refuse(record.scenarioId, record.id, { refusal, detail, ref });
      return undefined;
    };
    if (this.#source === undefined) return refuse('definition_missing', 'No source of definitions');
    const raw = await this.#source.resolve({ id: ref.id, version: ref.version });
    if (raw === undefined || raw === null) {
      return refuse('definition_missing', `No definition ${ref.id}@${ref.version}`);
    }
    const checked = await this.#check(raw);
    if (!checked.ok) return refuse(checked.refusal, checked.detail);
    if (checked.ref.id !== ref.id || checked.ref.version !== ref.version) {
      return refuse('hash_mismatch', `The source gave ${checked.ref.id}@${checked.ref.version}`);
    }
    if (checked.ref.hash !== ref.hash) {
      return refuse(
        'hash_mismatch',
        `The definition changed: ${checked.ref.hash} is not ${ref.hash}`,
      );
    }
    const machine = buildWorkflowMachine(checked.workflow);
    let snapshot: LoadedRun['snapshot'];
    try {
      snapshot = createActor(machine, {
        snapshot: persisted as never,
        input: undefined,
      }).getSnapshot();
    } catch (error) {
      return refuse('snapshot_unreadable', situationText(error, 400) ?? 'The snapshot was refused');
    }
    return { record, workflow: checked.workflow, ref, born, machine, snapshot, runtime };
  }

  async #refuse(
    scenarioId: string,
    runId: string,
    refusal: {
      readonly refusal: WorkflowRunRefusal;
      readonly detail: string;
      readonly ref?:
        { readonly id: string; readonly version: string; readonly hash?: string } | undefined;
    },
  ): Promise<void> {
    this.#logger.warn(
      { runId, reason: refusal.refusal, detail: refusal.detail },
      'workflow run refused',
    );
    const workflow = refusal.ref ?? { id: 'unknown', version: 'unknown' };
    try {
      await this.#store.events.append({
        ...buildDaemonEvent('workflow.run.refused', {
          workflow: {
            id: workflow.id,
            version: workflow.version,
            ...(workflow.hash === undefined ? {} : { hash: workflow.hash }),
          },
          reason: refusal.refusal,
          detail: refusal.detail.slice(0, 500),
        }),
        scenarioId,
        playId: runId,
      });
    } catch (error) {
      this.#logger.warn({ runId, err: error }, 'the refusal of a workflow run was not written');
    }
  }

  async #emit<T extends WorkflowEventType>(
    tx: StoreTransaction,
    scenarioId: string,
    runId: string,
    type: T,
    payload: DaemonEventPayloads[T],
  ): Promise<void> {
    await tx.events.append({
      ...buildDaemonEvent(type, payload),
      scenarioId,
      playId: runId,
    });
  }

  #launch(loaded: LoadedRun, cancelReason: string | undefined): ActiveRun {
    const run: ActiveRun = {
      runId: loaded.record.id,
      loaded,
      stop: new AbortController(),
      cancel: new AbortController(),
      cancelReason,
      done: Promise.resolve(),
      chain: Promise.resolve(),
    };
    if (cancelReason !== undefined) run.cancel.abort();
    this.#active.set(run.runId, run);
    run.done = this.#drive(run)
      .catch((error: unknown) => {
        // The state on disk is the last one saved: `resume` takes the run from there.
        this.#logger.warn(
          { runId: run.runId, err: error },
          'workflow run loop stopped by an error',
        );
      })
      .finally(() => {
        if (this.#active.get(run.runId) === run) this.#active.delete(run.runId);
      });
    return run;
  }

  /** The loop of a run: one node at a time until it reaches a final state or the runtime stops. */
  async #drive(run: ActiveRun): Promise<void> {
    for (;;) {
      if (run.stop.signal.aborted) return;
      if (run.loaded.snapshot.status === 'done') return;
      // A migration asked waits here: between two steps is where a run can change version.
      if (run.loaded.runtime.migration !== null && run.loaded.runtime.inFlight === null) {
        await this.#serial(run, () => this.#migrateAtSafePoint(run));
        // Back to the top: it looks again at a stop and at the end of the run.
        continue;
      }
      const { loaded } = run;
      const state = String(loaded.snapshot.value);
      const node = loaded.workflow.nodes[state];
      if (node === undefined) {
        throw new InvalidInput(`The run ${run.runId} is in ${state}, which is not a node`);
      }
      const ordinal = (loaded.runtime.visits[node.id] ?? 0) + 1;
      if (run.cancel.signal.aborted) {
        await this.#settle(run, node.id, node.step, ordinal, {
          kind: 'cancelled',
          reason: run.cancelReason ?? 'cancelled',
        });
        continue;
      }
      const result = await this.#runNode(run, node, ordinal);
      if (result === undefined) return; // stopped in the middle: nothing more is written
      await this.#settle(run, node.id, node.step, ordinal, result);
    }
  }

  /** Writes `workflow.step.started`, runs the step and gives its result; `undefined` when the runtime stopped. */
  async #runNode(
    run: ActiveRun,
    node: ValidWorkflow['nodes'][string],
    ordinal: number,
  ): Promise<StepResult | undefined> {
    const { loaded } = run;
    const key = `${run.runId}:${node.id}:${String(ordinal)}`;
    const resumed =
      loaded.runtime.inFlight?.node === node.id && loaded.runtime.inFlight.ordinal === ordinal;
    await this.#serial(run, async () => {
      loaded.runtime = { ...loaded.runtime, inFlight: { node: node.id, ordinal } };
      await this.#store.transaction(async (tx) => {
        if (!resumed) await tx.plays.update(run.runId, { snapshot: this.#snapshotOf(loaded) });
        await this.#emit(tx, loaded.record.scenarioId, run.runId, 'workflow.step.started', {
          node: node.id,
          step: node.step,
          ordinal,
          key,
          resumed,
        });
      });
    });
    const runner = this.#steps.get(node.step);
    if (runner === undefined) {
      return { kind: 'failed', reason: 'unknown_step_type', detail: `No code for ${node.step}` };
    }
    const signal = AbortSignal.any([run.stop.signal, run.cancel.signal]);
    const context: StepContext = {
      runId: run.runId,
      workflow: { id: loaded.ref.id, version: loaded.ref.version },
      scenarioId: loaded.record.scenarioId,
      node: node.id,
      step: node.step,
      ordinal,
      key,
      params: node.params,
      inputs: (loaded.snapshot.context as RunContext).inputs,
      signal,
      resumed,
      memo: {
        get: (name) => loaded.runtime.memo[name],
        set: (name, value) =>
          this.#serial(run, async () => {
            if (run.stop.signal.aborted) return;
            loaded.runtime = { ...loaded.runtime, memo: { ...loaded.runtime.memo, [name]: value } };
            await this.#store.plays.update(run.runId, { snapshot: this.#snapshotOf(loaded) });
          }),
      },
      approvals: loaded.runtime.approvals,
      deps: this.#deps,
    };
    let result: StepResult;
    try {
      result = await runner.run(context);
    } catch (error) {
      if (run.stop.signal.aborted) return undefined;
      this.#logger.warn({ runId: run.runId, node: node.id, err: error }, 'workflow step threw');
      result = { kind: 'failed', reason: 'step_error', detail: situationText(error, 400) ?? '' };
    }
    if (run.stop.signal.aborted) return undefined;
    return result;
  }

  /** Gives the machine the end of a visit and writes the transition (state, snapshot, events) in one transaction. */
  #settle(
    run: ActiveRun,
    nodeId: string,
    step: string,
    ordinal: number,
    result: StepResult,
  ): Promise<void> {
    return this.#serial(run, () => this.#settleNow(run, nodeId, step, ordinal, result));
  }

  async #settleNow(
    run: ActiveRun,
    nodeId: string,
    step: string,
    ordinal: number,
    result: StepResult,
  ): Promise<void> {
    const { loaded } = run;
    const cancelled = run.cancel.signal.aborted;
    const event: RunEvent = cancelled
      ? { type: 'workflow.cancel', reason: run.cancelReason ?? 'cancelled' }
      : result.kind === 'done'
        ? { type: 'workflow.step.done', output: result.output }
        : result.kind === 'failed'
          ? {
              type: 'workflow.step.failed',
              reason: result.reason,
              ...(result.detail === undefined ? {} : { detail: result.detail }),
            }
          : { type: 'workflow.cancel', reason: result.reason ?? 'cancelled' };
    const [next] = transition(loaded.machine, loaded.snapshot, event);
    const to = String(next.value);
    const final = next.status === 'done';
    const context = next.context as RunContext;
    const steps = loaded.runtime.steps + 1;
    const runtime: RuntimeState = {
      visits: { ...loaded.runtime.visits, [nodeId]: ordinal },
      memo: {},
      steps,
      inFlight: null,
      // [proposta] An `approval` that ended approved counts for every public write after it.
      approvals:
        loaded.runtime.approvals +
        (step === 'approval' &&
        !cancelled &&
        result.kind === 'done' &&
        result.output.approved === true
          ? 1
          : 0),
      migration: loaded.runtime.migration,
    };
    const outcome = cancelled || result.kind === 'cancelled' ? 'cancelled' : result.kind;
    const reason =
      event.type === 'workflow.cancel'
        ? event.reason
        : event.type === 'workflow.step.failed'
          ? event.reason
          : to === 'failed'
            ? context.failure?.reason
            : undefined;
    const effect = !cancelled && result.kind === 'done' ? result.effect : undefined;
    const record = loaded.record;
    const updated = await this.#store.transaction(async (tx) => {
      const saved = await tx.plays.update(run.runId, {
        state: to,
        snapshot: toJson({
          workflow: loaded.ref,
          born: loaded.born,
          machine: loaded.machine.getPersistedSnapshot(next),
          runtime,
        }),
        counters: { ...context.counts },
        ...(final ? { finishedAt: tx.now() } : {}),
      });
      await this.#emit(tx, record.scenarioId, run.runId, 'workflow.step.finished', {
        node: nodeId,
        step,
        ordinal,
        outcome,
        next: final ? null : to,
        to,
        ...(reason === undefined || reason === '' ? {} : { reason }),
        ...(effect === undefined ? {} : { effect }),
      });
      if (final) {
        const finished = to === 'done' || to === 'cancelled' || to === 'failed' ? to : 'failed';
        await this.#emit(tx, record.scenarioId, run.runId, 'workflow.run.finished', {
          outcome: finished,
          ...(finished === 'done' || reason === undefined || reason === '' ? {} : { reason }),
          steps,
        });
      }
      return saved;
    });
    run.loaded = { ...loaded, record: updated, snapshot: next, runtime };
  }

  #snapshotOf(loaded: LoadedRun): JsonObject {
    return toJson({
      workflow: loaded.ref,
      born: loaded.born,
      machine: loaded.machine.getPersistedSnapshot(loaded.snapshot),
      runtime: loaded.runtime,
    });
  }

  /** Runs `write` after the writes of this run that were asked before it (the loop, a step's memo, a migration). */
  #serial<T>(run: ActiveRun, write: () => Promise<T>): Promise<T> {
    const next = run.chain.then(write);
    run.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** The new definition of a migration, and everything that can be checked before the safe point. */
  async #prepare(
    loaded: LoadedRun,
    toVersion: string,
  ): Promise<MigrationCheck<{ readonly prepared: PreparedMigration }>> {
    if (!(compareVersions(toVersion, loaded.ref.version) > 0)) {
      return {
        ok: false,
        reason: 'not_newer',
        detail: `${toVersion} is not newer than ${loaded.ref.version}`,
      };
    }
    const raw =
      this.#source === undefined
        ? undefined
        : await this.#source.resolve({ id: loaded.ref.id, version: toVersion });
    if (raw === undefined || raw === null) {
      return {
        ok: false,
        reason: 'definition_missing',
        detail: `No definition ${loaded.ref.id}@${toVersion}`,
      };
    }
    const checked = await this.#check(raw);
    if (!checked.ok) return { ok: false, reason: 'target_invalid', detail: checked.detail };
    if (checked.ref.id !== loaded.ref.id || checked.ref.version !== toVersion) {
      return {
        ok: false,
        reason: 'definition_missing',
        detail: `The source gave ${checked.ref.id}@${checked.ref.version}`,
      };
    }
    const mapping = mappingOf(loaded.workflow, checked.workflow);
    if (!mapping.ok) return mapping;
    const inputs = resolveRunInputs(
      checked.workflow,
      (loaded.snapshot.context as RunContext).inputs,
    );
    if (!inputs.ok) return { ok: false, reason: 'inputs_incompatible', detail: inputs.detail };
    return {
      ok: true,
      prepared: {
        target: checked.workflow,
        ref: checked.ref,
        map: mapping.map,
        inputs: inputs.inputs,
      },
    };
  }

  /** The loop of a run found a request waiting: migrates if this is a safe point, refuses if the mapping fails. */
  async #migrateAtSafePoint(run: ActiveRun): Promise<void> {
    const { loaded } = run;
    const request = loaded.runtime.migration;
    if (request === null || loaded.runtime.inFlight !== null) return;
    if (loaded.snapshot.status === 'done' || run.cancel.signal.aborted) return;
    if (!isSafeNode(loaded.workflow, String(loaded.snapshot.value))) return;
    if (await hasOpenEffects(this.#store, run.runId)) return;
    const result = await this.#prepare(loaded, request.toVersion);
    run.loaded = result.ok
      ? (await this.#applyMigration(loaded, result.prepared, request)).loaded
      : await this.#refuseMigration(loaded, request, result, true);
  }

  /**
   * Moves a run at a safe point to the node the mapping gives, in ONE transaction (the record, its
   * snapshot and the `workflow.migrated` event). The machine is the one of the new definition,
   * positioned in that node; the visits, the steps and the approvals stay as they were, the limit
   * counters are carried by key, and `born` stays the version the run was born in.
   */
  async #applyMigration(
    loaded: LoadedRun,
    prepared: PreparedMigration,
    request: MigrationRequest,
  ): Promise<{ readonly outcome: MigrationOutcome; readonly loaded: LoadedRun }> {
    const fromState = String(loaded.snapshot.value);
    const mapped = mapState(prepared.map, fromState);
    if (!mapped.ok) {
      const next = await this.#refuseMigration(loaded, request, mapped, true);
      return {
        outcome: { status: 'refused', reason: mapped.reason, detail: mapped.detail },
        loaded: next,
      };
    }
    const { toState } = mapped;
    const carried = carryCounts((loaded.snapshot.context as RunContext).counts, prepared.target);
    const machine = buildWorkflowMachine(prepared.target);
    const context: RunContext = { inputs: prepared.inputs, counts: carried.counts, failure: null };
    const placed = machine.resolveState({ value: toState, context });
    const persisted = machine.getPersistedSnapshot(placed);
    const snapshot = createActor(machine, { snapshot: persisted, input: undefined }).getSnapshot();
    const runtime: RuntimeState = { ...loaded.runtime, memo: {}, inFlight: null, migration: null };
    const record = await this.#store.transaction(async (tx) => {
      const saved = await tx.plays.update(loaded.record.id, {
        state: toState,
        snapshot: toJson({
          workflow: prepared.ref,
          born: loaded.born,
          machine: persisted,
          runtime,
        }),
        counters: { ...carried.counts },
      });
      await this.#emit(tx, loaded.record.scenarioId, loaded.record.id, 'workflow.migrated', {
        runId: loaded.record.id,
        from: { id: loaded.ref.id, version: loaded.ref.version },
        to: { id: prepared.ref.id, version: prepared.ref.version },
        fromState,
        toState,
        trigger: request.trigger,
        droppedLimits: carried.dropped,
      });
      return saved;
    });
    return {
      outcome: { status: 'applied', from: loaded.ref, to: prepared.ref, toState },
      loaded: {
        record,
        workflow: prepared.target,
        ref: prepared.ref,
        born: loaded.born,
        machine,
        snapshot,
        runtime,
      },
    };
  }

  /**
   * Writes `workflow.migration_refused`. `clear` is for a request that was waiting in the run: the
   * request leaves the saved state in the same transaction, and the run goes on in its version.
   */
  async #refuseMigration(
    loaded: LoadedRun,
    request: MigrationRequest,
    refusal: { readonly reason: WorkflowMigrationRefusal; readonly detail: string },
    clear: boolean,
  ): Promise<LoadedRun> {
    if (!clear || loaded.runtime.migration === null) {
      await this.#writeRefusal(loaded.record, loaded.ref, request, refusal);
      return loaded;
    }
    const next: LoadedRun = { ...loaded, runtime: { ...loaded.runtime, migration: null } };
    const record = await this.#store.transaction(async (tx) => {
      const saved = await tx.plays.update(loaded.record.id, { snapshot: this.#snapshotOf(next) });
      await this.#emit(
        tx,
        loaded.record.scenarioId,
        loaded.record.id,
        'workflow.migration_refused',
        this.#refusalPayload(loaded.record.id, loaded.ref, request, refusal),
      );
      return saved;
    });
    this.#logger.warn(
      { runId: loaded.record.id, reason: refusal.reason, detail: refusal.detail },
      'workflow migration refused',
    );
    return { ...next, record };
  }

  async #writeRefusal(
    record: PlayRecord,
    from: WorkflowRef,
    request: MigrationRequest,
    refusal: { readonly reason: WorkflowMigrationRefusal; readonly detail: string },
  ): Promise<void> {
    this.#logger.warn(
      { runId: record.id, reason: refusal.reason, detail: refusal.detail },
      'workflow migration refused',
    );
    try {
      await this.#store.events.append({
        ...buildDaemonEvent(
          'workflow.migration_refused',
          this.#refusalPayload(record.id, from, request, refusal),
        ),
        scenarioId: record.scenarioId,
        playId: record.id,
      });
    } catch (error) {
      this.#logger.warn(
        { runId: record.id, err: error },
        'the refusal of a migration was not written',
      );
    }
  }

  #refusalPayload(
    runId: string,
    from: WorkflowRef,
    request: MigrationRequest,
    refusal: { readonly reason: WorkflowMigrationRefusal; readonly detail: string },
  ): DaemonEventPayloads['workflow.migration_refused'] {
    return {
      runId,
      from: { id: from.id, version: from.version },
      toVersion: request.toVersion,
      trigger: request.trigger,
      reason: refusal.reason,
      detail: refusal.detail.slice(0, 500),
    };
  }
}

function isRecordWithIdAndVersion(value: unknown): value is { id: string; version: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { version?: unknown }).version === 'string'
  );
}

/** The event types the driver writes in its transactions. */
type WorkflowEventType =
  | 'workflow.migrated'
  | 'workflow.migration_refused'
  | 'workflow.run.started'
  | 'workflow.step.started'
  | 'workflow.step.finished'
  | 'workflow.run.finished';
