// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import {
  type CiLog,
  type CiRun,
  type EventEnvelope,
  type JsonObject,
  type WorkflowBindingRecord,
} from '@otheater/core';
import { FakeClock, FakeIssueTracker, InMemoryStore } from '@otheater/core/testing';
import { PLAY_WORKFLOW } from '@otheater/workflows';
import { createSilentLogger } from '../../logger.js';
import { WorkflowBindings } from '../bindings.js';
import { DEFAULT_WORKFLOWS_SETTINGS } from '../config.js';
import { WorkflowLibrary } from '../library.js';
import type { StartWorkflowInput, StartWorkflowResult } from '../runtime.js';
import { tempFolder } from '../packages/packages.test-support.js';
import { DEFAULT_WORKFLOW_TRIGGERS_SETTINGS, type WorkflowTriggersSettings } from './config.js';
import type { ActivePluginReader } from './plugin-events.js';
import { createWorkflowTriggers, type WorkflowTriggers } from './service.js';
import type {
  CiReader,
  CollaboratorCheck,
  PullRequestLister,
  PullRequestSummary,
} from './types.js';

/**
 * Helpers of the tests of the triggers (P6 of Phase 11b): a rig with the fake clock, the in-memory
 * store, a library with the `play` workflow, the fake issue tracker and small fakes for the narrow
 * ports (pull requests, CI, collaborators, plugins) and for the runtime (it makes a play in the
 * store, so `Conflict` and the count of live runs are the real ones). Nothing touches the network.
 */

/** A runtime that starts a play in the store and does nothing else. */
export class FakeRuntime {
  readonly started: StartWorkflowInput[] = [];
  readonly cancelled: { readonly runId: string; readonly reason: string }[] = [];
  /** When set, `start` refuses with this detail. */
  refuseWith: string | undefined;
  readonly #store: InMemoryStore;
  readonly #clock: FakeClock;

  constructor(store: InMemoryStore, clock: FakeClock) {
    this.#store = store;
    this.#clock = clock;
  }

  async start(input: StartWorkflowInput): Promise<StartWorkflowResult> {
    if (this.refuseWith !== undefined) {
      return { ok: false, refusal: 'invalid_inputs', detail: this.refuseWith };
    }
    await this.#store.plays.create({
      id: input.runId,
      scenarioId: input.scenarioId,
      need: `workflow:${input.runId}`,
      flowId: 'play',
      flowVersion: 1,
      state: 'RUNNING',
    });
    this.started.push(input);
    return {
      ok: true,
      runId: input.runId,
      workflow: { id: 'play', version: '1.0.0', hash: 'sha256:00' },
    };
  }

  async cancel(runId: string, reason = 'cancelled'): Promise<boolean> {
    await this.#store.plays.update(runId, { finishedAt: this.#clock.now() });
    this.cancelled.push({ runId, reason });
    return true;
  }

  /** Ends a run, as a finished workflow would: it no longer counts as live. */
  async finish(runId: string): Promise<void> {
    await this.#store.plays.update(runId, { finishedAt: this.#clock.now() });
  }
}

export class FakePullRequests implements PullRequestLister {
  readonly pulls: PullRequestSummary[] = [];
  failWith: Error | undefined;
  calls = 0;

  listOpen(): Promise<readonly PullRequestSummary[]> {
    this.calls += 1;
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve([...this.pulls]);
  }
}

export class FakeCi implements CiReader {
  readonly byNumber = new Map<number, { headSha: string; conclusion: string | null }>();
  calls = 0;

  fetchCiLog(opts: { readonly number: number }): Promise<CiLog> {
    this.calls += 1;
    const ci = this.byNumber.get(opts.number) ?? { headSha: 'sha0', conclusion: 'success' };
    const run: CiRun = {
      id: '1',
      name: 'ci',
      status: 'completed',
      conclusion: ci.conclusion,
      url: 'https://ci.invalid/1',
    };
    return Promise.resolve({ headSha: ci.headSha, runs: [run], log: '', truncated: false });
  }
}

export class FakeCollaborators implements CollaboratorCheck {
  readonly logins = new Set<string>();
  calls = 0;

  isCollaborator(opts: { readonly login: string }): Promise<boolean> {
    this.calls += 1;
    return Promise.resolve(this.logins.has(opts.login));
  }
}

export class FakePlugins implements ActivePluginReader {
  readonly #byProject = new Map<
    string,
    { id: string; manifest: { triggers?: readonly string[] } }[]
  >();

  /** Makes a plugin active in a project; `triggers` is what its manifest declares. */
  activate(project: string, id: string, triggers?: readonly string[]): void {
    const list = this.#byProject.get(project) ?? [];
    list.push({ id, manifest: triggers === undefined ? {} : { triggers } });
    this.#byProject.set(project, list);
  }

  activeFor(
    project: string,
  ): readonly { id: string; manifest: { triggers?: readonly string[] } }[] {
    return this.#byProject.get(project) ?? [];
  }
}

export type TriggerPort = 'tracker' | 'pullRequests' | 'ci' | 'collaborators';

export interface TriggerRig {
  readonly clock: FakeClock;
  readonly store: InMemoryStore;
  readonly bindings: WorkflowBindings;
  readonly library: WorkflowLibrary;
  readonly runtime: FakeRuntime;
  readonly tracker: FakeIssueTracker;
  readonly pullRequests: FakePullRequests;
  readonly ci: FakeCi;
  readonly collaborators: FakeCollaborators;
  readonly plugins: FakePlugins;
  readonly dataDir: string;
  readonly errors: string[];
  /** Ports the next `restart()` leaves out (the daemon has no adapter for them). */
  readonly without: Set<TriggerPort>;
  settings: WorkflowTriggersSettings;
  /** The triggers of the rig; `restart()` makes new ones over the same data directory. */
  triggers: WorkflowTriggers;
  restart(): WorkflowTriggers;
  /** A binding of the scenario `s1` (the workflow `play`). */
  bind(
    triggers: readonly JsonObject[],
    extra?: Partial<Parameters<WorkflowBindings['create']>[0]>,
  ): Promise<WorkflowBindingRecord>;
  /** One look of both loops. */
  pass(): Promise<void>;
  /** The events of a type, with their payloads, in the order they were written. */
  eventsOf(type: string): Promise<readonly Record<string, unknown>[]>;
  /** An event the way a plugin would send it (`plugin.<id>.<name>` for the scenario). */
  appendEvent(type: string, scenarioId?: string): Promise<EventEnvelope>;
}

export async function triggerRig(
  overrides: Partial<WorkflowTriggersSettings> = {},
): Promise<TriggerRig> {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const library = new WorkflowLibrary({ store, settings: () => DEFAULT_WORKFLOWS_SETTINGS });
  await library.install(PLAY_WORKFLOW, { source: 'builtin' });
  for (const id of ['s1', 's2']) {
    await store.scenarios.create({
      id,
      kind: 'project',
      flowId: 'play',
      name: id,
      folder: join('work', id),
      baseBranch: 'main',
    });
  }
  const bindings = new WorkflowBindings({
    store,
    library,
    clock,
    settings: () => DEFAULT_WORKFLOWS_SETTINGS,
    logger: createSilentLogger(),
    onBudgetExhausted: () => undefined,
  });
  const runtime = new FakeRuntime(store, clock);
  const tracker = new FakeIssueTracker({ clock });
  const pullRequests = new FakePullRequests();
  const ci = new FakeCi();
  const collaborators = new FakeCollaborators();
  const plugins = new FakePlugins();
  const dataDir = await tempFolder('ottrg-');
  const errors: string[] = [];
  const without = new Set<TriggerPort>();
  const state: { settings: WorkflowTriggersSettings } = {
    settings: {
      ...DEFAULT_WORKFLOW_TRIGGERS_SETTINGS,
      authors_list: ['fake-user'],
      ...overrides,
    },
  };
  const make = (): WorkflowTriggers =>
    createWorkflowTriggers({
      clock,
      events: store.events,
      logger: { error: (_fields, message) => errors.push(message) },
      plays: store.plays,
      bindings,
      library,
      runtime,
      plugins,
      dataDir,
      settings: () => state.settings,
      repoOf: (scenarioId) => `owner/${scenarioId}`,
      tracker: without.has('tracker') ? undefined : tracker,
      pullRequests: without.has('pullRequests') ? undefined : pullRequests,
      ci: without.has('ci') ? undefined : ci,
      collaborators: without.has('collaborators') ? undefined : collaborators,
    });
  const rig: TriggerRig = {
    clock,
    store,
    bindings,
    library,
    runtime,
    tracker,
    pullRequests,
    ci,
    collaborators,
    plugins,
    dataDir,
    errors,
    without,
    get settings() {
      return state.settings;
    },
    set settings(value) {
      state.settings = value;
    },
    triggers: make(),
    restart() {
      rig.triggers = make();
      return rig.triggers;
    },
    bind: (triggers, extra = {}) =>
      bindings.create({ scenarioId: 's1', workflowId: 'play', triggers, ...extra }),
    pass: () => rig.triggers.pass(),
    async eventsOf(type) {
      const all = await store.events.readFrom(0, 5000);
      return all.filter((event) => event.type === type).map((event) => event.payload);
    },
    appendEvent: (type, scenarioId = 's1') =>
      store.events.append({ type, schemaVersion: 1, payload: {}, scenarioId }),
  };
  return rig;
}
