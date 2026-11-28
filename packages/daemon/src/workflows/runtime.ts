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
  type WorkflowRef,
  type WorkflowRunRefusal,
} from '@otheater/protocol';
import {
  BUILTIN_STEP_TYPES,
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
import { buildWorkflowMachine, type RunContext, type RunEvent } from './machine.js';
import { DEFAULT_WORKFLOW_RUNTIME, type WorkflowRuntimeSettings } from './runtime-config.js';
import type { ToolCaller } from './steps/call-tool.js';
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
  /** The definitions of the saved runs; without it a run cannot be resumed. */
  readonly source?: WorkflowSource | undefined;
  /** The rest of the options of the validator (roles, installed plugins and tools, the approval rule...). */
  readonly validate?: Omit<ValidateOptions, 'stepTypes'> | undefined;
  readonly logger?: WorkflowRuntimeLogger | undefined;
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
});
type RuntimeState = z.infer<typeof RuntimeStateSchema>;

/** The snapshot of a run in the record (docs/24 §6). */
const SavedRunSchema = z.object({
  workflow: WorkflowRefSchema,
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
    };
    this.#steps = new Map(
      (options.steps ?? GENERIC_STEP_RUNNERS).map((runner) => [runner.type, runner]),
    );
    this.#source = options.source;
    this.#validate = options.validate ?? {};
    this.#logger = options.logger ?? NO_LOGGER;
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
    const runtime: RuntimeState = { visits: {}, memo: {}, steps: 0, inFlight: null };
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
    this.#launch({ record, workflow, ref, machine, snapshot, runtime }, undefined);
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
        input: undefined as never,
      }).getSnapshot();
    } catch (error) {
      return refuse('snapshot_unreadable', situationText(error, 400) ?? 'The snapshot was refused');
    }
    return { record, workflow: checked.workflow, ref, machine, snapshot, runtime };
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
      const { loaded } = run;
      if (loaded.snapshot.status === 'done') return;
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
        set: async (name, value) => {
          if (run.stop.signal.aborted) return;
          loaded.runtime = { ...loaded.runtime, memo: { ...loaded.runtime.memo, [name]: value } };
          await this.#store.plays.update(run.runId, { snapshot: this.#snapshotOf(loaded) });
        },
      },
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
  async #settle(
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
      machine: loaded.machine.getPersistedSnapshot(loaded.snapshot),
      runtime: loaded.runtime,
    });
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
  | 'workflow.run.started'
  | 'workflow.step.started'
  | 'workflow.step.finished'
  | 'workflow.run.finished';
