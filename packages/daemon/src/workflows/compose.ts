// SPDX-License-Identifier: MPL-2.0
import { NotFound, type Clock, type CodeHost, type IssueTracker, type Store } from '@otheater/core';
import type { DaemonConfig } from '../config.js';
import type { AskApproval } from '../browser/approval.js';
import type { Logger } from '../logger.js';
import type { PluginAggregator } from '../plugins/aggregate.js';
import { PluginEffectRegistry } from '../workspace/plugin-effects.js';
import { WorkflowBindings, type BudgetWarning } from './bindings.js';
import { registerWorkflowEffects } from './effects.js';
import { WorkflowLibrary } from './library.js';
import { createPluginToolCaller } from './plugin-tool-caller.js';
import { workflowRuntimeSettings } from './runtime-config.js';
import { WorkflowRuntime } from './runtime.js';
import { workflowSecuritySettings } from './security-config.js';
import { CODE_HOST_STEP_RUNNERS, GENERIC_STEP_RUNNERS } from './steps/index.js';
import { registerCodeHostEffects } from './steps/codehost/index.js';
import type { ActivePluginReader } from './triggers/plugin-events.js';
import { createWorkflowTriggers, type WorkflowTriggers } from './triggers/service.js';
import type { CollaboratorCheck, PullRequestLister } from './triggers/types.js';

/**
 * The workflow engine as the daemon wires it (Phase 11b, P10a): the library of definitions, the
 * bindings, the runtime with the code of the generic steps and of the code host steps, the
 * registry of the verifiers of effects the recovery of the start-up reads, and the triggers.
 *
 * What the daemon does with the parts (see `daemon.ts`):
 * - `pluginEffects` goes to `reconcileBeforeResume`, so an effect of a workflow that was cut by a
 *   crash is settled before anything runs again;
 * - `runtime.resumeAll()` runs next to the one of the plays, right after the recovery;
 * - `triggers.start()` runs once the gate opens, and `triggers.stop()` and `runtime.stop()` are the
 *   first things the shutdown does to the workflows. With `workflows.triggers.poll.mode: off` the
 *   loop of the code host looks at nothing (`event_poll` is the key of the other one).
 *
 * The step types of the `play` (`createPlayStepRunners`) are not added here: the play still runs
 * by the machine of `pipeline/` (see the plan, P10a, "Como ficou").
 */

export interface ComposeWorkflowsInput {
  /** The resolved `workflows` block; the triggers and the library read it at every use. */
  readonly config: () => DaemonConfig['workflows'];
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dataDir: string;
  /** The data of the plugins: the tools `call_tool` calls and the plugins active in a project. */
  readonly aggregator: PluginAggregator;
  readonly plugins: ActivePluginReader;
  /** Opens the question of an `approval` to the Producer. */
  readonly ask: AskApproval;
  readonly codeHost: CodeHost;
  readonly issueTracker: IssueTracker;
  /** What `pr_opened`, `ci_failed` and `authors: collaborators` read; absent when the host is not GitHub. */
  readonly pullRequests?: PullRequestLister | undefined;
  readonly collaborators?: CollaboratorCheck | undefined;
  /** Told when the budget of a binding runs out (the chat shows it). */
  readonly onBudgetExhausted?: ((warning: BudgetWarning) => void) | undefined;
}

export interface ComposedWorkflows {
  readonly library: WorkflowLibrary;
  readonly bindings: WorkflowBindings;
  readonly runtime: WorkflowRuntime;
  readonly triggers: WorkflowTriggers;
  /** The verifiers of the effects of the workflows (and, later, of the plugins). */
  readonly pluginEffects: PluginEffectRegistry;
}

export function composeWorkflows(input: ComposeWorkflowsInput): ComposedWorkflows {
  const { store, clock, logger } = input;
  const settings = input.config();
  const library = new WorkflowLibrary({ store, settings: input.config });
  const bindings = new WorkflowBindings({
    store,
    library,
    clock,
    settings: input.config,
    logger,
    onBudgetExhausted: input.onBudgetExhausted,
  });
  // The scenario of a project: its `folder` is the absolute path of the repository, which is the
  // `repo` of the calls to the code host and the issue tracker (the steps never take it from a run).
  const repoOf = async (scenarioId: string): Promise<string> => {
    const scenario = await store.scenarios.get(scenarioId);
    if (scenario === undefined) throw new NotFound(`There is no scenario ${scenarioId}`);
    return scenario.folder;
  };
  const pluginEffects = new PluginEffectRegistry();
  registerWorkflowEffects(pluginEffects, store);
  // [proposta] No finder of comments yet (the `IssueTracker` port has no way to list them): a
  // `comment` cut off by a crash ends `effect_ambiguous` rather than risk a second comment.
  registerCodeHostEffects(pluginEffects, {});
  const runtime = new WorkflowRuntime({
    store,
    clock,
    settings: workflowRuntimeSettings(settings),
    steps: [...GENERIC_STEP_RUNNERS, ...CODE_HOST_STEP_RUNNERS],
    tools: createPluginToolCaller(input.aggregator),
    ask: input.ask,
    pluginEffects,
    codeHost: {
      codeHost: input.codeHost,
      issueTracker: input.issueTracker,
      repoOf,
      security: workflowSecuritySettings(settings),
    },
    source: {
      resolve: async ({ id, version }) => (await library.resolve(id, version))?.definition,
    },
    logger,
  });
  const triggers = createWorkflowTriggers({
    clock,
    events: store.events,
    logger,
    plays: store.plays,
    bindings,
    library,
    runtime,
    plugins: input.plugins,
    dataDir: input.dataDir,
    settings: () => input.config().triggers,
    repoOf,
    tracker: input.issueTracker,
    pullRequests: input.pullRequests,
    ci: input.codeHost,
    collaborators: input.collaborators,
  });
  return { library, bindings, runtime, triggers, pluginEffects };
}
