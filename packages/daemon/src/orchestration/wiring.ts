// SPDX-License-Identifier: MPL-2.0
import { homedir } from 'node:os';
import type { PromptSource, Registries } from '@otheater/core';
import type { Composition } from '../compose.js';
import type { DaemonConfig } from '../config.js';
import type { Execution } from '../execution/service.js';
import type { McpAccess } from '../mcp/access.js';
import type { DataPaths } from '../paths.js';
import type { QuotaService } from '../quota/service.js';
import { PlayRunner } from '../pipeline/index.js';
import { ConventionConfirmer } from '../project/confirm.js';
import { PromptDispatcher } from '../prompt-dispatcher.js';
import { attachmentRootsPolicy } from '../scenarios/attachment-roots.js';
import {
  AttachmentService,
  ChatFlow,
  ConsultService,
  ScenarioService,
  type ScenarioHandlers,
} from '../scenarios/index.js';
import { IdeaQueueService } from '../ideas/index.js';
import { Workspace } from '../workspace/index.js';
import { ProducerChannel } from './channel.js';
import { DirectorSessions } from './director.js';
import { createDaemonHandoff, type LateHandoff } from './handoff-wiring.js';
import type { OrchestrationHandlers } from './handlers.js';
import type { PlayOpening } from './open-play.js';
import { OrchestrationEffects } from './play-effects.js';
import { ChatPresence } from './presence.js';
import { RoleSelection } from './role-selection.js';

export interface OrchestrationInput {
  readonly config: DaemonConfig;
  readonly composition: Composition;
  readonly execution: Execution;
  /**
   * What the choice of the Executor reads: the quota of each profile (P16); and what the failover
   * of the Director tells it about a limit error (P20).
   */
  readonly quota: Pick<QuotaService, 'statusOf' | 'ingestLimitHit'>;
  readonly mcp: McpAccess;
  readonly registries: Registries;
  readonly prompts: PromptSource;
  readonly paths: Pick<DataPaths, 'profiles' | 'worktrees' | 'scenarios' | 'dataDir'>;
  readonly handlers: OrchestrationHandlers;
  /** The handlers of `consult` and `read_attachment` (P12), bound here with the services. */
  readonly scenarioHandlers: ScenarioHandlers;
  /**
   * The baton of the attempts (P18, P16b): the runner already holds it, and the wiring binds the
   * real port here, with the selection that is built here. Absent, a handoff parks the attempt.
   */
  readonly handoff?: LateHandoff;
  /** The absolute home of the account, for `security.secret_paths`. */
  readonly home?: string;
}

/** The plays of the daemon, running: what `startDaemon` builds once the execution exists (P8). */
export interface Orchestration {
  readonly runner: PlayRunner;
  readonly channel: ProducerChannel;
  readonly scenarios: ScenarioService;
  readonly attachments: AttachmentService;
  readonly chatFlow: ChatFlow;
  /** The idea queue of the scenarios (5.20). */
  readonly ideas: IdeaQueueService;
  /** What opens a play from a need: the Director's `open_play`, the idea queue and the direct session (P19). */
  readonly opening: PlayOpening;
  /** The choice of the Executor of each role, and the demands waiting for one (P16). */
  readonly selection: RoleSelection;
  /** The Director sessions of the scenarios (P21b: the removal of a profile moves them). */
  readonly directors: DirectorSessions;
  /**
   * First step of the shutdown, before the execution stops: closes the door of the Producer
   * channel, frees the questions that wait for the Producer, and stops the plays from taking the
   * results of work that is ending. Idempotent.
   */
  quiesce(): Promise<void>;
  /** Last step, after the execution stopped: waits for the work of the effects to end. */
  drain(): Promise<void>;
}

/**
 * Puts the pieces of the play together (architecture 5.4): the single queue of prompts, the
 * Director sessions it feeds, the effects that open Actors and integrate and deliver, the machine
 * runner, the MCP handlers of the Director's tools, and the Producer channel the API uses.
 *
 * The runner is not asked to resume the plays the previous daemon left (`resumeAll`) here: the
 * reconciliation of the start-up (`recovery/reconcile.ts`, P9) calls it, once it has checked what
 * each play left behind.
 */
export function startOrchestration(input: OrchestrationInput): Orchestration {
  const { config, composition, execution, mcp, registries, prompts, paths, handlers } = input;
  const { scenarioHandlers } = input;
  const { store, logger } = composition;
  // The queue of ideas hears the end of every play; it is built after the runner it needs.
  const late: { ideas?: IdeaQueueService } = {};
  const selection = new RoleSelection({
    store,
    config,
    quota: input.quota,
    pool: execution.pool,
    paths,
    clock: composition.clock,
    logger,
    situations: composition.situations,
  });
  const dispatcher = new PromptDispatcher({
    store,
    order: config.prompt_queue.order,
    // Phase 8, P15 (N222 (a)): a prompt that waits in the queue past the threshold is told in the log.
    ...(composition.waitEvents === undefined ? {} : { waits: composition.waitEvents }),
    onError: (error, item) => {
      logger.error({ err: error, scenarioId: item?.scenarioId }, 'a prompt could not be delivered');
    },
    onQueued: (item) => {
      composition.situations.record(
        'prompt.queued',
        { promptId: item.id, source: item.source, priority: item.priority },
        { scenarioId: item.scenarioId },
      );
    },
  });
  const directors = new DirectorSessions({
    store,
    execution,
    mcp,
    dispatcher,
    prompts,
    registries,
    selection,
    config,
    paths,
    logger,
    clock: composition.clock,
    quota: input.quota,
    onReply: (scenarioId, reply) => {
      composition.situations.record(
        'chat.director_reply',
        {
          replyId: reply.seq,
          to: reply.to,
          text: reply.text,
          ...(reply.generated === undefined
            ? {}
            : {
                generated: true as const,
                tools: [...reply.generated.tools],
                ...(reply.generated.playId === null ? {} : { playId: reply.generated.playId }),
              }),
        },
        { scenarioId },
      );
    },
    onSilent: (scenarioId, silent) => {
      composition.situations.record('chat.director_silent', silent, { scenarioId });
    },
  });
  const workspace =
    composition.codeHost === undefined
      ? undefined
      : new Workspace({
          store,
          vcs: composition.vcs,
          codeHost: composition.codeHost,
          worktreeRoot: paths.worktrees,
        });
  if (workspace === undefined) {
    logger.warn(
      'no code host is set up: plays cannot be opened, because they could not deliver their work',
    );
  }
  const presence = new ChatPresence({
    clock: composition.clock,
    // N188: getters, so `chat.presence*` follow `PUT /v1/config`.
    get mode() {
      return config.chat.presence;
    },
    get windowMs() {
      return config.chat.presence_window;
    },
  });
  const effects = new OrchestrationEffects({
    store,
    execution,
    vcs: composition.vcs,
    workspace,
    dispatcher,
    directors,
    prompts,
    registries,
    selection,
    config,
    paths,
    logger,
    attended: ({ scenarioId }) => presence.attended(scenarioId),
    clock: composition.clock,
  });
  const runner = new PlayRunner({
    store,
    clock: composition.clock,
    effects,
    logger,
    onFinish: (play) => {
      void late.ideas?.onPlayFinished(play).catch((error: unknown) => {
        logger.error(
          { err: error, playId: play.id },
          'the ideas of a finished play were not settled',
        );
      });
    },
  });
  effects.bind(runner);
  const chatFlow = new ChatFlow({ store, logger });
  handlers.bind({ store, runner, workspace, directors, config, logger, chatFlow, selection });
  const scenarios = new ScenarioService({
    store,
    vcs: composition.vcs,
    registries,
    scenariosDir: paths.scenarios,
    conventionsMode: () => config.project.conventions,
  });
  const confirmer = new ConventionConfirmer({ store, board: handlers.board, logger });
  const attachments = new AttachmentService({
    store,
    clock: composition.clock,
    scenariosDir: paths.scenarios,
    limits: () => ({
      maxSize: config.scenarios.attachment_max_size,
      readMax: config.scenarios.attachment_read_max,
    }),
    roots: attachmentRootsPolicy({
      config: () => config.security.attachment_roots,
      store,
      worktrees: paths.worktrees,
      env: process.env,
      platform: process.platform,
      homedir: homedir(),
    }),
  });
  const consult = new ConsultService({
    store,
    vcs: composition.vcs,
    runner: execution.runner,
    adapters: execution.pool,
    registries,
    prompts,
    config,
    paths,
    attachments,
    chatFlow,
    selection,
    logger,
  });
  scenarioHandlers.bind({
    store,
    directors,
    attachments,
    consult,
    adapters: execution.pool,
    config,
  });
  const opening: PlayOpening = { store, runner, workspace, config };
  const ideas = new IdeaQueueService({
    store,
    vcs: composition.vcs,
    runner: execution.runner,
    registries,
    prompts,
    config,
    paths,
    opening,
    selection,
    logger,
  });
  late.ideas = ideas;
  const channel = new ProducerChannel({
    store,
    ideas,
    scenarios,
    attachments,
    directors,
    dispatcher,
    runner,
    board: handlers.board,
    logger,
    presence,
    confirmer,
    selection,
    conventionsMode: () => config.project.conventions,
  });
  if (input.handoff !== undefined && input.home !== undefined) {
    input.handoff.bind(
      createDaemonHandoff({
        config,
        store,
        selection,
        execution,
        prompts,
        registries,
        paths,
        logger,
        home: input.home,
        dataDir: paths.dataDir,
      }),
    );
  }
  let quiet: Promise<void> | undefined;
  return {
    runner,
    directors,
    channel,
    scenarios,
    attachments,
    chatFlow,
    ideas,
    opening,
    selection,
    quiesce: () =>
      (quiet ??= (async () => {
        handlers.board.abortAll('The daemon is stopping.');
        handlers.bind(undefined);
        scenarioHandlers.bind(undefined);
        selection.close();
        input.handoff?.bind(undefined);
        effects.close();
        await runner.close();
        await directors.close();
      })()),
    drain: async () => {
      await effects.idle();
      await ideas.idle();
    },
  };
}
