// SPDX-License-Identifier: MPL-2.0
import { NotFound, type Clock, type CodeHost, type IssueTracker, type Store } from '@otheater/core';
import { PLAY_WORKFLOW, type ValidateOptions } from '@otheater/workflows';
import type { DaemonConfig } from '../config.js';
import type { AskApproval } from '../browser/approval.js';
import type { Logger } from '../logger.js';
import type { Env } from '../paths.js';
import type { PluginAggregator } from '../plugins/aggregate.js';
import { situationSubject, situationText, writeSituation } from '../situations.js';
import { PluginEffectRegistry } from '../workspace/plugin-effects.js';
import { WorkflowBindings, type BudgetWarning } from './bindings.js';
import { commentFinderOf } from './comment-finder.js';
import { registerWorkflowEffects } from './effects.js';
import { WorkflowPackageInstaller, WorkflowPackageRegistry } from './packages/index.js';
import { workflowPackagePaths } from './packages/registry.js';
import { WorkflowLibrary } from './library.js';
import { createPluginToolCaller } from './plugin-tool-caller.js';
import { workflowRuntimeSettings } from './runtime-config.js';
import { WorkflowRuntime } from './runtime.js';
import { workflowSecuritySettings } from './security-config.js';
import { CODE_HOST_STEP_RUNNERS, GENERIC_STEP_RUNNERS } from './steps/index.js';
import { registerCodeHostEffects } from './steps/codehost/index.js';
import {
  createLatePlayRunPort,
  createRunPlayStep,
  type LatePlayRunPort,
} from './steps/play/run-play.js';
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
 * by the machine of `pipeline/` (see the plan, P10a, "Como ficou"). The bridge is `run_play` (P12):
 * it opens a play through the runner of today. The orchestration exists only after the workflows
 * are composed, so `plays` is a port the daemon binds (`plays.bind`) once it has the runner; a
 * `run_play` that runs before that fails with `step_failed`.
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
  /**
   * Told after the budget of a binding ran out and the chat was told (P10b). The record is already
   * written (`workflow.budget_exhausted`, by the bindings) and so is the notice of the chat
   * (`scenario.system_message`, kind `workflow_budget`); this is for whoever wants more.
   */
  readonly onBudgetExhausted?: ((warning: BudgetWarning) => void) | undefined;
  /**
   * What the installer of packages runs `git` and `ssh-keygen` with, and where a relative origin is
   * resolved from. Absent: the daemon composes no installer and the package routes answer 503.
   */
  readonly packageEnv?: { readonly env: Env; readonly cwd: string } | undefined;
}

export interface ComposedWorkflows {
  readonly library: WorkflowLibrary;
  readonly bindings: WorkflowBindings;
  readonly runtime: WorkflowRuntime;
  readonly triggers: WorkflowTriggers;
  /** The verifiers of the effects of the workflows (and, later, of the plugins). */
  readonly pluginEffects: PluginEffectRegistry;
  /** The door of `run_play` to the plays of the orchestration; the daemon binds it (P12). */
  readonly plays: LatePlayRunPort;
  /** The installer of packages (P9); absent when `input.packageEnv` is. */
  readonly packages: WorkflowPackageInstaller | undefined;
  /**
   * What the validator of the library and of the runtime checks against, read live: the rule
   * `workflows.security.require_approval` of the configuration of now (P10b).
   */
  readonly validateOptions: () => ValidateOptions;
}

/**
 * Puts the `play` of the engine in the library when it is not there (P10b; source `builtin`). A
 * version that is already saved is left as it is, so a restart never touches what the Producer
 * chose to activate. It becomes the active version only when the workflow has none yet.
 */
export async function installBuiltinPlay(
  library: Pick<WorkflowLibrary, 'get' | 'install'>,
): Promise<boolean> {
  if ((await library.get(PLAY_WORKFLOW.id, PLAY_WORKFLOW.version)) !== undefined) return false;
  await library.install(PLAY_WORKFLOW, { source: 'builtin' });
  return true;
}

export function composeWorkflows(input: ComposeWorkflowsInput): ComposedWorkflows {
  const { store, clock, logger } = input;
  // `workflows.security.require_approval`, read at every validation: a reload of the configuration
  // changes the rule without a restart. The library, the installer and the runtime share it.
  const validateOptions = (): ValidateOptions => ({
    requireApproval: workflowSecuritySettings(input.config()).requireApproval,
  });
  // The runtime does not exist yet when the library is built (the runtime resolves its definitions
  // through the library): `onActivated` reaches it through this reference.
  const runtimeRef: { current?: WorkflowRuntime } = {};
  const library = new WorkflowLibrary({
    store,
    settings: input.config,
    validateOptions,
    onActivated: async (workflowId, version) => {
      try {
        await runtimeRef.current?.onActivated(workflowId, version);
      } catch (error) {
        // The version is active; the runs stay where they are (as with `pin`). Told, not hidden.
        logger.warn({ err: error, workflowId, version }, 'the migration of the open runs failed');
        await writeSituation(store.events, logger, 'daemon.notice', {
          kind: 'workflow_migration_failed',
          subject: situationSubject(`${workflowId}@${version}`),
          detail: situationText(error),
        });
      }
    },
  });
  const bindings = new WorkflowBindings({
    store,
    library,
    clock,
    settings: input.config,
    logger,
    onBudgetExhausted: (warning) => {
      void announceBudget(store, logger, warning).then(() => input.onBudgetExhausted?.(warning));
    },
  });
  // The scenario of a project: its `folder` is the absolute path of the repository, which is the
  // `repo` of the calls to the code host and the issue tracker (the steps never take it from a run).
  const repoOf = async (scenarioId: string): Promise<string> => {
    const scenario = await store.scenarios.get(scenarioId);
    if (scenario === undefined) throw new NotFound(`There is no scenario ${scenarioId}`);
    return scenario.folder;
  };
  const plays = createLatePlayRunPort();
  const pluginEffects = new PluginEffectRegistry();
  registerWorkflowEffects(pluginEffects, store);
  // [proposta] The finder of comments (P10b): it settles a `comment` a crash cut off by the marker
  // of its key, when the issue tracker can list comments (the GitHub one can). Without one, the
  // comment stays `effect_ambiguous` rather than risk a second one.
  const findComment = commentFinderOf(input.issueTracker);
  registerCodeHostEffects(pluginEffects, { findComment });
  const runtime = new WorkflowRuntime({
    store,
    clock,
    settings: workflowRuntimeSettings(input.config()),
    steps: [...GENERIC_STEP_RUNNERS, ...CODE_HOST_STEP_RUNNERS, createRunPlayStep(plays.port)],
    tools: createPluginToolCaller(input.aggregator),
    ask: input.ask,
    pluginEffects,
    codeHost: {
      codeHost: input.codeHost,
      issueTracker: input.issueTracker,
      repoOf,
      // Read at each step: `require_approval` is also the second line of defence at run time.
      get security() {
        return workflowSecuritySettings(input.config());
      },
      findComment,
    },
    source: {
      resolve: async ({ id, version }) => (await library.resolve(id, version))?.definition,
    },
    // The same rule of approval the library applies when it saves a definition.
    validate: {
      get requireApproval() {
        return workflowSecuritySettings(input.config()).requireApproval;
      },
    },
    runningOnChange: () => input.config().running_on_change,
    logger,
  });
  runtimeRef.current = runtime;
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
  const paths = workflowPackagePaths(input.dataDir);
  const packages =
    input.packageEnv === undefined
      ? undefined
      : new WorkflowPackageInstaller({
          library,
          registry: new WorkflowPackageRegistry(paths.file),
          settings: () => input.config().packages,
          validateOptions,
          stagingDir: paths.staging,
          events: store.events,
          logger,
          clock,
          env: input.packageEnv.env,
          cwd: input.packageEnv.cwd,
        });
  return { library, bindings, runtime, triggers, pluginEffects, plays, packages, validateOptions };
}

/**
 * The chat of the scenario of a binding is told that its budget ran out (P10b, [proposta]): one
 * `scenario.system_message` event of the kind `workflow_budget`, which the chat socket delivers
 * and the TUI and `ot chat` render. The event of the record, `workflow.budget_exhausted`, is the
 * bindings' own. A write that fails is only logged, as with every situation.
 */
async function announceBudget(
  store: Pick<Store, 'events'>,
  logger: Logger,
  warning: BudgetWarning,
): Promise<void> {
  const { binding, action } = warning;
  if (binding.budgetUsd === null || binding.budgetUsd <= 0) return;
  await writeSituation(
    store.events,
    logger,
    'scenario.system_message',
    {
      scenarioId: binding.scenarioId,
      kind: 'workflow_budget',
      bindingId: binding.id,
      workflowId: binding.workflowId,
      action,
      budgetUsd: binding.budgetUsd,
      spentUsd: binding.spentUsd,
      period: binding.budgetPeriod,
    },
    { scenarioId: binding.scenarioId },
  );
}
