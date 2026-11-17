// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, NotFound, type JsonObject, type Store } from '@otheater/core';
import type { DaemonConfig } from '../config.js';
import { ToolFailure, type ToolCall, type ToolHandlers } from '../mcp/handlers.js';
import type { DirectorSessions } from '../orchestration/director.js';
import { executorOf } from '../orchestration/roles.js';
import { type AttachmentService, isImage } from './attachments.js';
import { acceptsImages, type AdapterDirectory, type ConsultService } from './consult.js';

/** The tools of the scenarios this module answers (P12). */
export const SCENARIO_TOOL_NAMES = ['consult', 'read_attachment'] as const;

/** What the handlers need once the daemon has composed everything (they are registered earlier). */
export interface ScenarioRuntime {
  readonly store: Store;
  readonly directors: Pick<DirectorSessions, 'scenarioOf'>;
  readonly attachments: AttachmentService;
  readonly consult: ConsultService;
  readonly adapters: AdapterDirectory;
  readonly config: DaemonConfig;
}

/**
 * The handlers of `consult` (the Director's tool that opens a Consultant) and `read_attachment`
 * (any role reads an attachment `A<n>` of its scenario). Like the handlers of the play, they are
 * registered before the MCP server starts and the runtime is bound when the daemon is composed.
 *
 * A caller is tied to a scenario by its Director session, or, for the Consultant (an attempt whose
 * play id is the scenario id), by its correlation. [proposta] An image is handed only to a caller
 * whose client declares `capabilities.inputTypes` with `image`; anyone else gets
 * `image_not_supported`. (The registry gives `read_attachment` to the Executor roles only: the
 * Director hands an attachment to a Consultant with `consult`.)
 */
export class ScenarioHandlers {
  #runtime: ScenarioRuntime | undefined;

  bind(runtime: ScenarioRuntime | undefined): void {
    this.#runtime = runtime;
  }

  /** Registers the handlers, skipping a name that already has one. */
  register(handlers: ToolHandlers): ToolHandlers {
    const mine: Record<(typeof SCENARIO_TOOL_NAMES)[number], (call: ToolCall) => unknown> = {
      consult: (call) => this.#consult(call),
      read_attachment: (call) => this.#read(call),
    };
    for (const [name, handler] of Object.entries(mine)) {
      if (!handlers.has(name)) handlers.register(name, handler);
    }
    return handlers;
  }

  async #consult(call: ToolCall): Promise<JsonObject | ToolFailure> {
    const runtime = this.#runtime;
    if (runtime === undefined) return notReady();
    const scenarioId = runtime.directors.scenarioOf(call.caller.attemptId);
    if (scenarioId === undefined) {
      return new ToolFailure('no_scenario', 'consult is a tool of the Director of a scenario.');
    }
    const input = call.input as {
      question: string;
      attachments?: string[];
      reason?: string;
    };
    return runtime.consult.consult(scenarioId, input);
  }

  async #read(call: ToolCall): Promise<JsonObject | ToolFailure> {
    const runtime = this.#runtime;
    if (runtime === undefined) return notReady();
    const { id } = call.input as { id: string };
    const scenarioId = await this.#scenarioOf(runtime, call);
    if (scenarioId === undefined) {
      return new ToolFailure(
        'no_scenario',
        'This session has no scenario to read attachments from.',
      );
    }
    try {
      const record = await runtime.attachments.get(scenarioId, id);
      if (isImage(record.mime)) {
        const client = await this.#clientOf(runtime, call);
        if (client === undefined || !acceptsImages(runtime.adapters, client)) {
          return new ToolFailure(
            'image_not_supported',
            `${id} is an image and the Executor of this session does not accept images.`,
          );
        }
      }
      return { ...(await runtime.attachments.read(record)) };
    } catch (error) {
      if (error instanceof NotFound) return new ToolFailure('not_found', error.message);
      if (error instanceof InvalidInput) return new ToolFailure('too_large', error.message);
      throw error;
    }
  }

  async #scenarioOf(runtime: ScenarioRuntime, call: ToolCall): Promise<string | undefined> {
    const direct = runtime.directors.scenarioOf(call.caller.attemptId);
    if (direct !== undefined) return direct;
    const { playId } = call.caller.correlation;
    if (playId === undefined) return undefined;
    // The attempts of a consultation use the scenario id as their play id.
    if ((await runtime.store.scenarios.get(playId)) !== undefined) return playId;
    return (await runtime.store.plays.get(playId))?.scenarioId;
  }

  async #clientOf(runtime: ScenarioRuntime, call: ToolCall): Promise<string | undefined> {
    const attempt = await runtime.store.attempts.get(call.caller.attemptId);
    if (attempt !== undefined) return attempt.client;
    return executorOf(runtime.config, call.caller.role)?.client;
  }
}

function notReady(): ToolFailure {
  return new ToolFailure(
    'not_ready',
    'The daemon is still starting (or already stopping): try again in a moment.',
  );
}
