// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  type Clock,
  type EventLog,
  type JsonObject,
  type PlayRegistry,
  type WorkflowBindingRecord,
  workflowBudgetExhausted,
} from '@otheater/core';
import type { WorkflowTriggerSkipReason } from '@otheater/protocol';
import { type SituationErrorLog, writeSituation } from '../../situations.js';
import type { WorkflowBindings } from '../bindings.js';
import type { WorkflowLibrary } from '../library.js';
import type { StartWorkflowResult, WorkflowRuntime } from '../runtime.js';
import type { SeenLedger } from './seen.js';
import { runIdPrefix, triggerRunId } from './types.js';

/**
 * Starts the run of a binding for an item a trigger found (docs/24 section 8; plan of Phase 11b,
 * P6). Every trigger ends here, so the rules of the binding (P5) are in one place:
 *
 * 1. the binding must be `active` and have budget left: a paused binding or an exhausted budget
 *    does not fire (`workflow.trigger.skipped`, reason `paused` or `budget`; the item is kept for
 *    the look after the binding is back);
 * 2. the library must hold a version the binding reaches (`no_workflow`, kept);
 * 3. a binding at its `concurrency` follows `workflows.binding.on_busy` as the binding has it:
 *    `queue` keeps the item for later (`busy`, kept), `skip` drops it for good (`busy`), and
 *    `replace` cancels the oldest live runs of the binding to make room;
 * 4. the run starts with a deterministic id, so a second start of the same item is a `Conflict`
 *    that means "already fired" and not an error; a run the runtime refuses is dropped
 *    (`refused`, with the reason).
 *
 * Whatever is final marks the item in the ledger, so it never fires again, and writes the event.
 */

export type TriggerSkipReason = WorkflowTriggerSkipReason;

/** An item a trigger found and wants to run the binding for. */
export interface TriggerItem {
  readonly binding: WorkflowBindingRecord;
  /** One of `WORKFLOW_TRIGGER_TYPES` (or whatever the binding wrote, for `invalid`). */
  readonly triggerType: string;
  /** What identifies the item for this binding (`issue_opened:12`...); the ledger and the run id use it. */
  readonly key: string;
  /** The issue or pull request number; `null` for an event. */
  readonly number: number | null;
  /** The input of the workflow that receives the number: `issue` or `pr`. */
  readonly inputName?: 'issue' | 'pr' | undefined;
}

/** What became of an item: `fired` and `dropped` are final; `deferred` is kept for the next look. */
export type FireOutcome =
  | { readonly status: 'fired'; readonly runId: string }
  | {
      readonly status: 'dropped';
      /** `already_fired`: the run exists; `binding_gone`: the binding was stopped or expired. */
      readonly reason: TriggerSkipReason | 'already_fired' | 'binding_gone';
    }
  | { readonly status: 'deferred'; readonly reason: TriggerSkipReason };

export interface TriggerFirerDeps {
  readonly clock: Pick<Clock, 'now'>;
  readonly events: Pick<EventLog, 'append'>;
  readonly logger: SituationErrorLog;
  readonly plays: Pick<PlayRegistry, 'list'>;
  readonly bindings: Pick<WorkflowBindings, 'get'>;
  readonly library: Pick<WorkflowLibrary, 'resolve'>;
  readonly runtime: Pick<WorkflowRuntime, 'start' | 'cancel'>;
  readonly ledger: SeenLedger;
}

/** How many "kept" announcements are remembered (not to repeat an event at every look). */
const ANNOUNCED_LIMIT = 5000;

export class TriggerFirer {
  readonly #deps: TriggerFirerDeps;
  readonly #announced = new Set<string>();

  constructor(deps: TriggerFirerDeps) {
    this.#deps = deps;
  }

  async fire(item: TriggerItem): Promise<FireOutcome> {
    const { binding } = item;
    const current = await this.#deps.bindings.get(binding.id);
    if (current === undefined || current.state === 'stopped' || current.state === 'expired') {
      // The binding ended while the look was going on: nothing to start and nothing to say.
      return { status: 'dropped', reason: 'binding_gone' };
    }
    if (current.state === 'paused') {
      const reason = current.stateReason === 'budget' ? 'budget' : 'paused';
      await this.#keep(
        item,
        reason,
        `the binding is paused (${current.stateReason ?? 'producer'})`,
      );
      return { status: 'deferred', reason };
    }
    if (workflowBudgetExhausted(current)) {
      await this.#keep(item, 'budget', 'the budget of the period is used up');
      return { status: 'deferred', reason: 'budget' };
    }
    const definition = await this.#deps.library.resolve(current.workflowId, current.versionRange);
    if (definition === undefined) {
      await this.#keep(
        item,
        'no_workflow',
        `the library has no version of ${current.workflowId} that matches "${current.versionRange}"`,
      );
      return { status: 'deferred', reason: 'no_workflow' };
    }

    const live = await this.#liveRuns(current);
    const replaced: string[] = [];
    if (live.length >= current.concurrency) {
      if (current.onBusy === 'queue') {
        await this.#keep(item, 'busy', `${String(live.length)} run(s) live and the binding queues`);
        return { status: 'deferred', reason: 'busy' };
      }
      if (current.onBusy === 'skip') {
        await this.drop(item, 'busy', `${String(live.length)} run(s) live and the binding skips`);
        return { status: 'dropped', reason: 'busy' };
      }
      const excess = live.length - current.concurrency + 1;
      for (const runId of live.slice(0, excess)) {
        await this.#deps.runtime.cancel(runId, 'replaced');
        replaced.push(runId);
      }
    }

    const runId = triggerRunId(current.id, item.key);
    const inputs: JsonObject = {
      ...current.params,
      ...(item.inputName !== undefined && item.number !== null
        ? { [item.inputName]: item.number }
        : {}),
    };
    let started: StartWorkflowResult;
    try {
      started = await this.#deps.runtime.start({
        runId,
        scenarioId: current.scenarioId,
        definition: definition.definition,
        inputs,
      });
    } catch (error) {
      if (error instanceof Conflict && (await this.#runExists(current, runId))) {
        // Fired before (the mark was lost in a crash): the run exists, so the item is done.
        await this.#deps.ledger.mark(current.id, item.key, this.#deps.clock.now());
        return { status: 'dropped', reason: 'already_fired' };
      }
      throw error;
    }
    if (!started.ok) {
      await this.drop(item, 'refused', `${started.refusal}: ${started.detail}`);
      return { status: 'dropped', reason: 'refused' };
    }
    await this.#deps.ledger.mark(current.id, item.key, this.#deps.clock.now());
    await writeSituation(
      this.#deps.events,
      this.#deps.logger,
      'workflow.trigger.fired',
      {
        bindingId: current.id,
        scenarioId: current.scenarioId,
        workflowId: current.workflowId,
        triggerType: item.triggerType,
        key: item.key,
        runId,
        number: item.number,
        replaced,
      },
      { scenarioId: current.scenarioId },
    );
    return { status: 'fired', runId };
  }

  /** Gives the item up for good: marks it in the ledger and says why (`retry: false`). */
  async drop(item: TriggerItem, reason: TriggerSkipReason, detail?: string): Promise<void> {
    await this.#deps.ledger.mark(item.binding.id, item.key, this.#deps.clock.now());
    await this.#skipped(item, reason, false, detail);
  }

  /**
   * Says the item did not fire, without marking it (for an event, which the cursor of the log
   * never offers twice, so there is nothing to mark). `retry: false`.
   */
  skip(item: TriggerItem, reason: TriggerSkipReason, detail?: string): Promise<void> {
    return this.#skipped(item, reason, false, detail);
  }

  /** Keeps the item for the next look and says why once (`retry: true`). */
  async #keep(item: TriggerItem, reason: TriggerSkipReason, detail: string): Promise<void> {
    const announced = `${item.binding.id}|${item.key}|${reason}`;
    if (this.#announced.has(announced)) return;
    if (this.#announced.size >= ANNOUNCED_LIMIT) this.#announced.clear();
    this.#announced.add(announced);
    await this.#skipped(item, reason, true, detail);
  }

  #skipped(
    item: TriggerItem,
    reason: TriggerSkipReason,
    retry: boolean,
    detail: string | undefined,
  ): Promise<void> {
    const { binding } = item;
    return writeSituation(
      this.#deps.events,
      this.#deps.logger,
      'workflow.trigger.skipped',
      {
        bindingId: binding.id,
        scenarioId: binding.scenarioId,
        workflowId: binding.workflowId,
        triggerType: item.triggerType,
        key: item.key,
        reason,
        retry,
        ...(detail === undefined ? {} : { detail: detail.slice(0, 400) }),
      },
      { scenarioId: binding.scenarioId },
    );
  }

  async #runExists(binding: WorkflowBindingRecord, runId: string): Promise<boolean> {
    const all = await this.#deps.plays.list({ scenarioId: binding.scenarioId });
    return all.some((play) => play.id === runId);
  }

  /** The ids of the live runs of the binding, oldest first (the ones that count for `concurrency`). */
  async #liveRuns(binding: WorkflowBindingRecord): Promise<readonly string[]> {
    const prefix = runIdPrefix(binding.id);
    const open = await this.#deps.plays.list({ scenarioId: binding.scenarioId, open: true });
    return open.filter((play) => play.id.startsWith(prefix)).map((play) => play.id);
  }
}
