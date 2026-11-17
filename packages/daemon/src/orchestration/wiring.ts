// SPDX-License-Identifier: MPL-2.0
import type { PromptSource, Registries } from '@otheater/core';
import type { Composition } from '../compose.js';
import type { DaemonConfig } from '../config.js';
import type { Execution } from '../execution/service.js';
import type { McpAccess } from '../mcp/access.js';
import type { DataPaths } from '../paths.js';
import type { RecoveryGate } from '../recovery/gate.js';
import { PlayRunner } from '../pipeline/index.js';
import { ConventionConfirmer } from '../project/confirm.js';
import { PromptDispatcher } from '../prompt-dispatcher.js';
import {
  AttachmentService,
  ChatFlow,
  ConsultService,
  ScenarioService,
  type ScenarioHandlers,
} from '../scenarios/index.js';
import { Workspace } from '../workspace/index.js';
import { ProducerChannel } from './channel.js';
import { ProducerChannelServer } from './channel-http.js';
import { DirectorSessions } from './director.js';
import type { OrchestrationHandlers } from './handlers.js';
import { OrchestrationEffects } from './play-effects.js';
import { ChatPresence } from './presence.js';

export interface OrchestrationInput {
  readonly config: DaemonConfig;
  readonly composition: Composition;
  readonly execution: Execution;
  readonly mcp: McpAccess;
  readonly registries: Registries;
  readonly prompts: PromptSource;
  readonly paths: Pick<DataPaths, 'profiles' | 'worktrees' | 'channel' | 'scenarios'>;
  readonly handlers: OrchestrationHandlers;
  /** The handlers of `consult` and `read_attachment` (P12), bound here with the services. */
  readonly scenarioHandlers: ScenarioHandlers;
  /** The Producer channel holds its requests here until the reconciliation ends (P9, 5.21). */
  readonly gate?: Pick<RecoveryGate, 'wait'>;
}

/** The plays of the daemon, running: what `startDaemon` builds once the execution exists (P8). */
export interface Orchestration {
  readonly runner: PlayRunner;
  readonly channel: ProducerChannel;
  readonly scenarios: ScenarioService;
  readonly attachments: AttachmentService;
  readonly chatFlow: ChatFlow;
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
 * runner, the MCP handlers of the Director's tools, and the Producer channel `ot chat` uses.
 *
 * The runner is not asked to resume the plays the previous daemon left (`resumeAll`) here: the
 * reconciliation of the start-up (`recovery/reconcile.ts`, P9) calls it, once it has checked what
 * each play left behind.
 */
export async function startOrchestration(input: OrchestrationInput): Promise<Orchestration> {
  const { config, composition, execution, mcp, registries, prompts, paths, handlers } = input;
  const { scenarioHandlers } = input;
  const { store, logger } = composition;
  const dispatcher = new PromptDispatcher({
    store,
    order: config.prompt_queue.order,
    onError: (error, item) => {
      logger.error({ err: error, scenarioId: item?.scenarioId }, 'a prompt could not be delivered');
    },
  });
  const directors = new DirectorSessions({
    store,
    execution,
    mcp,
    dispatcher,
    prompts,
    registries,
    config,
    paths,
    logger,
    clock: composition.clock,
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
    mode: config.chat.presence,
    windowMs: config.chat.presence_window,
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
    config,
    paths,
    logger,
    attended: ({ scenarioId }) => presence.attended(scenarioId),
  });
  const runner = new PlayRunner({ store, clock: composition.clock, effects, logger });
  effects.bind(runner);
  const chatFlow = new ChatFlow({ store, logger });
  handlers.bind({ store, runner, workspace, directors, config, logger, chatFlow });
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
  const channel = new ProducerChannel({
    store,
    scenarios,
    attachments,
    directors,
    dispatcher,
    runner,
    board: handlers.board,
    logger,
    presence,
    confirmer,
    conventionsMode: () => config.project.conventions,
  });
  const server =
    config.chat.channel === 'off'
      ? undefined
      : await ProducerChannelServer.start({
          channel,
          port: 'auto',
          logger,
          ...(input.gate === undefined ? {} : { gate: input.gate }),
        });
  await server?.publish(paths.channel);

  let quiet: Promise<void> | undefined;
  return {
    runner,
    channel,
    scenarios,
    attachments,
    chatFlow,
    quiesce: () =>
      (quiet ??= (async () => {
        await server?.stop(paths.channel);
        handlers.board.abortAll('The daemon is stopping.');
        handlers.bind(undefined);
        scenarioHandlers.bind(undefined);
        effects.close();
        await runner.close();
        await directors.close();
      })()),
    drain: async () => {
      await effects.idle();
    },
  };
}
