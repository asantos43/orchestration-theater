// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  type Clock,
  type EventLog,
  type IssueTracker,
  type PlayRegistry,
  type WorkflowBindingRecord,
  workflowBudgetExhausted,
} from '@otheater/core';
import { type SituationErrorLog, writeSituation } from '../../situations.js';
import type { WorkflowBindings } from '../bindings.js';
import type { WorkflowLibrary } from '../library.js';
import type { WorkflowRuntime } from '../runtime.js';
import { AuthorGate } from './authors.js';
import { codeHostSource } from './code-host.js';
import type { WorkflowTriggersSettings } from './config.js';
import { TriggerFirer } from './fire.js';
import { eventSource } from './internal.js';
import type { ActivePluginReader } from './plugin-events.js';
import { PollLoop, type PollFailure, type PollSource } from './poll-loop.js';
import { SeenLedger, workflowTriggersFile } from './seen.js';
import {
  type CiReader,
  type CollaboratorCheck,
  parseBindingTriggers,
  type PullRequestLister,
} from './types.js';

/**
 * Assembles the triggers of the workflow bindings (plan of Phase 11b, P6): two poll loops on the
 * `Clock`, one for the code host (every `workflows.triggers.poll.interval`) and one for the log of
 * events (every `workflows.triggers.event_poll`), the ledger of what was seen, and the firer that
 * applies the rules of the binding. Nothing here talks to the operating system (D3).
 *
 * The daemon composition calls {@link createWorkflowTriggers} and then `start()` / `stop()` (P10
 * wires it, with the adapters of the code host: `repoOf`, `pullRequests`, `collaborators`).
 * `pass()` runs one look of each loop now, for tests and for a command that asks for a look.
 *
 * What a failed look does follows `workflows.triggers.poll.on_error`:
 * - `backoff`: the source waits `interval * 2^failures` (up to `backoff_max`) and the look is
 *   repeated; `workflow.poll.failed` says so (`action: backoff`);
 * - `pause_binding`: the binding of the source is paused (reason `producer`: [proposta] there is
 *   no reason of its own for a poll error; the event tells the cause) and the Producer resumes it;
 *   `workflow.poll.failed` carries `action: pause_binding`. The look at the log has no binding, so
 *   it always backs off.
 */

export interface WorkflowTriggersDeps {
  readonly clock: Clock;
  readonly events: EventLog;
  readonly logger: SituationErrorLog;
  readonly plays: Pick<PlayRegistry, 'list'>;
  readonly bindings: Pick<WorkflowBindings, 'get' | 'list' | 'pause'>;
  readonly library: Pick<WorkflowLibrary, 'resolve'>;
  readonly runtime: Pick<WorkflowRuntime, 'start' | 'cancel'>;
  readonly plugins: ActivePluginReader;
  /** The data directory: the ledger is `<dataDir>/workflow-triggers.json`. */
  readonly dataDir: string;
  /** The resolved `workflows.triggers`; read at every look, so a change of configuration applies. */
  readonly settings: () => WorkflowTriggersSettings;
  /** The repository (`owner/name`) of the project of a scenario. */
  readonly repoOf: (scenarioId: string) => string | Promise<string>;
  readonly tracker?: Pick<IssueTracker, 'listIssues'> | undefined;
  readonly pullRequests?: PullRequestLister | undefined;
  readonly ci?: CiReader | undefined;
  readonly collaborators?: CollaboratorCheck | undefined;
}

export interface WorkflowTriggers {
  /** Starts both loops (a first look now, then one per interval). Starting twice does nothing. */
  start(): void;
  /** Stops both loops and waits for the look in flight. */
  stop(): Promise<void>;
  /** One look of each loop now, outside the timers. */
  pass(): Promise<void>;
  /** What the triggers remember (for tests and for the commands that show it). */
  readonly ledger: SeenLedger;
}

/** The longest the log is read in a row of failures (used when `event_poll` is `off`). */
const IDLE_EVENT_INTERVAL_MS = 2_000;

export function createWorkflowTriggers(deps: WorkflowTriggersDeps): WorkflowTriggers {
  const ledger = new SeenLedger(workflowTriggersFile(deps.dataDir));
  const firer = new TriggerFirer({
    clock: deps.clock,
    events: deps.events,
    logger: deps.logger,
    plays: deps.plays,
    bindings: deps.bindings,
    library: deps.library,
    runtime: deps.runtime,
    ledger,
  });
  const authors = new AuthorGate({
    clock: deps.clock,
    settings: deps.settings,
    collaborators: deps.collaborators,
  });
  const codeHostDeps = {
    settings: deps.settings,
    tracker: deps.tracker,
    pullRequests: deps.pullRequests,
    ci: deps.ci,
    repoOf: deps.repoOf,
    authors,
    firer,
    ledger,
  };

  /** What each source belongs to, to tell a failure which binding to pause. */
  const owners = new Map<string, { readonly binding: WorkflowBindingRecord; type: string }>();
  const announcedInvalid = new Set<string>();

  const codeHostSources = async (): Promise<readonly PollSource[]> => {
    const settings = deps.settings();
    owners.clear();
    const sources: PollSource[] = [];
    const active = await deps.bindings.list({ states: ['active'] });
    for (const binding of active) {
      const { valid, invalid } = parseBindingTriggers(binding);
      for (const bad of invalid) {
        const once = `${binding.id}#${String(bad.index)}#${bad.detail}`;
        if (announcedInvalid.has(once)) continue;
        announcedInvalid.add(once);
        await firer.skip(
          { binding, triggerType: bad.type, key: `invalid:${String(bad.index)}`, number: null },
          'invalid',
          bad.detail,
        );
      }
      if (settings.poll.mode === 'off' || workflowBudgetExhausted(binding)) continue;
      for (const parsed of valid) {
        if (parsed.trigger.type === 'event') continue;
        const source = codeHostSource(codeHostDeps, binding, parsed);
        owners.set(source.id, { binding, type: parsed.trigger.type });
        sources.push(source);
      }
    }
    return sources;
  };

  const eventSources = (): readonly PollSource[] =>
    deps.settings().event_poll === null
      ? []
      : [
          eventSource({
            settings: deps.settings,
            events: deps.events,
            bindings: deps.bindings,
            plugins: deps.plugins,
            firer,
            ledger,
          }),
        ];

  let listFailures = 0;
  const onListFailure =
    (triggerType: string, interval: () => number) =>
    async (error: unknown): Promise<void> => {
      listFailures += 1;
      await writePollFailed({
        bindingId: null,
        scenarioId: null,
        workflowId: null,
        triggerType,
        error,
        failures: listFailures,
        action: 'backoff',
        retryInMs: interval(),
      });
    };

  const onFailure = async (failure: PollFailure): Promise<void> => {
    const owner = owners.get(failure.source.id);
    const pause = deps.settings().poll.on_error === 'pause_binding' && owner !== undefined;
    if (owner !== undefined && pause) {
      try {
        await deps.bindings.pause(owner.binding.id);
      } catch (error) {
        // Already paused or stopped by the Producer meanwhile: the goal is met.
        if (!(error instanceof Conflict)) throw error;
      }
    }
    await writePollFailed({
      bindingId: owner?.binding.id ?? null,
      scenarioId: owner?.binding.scenarioId ?? null,
      workflowId: owner?.binding.workflowId ?? null,
      triggerType: owner?.type ?? 'event',
      error: failure.error,
      failures: failure.failures,
      action: pause ? 'pause_binding' : 'backoff',
      retryInMs: pause ? null : failure.retryInMs,
    });
  };

  const writePollFailed = (fields: {
    readonly bindingId: string | null;
    readonly scenarioId: string | null;
    readonly workflowId: string | null;
    readonly triggerType: string;
    readonly error: unknown;
    readonly failures: number;
    readonly action: 'backoff' | 'pause_binding';
    readonly retryInMs: number | null;
  }): Promise<void> => {
    const text = fields.error instanceof Error ? fields.error.message : String(fields.error);
    return writeSituation(
      deps.events,
      deps.logger,
      'workflow.poll.failed',
      {
        bindingId: fields.bindingId,
        scenarioId: fields.scenarioId,
        workflowId: fields.workflowId,
        triggerType: fields.triggerType,
        error: (text === '' ? 'unknown error' : text).slice(0, 400),
        failures: fields.failures,
        action: fields.action,
        retryInMs: fields.retryInMs,
      },
      fields.scenarioId === null ? {} : { scenarioId: fields.scenarioId },
    );
  };

  const codeInterval = (): number => deps.settings().poll.interval;
  const eventInterval = (): number => deps.settings().event_poll ?? IDLE_EVENT_INTERVAL_MS;
  const backoffMax = (): number => deps.settings().poll.backoff_max;

  const codeLoop = new PollLoop({
    clock: deps.clock,
    interval: codeInterval,
    backoffMax,
    sources: async () => {
      const sources = await codeHostSources();
      listFailures = 0;
      return sources;
    },
    onFailure,
    onListFailure: onListFailure('code_host', codeInterval),
  });
  const eventLoop = new PollLoop({
    clock: deps.clock,
    interval: eventInterval,
    backoffMax,
    sources: eventSources,
    onFailure,
    onListFailure: onListFailure('event', eventInterval),
  });

  return {
    ledger,
    start() {
      codeLoop.start();
      eventLoop.start();
    },
    async stop() {
      await Promise.all([codeLoop.stop(), eventLoop.stop()]);
    },
    async pass() {
      await codeLoop.pass();
      await eventLoop.pass();
    },
  };
}
