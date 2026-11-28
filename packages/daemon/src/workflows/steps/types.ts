// SPDX-License-Identifier: MPL-2.0
import type { Clock, JsonObject, JsonValue, Store } from '@otheater/core';
import type { AskApproval } from '../../browser/approval.js';
import type { PluginEffectRegistry } from '../../workspace/plugin-effects.js';
import type { EffectOrigin } from '../../workspace/effects.js';
import type { WorkflowRuntimeSettings } from '../runtime-config.js';
import type { CodeHostStepDeps } from './codehost/support.js';

/**
 * What a step type needs to run, besides the node it runs (plan of Phase 11b, P2). The engine of a
 * run (`runtime.ts`) builds one {@link StepContext} per node visit and hands it to the
 * {@link StepRunner} of the step type. [proposta] The shape of all of this; the plan fixes only the
 * five generic step types and that their effects go through `runEffect`.
 */

/** What the generic steps read from the daemon. Every port is optional: a step that needs a missing one fails with a reason. */
export interface StepDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly settings: WorkflowRuntimeSettings;
  /** Calls the tools of the plugins (`call_tool`). */
  readonly tools?: ToolCaller | undefined;
  /** Opens a question in the prompt queue of the Producer (`approval`; the `ask_producer` queue). */
  readonly ask?: AskApproval | undefined;
  /** The verifiers of the effects the plugins declared; `call_tool` uses the one of its tool when there is one. */
  readonly pluginEffects?: PluginEffectRegistry | undefined;
  /** The ports and the settings of the code host steps (P8); absent, they fail with `code_host_unavailable`. */
  readonly codeHost?: CodeHostStepDeps | undefined;
}

/** What a step keeps across a restart (the `memo` of the run): a small JSON value by name. */
export interface StepMemo {
  get(name: string): JsonValue | undefined;
  /** Saves it with the run (a write of the store), so a restart reads it back. */
  set(name: string, value: JsonValue): Promise<void>;
}

/** One visit to a node. */
export interface StepContext {
  readonly runId: string;
  /** The definition the run follows. */
  readonly workflow: { readonly id: string; readonly version: string };
  /** The scenario of the run; it is the project the plugins are active in. */
  readonly scenarioId: string;
  readonly node: string;
  /** The step type of the node. */
  readonly step: string;
  /** Which visit of the node this is (1 on the first). */
  readonly ordinal: number;
  /**
   * The idempotency key of the visit: `<run>:<node>:<ordinal>`. Stable across a restart (the
   * ordinal only grows when the visit ends), so the effect journal finds its record again. It
   * starts with the id of the run, as `reconcile` expects of a key (it finds the open play by it).
   */
  readonly key: string;
  /** The params of the node (already checked by the validator). */
  readonly params: Readonly<Record<string, unknown>>;
  /** The inputs of the run, with the defaults filled in. */
  readonly inputs: JsonObject;
  /** Aborted when the run is cancelled or the daemon stops. */
  readonly signal: AbortSignal;
  /** True when the daemon restarted with this visit in flight. */
  readonly resumed: boolean;
  readonly memo: StepMemo;
  /** How many `approval` steps of the run ended approved so far (P8: a public write checks it). */
  readonly approvals: number;
  readonly deps: StepDeps;
}

export type StepResult =
  /** The step ended; `output` is what the conditions of the edges that leave the node read. */
  | { readonly kind: 'done'; readonly output: JsonObject; readonly effect?: EffectOrigin }
  /** The step could not do its work; the run goes to `failed`. */
  | { readonly kind: 'failed'; readonly reason: string; readonly detail?: string }
  /** The step stopped because the run was cancelled, or by its own `stop` mode. */
  | { readonly kind: 'cancelled'; readonly reason?: string };

/** The code of a step type (the engine finds it by `type`). */
export interface StepRunner {
  /** The id of the step type: `call_tool`, `wait_event`... */
  readonly type: string;
  /**
   * Does the work of one visit. It must be safe to run again for the same `ctx.key` (a restart
   * runs it again): a step with a side effect goes through `runEffect` and so never repeats it.
   * It never throws for a failure of its own work (it returns `failed`); what it throws is
   * logged and ends the step as `failed` with the reason `step_error`.
   */
  run(ctx: StepContext): Promise<StepResult>;
}

/** The empty output, for a step that returns nothing a condition can read. */
export const NO_STEP_OUTPUT: JsonObject = {};

/** What a tool of a plugin changes (`TOOL_EFFECT_CLASSES` of the manifest). */
export type ToolEffectClass = 'read' | 'local_write' | 'network' | 'external_write';

/** A tool the engine can call, found by its public name. */
export interface ToolRef {
  /** The id of the plugin that owns the tool. */
  readonly plugin: string;
  /** The name of the tool in its own plugin. */
  readonly tool: string;
  readonly effects: ToolEffectClass;
}

/** What a call answers: `ok` is false for an error of the tool or of the way to it. */
export interface ToolCallResult {
  readonly ok: boolean;
  readonly result: JsonValue;
  /** For an error: `plugin_unavailable`, `plugin_timeout`, `plugin_failed`, `tool_unavailable`... */
  readonly code?: string;
}

/**
 * The door of `call_tool` to the tools (N292: out of the process, by MCP). [proposta] A port of the
 * engine, so the runtime does not know the plugin aggregator and the tests give it a fake;
 * `createPluginToolCaller` is the adapter over `PluginAggregator`.
 */
export interface ToolCaller {
  /** The tool a node names, in the project of the run; `undefined` when there is none. */
  find(project: string, name: string): ToolRef | undefined;
  /** Calls it. Never rejects: a failure is `ok: false` with a `code`. */
  call(
    project: string,
    ref: ToolRef,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolCallResult>;
}
