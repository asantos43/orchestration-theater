// SPDX-License-Identifier: MPL-2.0
import type { EventEnvelope, EventLog, WorkflowBindingRecord } from '@otheater/core';
import type { WorkflowBindings } from '../bindings.js';
import type { WorkflowTriggersSettings } from './config.js';
import type { TriggerFirer, TriggerItem } from './fire.js';
import {
  type ActivePluginReader,
  checkPluginEvent,
  parsePluginEventType,
} from './plugin-events.js';
import type { PollSource } from './poll-loop.js';
import type { SeenLedger } from './seen.js';
import { type ParsedTrigger, parseBindingTriggers } from './types.js';

/**
 * The internal triggers (docs/24 section 8; plan of Phase 11b, P6): a binding that asks for the
 * event `filter.name` starts a run when the log holds one. The events of the plugins
 * (`plugin.<id>.<name>`) are the same trigger under the conditions of D6 (see `plugin-events.ts`).
 *
 * One source reads the log for every binding (a cursor that the ledger keeps, so a restart goes on
 * where it stopped). The rules, all [proposta] where docs/24 is silent:
 *
 * - the first look only sets the cursor to the end of the log: a daemon that has just got the
 *   feature never answers the history;
 * - an event that is older than the binding, or that belongs to another scenario (its
 *   `scenarioId` is set and differs from the binding's), is not for the binding; an event of a
 *   plugin must carry the scenario of the binding (a plugin is active per project);
 * - the events of the triggers themselves (`workflow.trigger.*`, `workflow.poll.failed`) never
 *   trigger: a binding that asked for them would feed on its own output;
 * - an event that finds the binding paused, out of budget or busy with `queue` waits in the queue
 *   of the ledger (up to `PENDING_LIMIT`) and is tried again at every look while the binding is
 *   active; a queue that overflows drops its oldest event and says so;
 * - a paused binding does not read the log: what happens while it is paused is not answered after
 *   (only what was queued before is).
 */

/** The id of the one source that reads the log. */
export const EVENT_SOURCE_ID = 'events';

/** Events read from the log in one call, and how many calls one look makes at most. */
const BATCH_SIZE = 200;
const MAX_BATCHES = 20;

/** Events the triggers themselves write: they never trigger (see above). */
function isOwnEvent(type: string): boolean {
  return type.startsWith('workflow.trigger.') || type === 'workflow.poll.failed';
}

export interface EventSourceDeps {
  readonly settings: () => Pick<WorkflowTriggersSettings, 'plugin_events'>;
  readonly events: Pick<EventLog, 'readFrom' | 'lastId'>;
  readonly bindings: Pick<WorkflowBindings, 'list'>;
  readonly plugins: ActivePluginReader;
  readonly firer: TriggerFirer;
  readonly ledger: SeenLedger;
}

interface Target {
  readonly binding: WorkflowBindingRecord;
  readonly triggers: readonly (ParsedTrigger & {
    readonly trigger: Extract<ParsedTrigger['trigger'], { type: 'event' }>;
  })[];
}

export function eventSource(deps: EventSourceDeps): PollSource {
  return {
    id: EVENT_SOURCE_ID,
    poll: async () => {
      const cursor = await deps.ledger.eventCursor();
      if (cursor === null) {
        await deps.ledger.setEventCursor(await deps.events.lastId());
        return;
      }
      const targets = await targetsOf(deps);
      await retryQueued(deps, targets);
      if (targets.length === 0) {
        // Nobody listens: move the cursor on so that a later binding does not read this stretch.
        const last = await deps.events.lastId();
        if (last > cursor) await deps.ledger.setEventCursor(last);
        return;
      }
      await readLog(deps, targets, cursor);
    },
  };
}

async function targetsOf(deps: EventSourceDeps): Promise<readonly Target[]> {
  const active = await deps.bindings.list({ states: ['active'] });
  const targets: Target[] = [];
  for (const binding of active) {
    const triggers = parseBindingTriggers(binding).valid.flatMap((parsed) =>
      parsed.trigger.type === 'event' ? [{ index: parsed.index, trigger: parsed.trigger }] : [],
    );
    if (triggers.length > 0) targets.push({ binding, triggers });
  }
  return targets;
}

async function readLog(
  deps: EventSourceDeps,
  targets: readonly Target[],
  start: number,
): Promise<void> {
  const refused = new Set<string>();
  let cursor = start;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const events = await deps.events.readFrom(cursor, BATCH_SIZE);
    if (events.length === 0) return;
    for (const event of events) {
      if (!isOwnEvent(event.type)) await deliver(deps, targets, event, refused);
    }
    cursor = events[events.length - 1]?.id ?? cursor;
    await deps.ledger.setEventCursor(cursor);
    if (events.length < BATCH_SIZE) return;
  }
}

/** Hands one event to every binding that asked for its name. */
async function deliver(
  deps: EventSourceDeps,
  targets: readonly Target[],
  event: EventEnvelope,
  refused: Set<string>,
): Promise<void> {
  for (const { binding, triggers } of targets) {
    const asked = triggers.find((parsed) => parsed.trigger.filter.name === event.type);
    if (asked === undefined || !concerns(binding, event)) continue;
    const item = itemOf(binding, event);
    if (await deps.ledger.has(binding.id, item.key)) continue;
    if (!(await passesPluginGate(deps, binding, event, item, refused))) continue;
    const outcome = await deps.firer.fire(item);
    if (outcome.status !== 'deferred') continue;
    const dropped = await deps.ledger.enqueue(binding.id, {
      key: item.key,
      eventId: event.id,
      triggerIndex: asked.index,
      queuedAt: event.timestamp,
    });
    for (const old of dropped) {
      await deps.firer.skip(
        { ...item, key: old.key },
        outcome.reason,
        'the queue of waiting events is full: the oldest event was dropped',
      );
    }
  }
}

/** Whether the event is for the binding: not older than it, and of its scenario (or of none). */
function concerns(binding: WorkflowBindingRecord, event: EventEnvelope): boolean {
  if (event.timestamp < binding.createdAt) return false;
  if (parsePluginEventType(event.type) !== undefined) {
    return event.scenarioId === binding.scenarioId;
  }
  return event.scenarioId === undefined || event.scenarioId === binding.scenarioId;
}

function itemOf(binding: WorkflowBindingRecord, event: EventEnvelope): TriggerItem {
  return { binding, triggerType: 'event', key: `event:${String(event.id)}`, number: null };
}

/**
 * D6 for the event of a plugin (the other events pass). A refusal is announced once per binding,
 * reason and event type in a look, so a plugin that sends the same event a hundred times does not
 * write a hundred answers.
 */
async function passesPluginGate(
  deps: EventSourceDeps,
  binding: WorkflowBindingRecord,
  event: EventEnvelope,
  item: TriggerItem,
  refused: Set<string>,
): Promise<boolean> {
  const plugin = parsePluginEventType(event.type);
  if (plugin === undefined) return true;
  const verdict = checkPluginEvent(deps, binding.scenarioId, plugin);
  if (verdict.ok) return true;
  const once = `${binding.id}|${verdict.reason}|${event.type}`;
  if (!refused.has(once)) {
    refused.add(once);
    await deps.firer.skip(item, verdict.reason, verdict.detail);
  }
  return false;
}

/** The events that waited for a binding: tried again now that the binding is active. */
async function retryQueued(deps: EventSourceDeps, targets: readonly Target[]): Promise<void> {
  const refused = new Set<string>();
  for (const { binding, triggers } of targets) {
    for (const waiting of await deps.ledger.pending(binding.id)) {
      const asked = triggers.find((parsed) => parsed.index === waiting.triggerIndex);
      const [event] = await deps.events.readFrom(waiting.eventId - 1, 1);
      if (asked === undefined || event?.id !== waiting.eventId) {
        // The trigger left the binding or the event is gone: nothing to wait for.
        await deps.ledger.dequeue(binding.id, waiting.key);
        continue;
      }
      const item = itemOf(binding, event);
      if (await deps.ledger.has(binding.id, item.key)) {
        await deps.ledger.dequeue(binding.id, waiting.key);
        continue;
      }
      if (!(await passesPluginGate(deps, binding, event, item, refused))) {
        await deps.ledger.dequeue(binding.id, waiting.key);
        continue;
      }
      const outcome = await deps.firer.fire(item);
      if (outcome.status !== 'deferred') await deps.ledger.dequeue(binding.id, waiting.key);
    }
  }
}
