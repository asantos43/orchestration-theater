// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import {
  type Clock,
  type CodeHost,
  type PathHost,
  type ProcessLauncher,
  ShellToolRefusal,
  type Store,
  type Vcs,
} from '@otheater/core';
import { buildDaemonEvent, type ToolOutcome } from '@otheater/protocol';
import { buildClientEnv } from '../clients.js';
import type { ToolsConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { CommandConfiner } from '../sandbox-wiring.js';
import { ToolFailure, type ToolCall } from '../mcp/handlers.js';
import type { Env } from '../paths.js';
import { Semaphore } from './semaphore.js';
import { resolveToolSettings, type ToolSettings } from './settings.js';

/** What the work tools need of the daemon (architecture 5.8). */
export interface ToolsDeps {
  readonly store: Pick<Store, 'attempts' | 'plays' | 'scenarios' | 'sideEffects'>;
  /** The global `tools` block; a project and a scenario override it per call. */
  readonly config: ToolsConfig;
  /** `undefined` on a platform with no launcher: the command tools then answer `unavailable`. */
  readonly launcher: ProcessLauncher | undefined;
  readonly vcs: Vcs;
  readonly codeHost?: CodeHost | undefined;
  /**
   * Layer 3 for the commands (P4): runs the launch of a command inside the sandbox. `undefined`
   * when the sandbox is off or there is none (the command then runs as before).
   */
  readonly confine?: CommandConfiner | undefined;
  readonly clock: Clock;
  /** The environment the commands inherit from (`tools.env_inherit`): `process.env`, in the daemon. */
  readonly env: Env;
  readonly host: PathHost;
  readonly logger?: Logger | undefined;
  /** `fetch` of `http_get`; the global one by default. A test hands in a double. */
  readonly fetch?: typeof fetch | undefined;
}

/** A refusal by the rules of the tool (argv, path, domain): nothing ran. Outcome `refused`. */
export class ToolRefusal extends ToolFailure {
  override name = 'ToolRefusal';
}

/** A call that ran out of time (an HTTP request): outcome `timed_out`. */
export class ToolTimeout extends ToolFailure {
  override name = 'ToolTimeout';
}

/** What a tool body hands back: the reply and what to say about it in `tool.finished`. */
export interface ToolDone {
  readonly reply: unknown;
  readonly outcome: ToolOutcome;
  readonly exitCode?: number | null;
  readonly outputBytes?: number;
  readonly truncated?: boolean;
}

/** The state the six tools share: the semaphores of the heavy commands. */
export class ToolsContext {
  readonly deps: ToolsDeps;
  readonly #global: Semaphore;
  readonly #byScenario = new Map<string, Semaphore>();

  constructor(deps: ToolsDeps) {
    this.deps = deps;
    this.#global = new Semaphore(deps.config.heavy_concurrency);
  }

  /**
   * The semaphore of a call: the shared one, unless the scenario asks for another limit than the
   * global one, in which case the scenario has a pool of its own (its commands do not wait for
   * those of other scenarios, nor the reverse). [proposta]
   */
  semaphoreOf(settings: ToolSettings): Semaphore {
    const wanted = settings.config.heavy_concurrency;
    if (settings.scenarioId === undefined || wanted === this.#global.limit) return this.#global;
    let own = this.#byScenario.get(settings.scenarioId);
    if (own === undefined) {
      own = new Semaphore(wanted);
      this.#byScenario.set(settings.scenarioId, own);
    } else if (own.limit !== wanted) {
      own.setLimit(wanted);
    }
    return own;
  }

  /** The environment of a command: `tools.env_inherit` and `tools.env_allow` over the daemon's. */
  commandEnv(): Readonly<Record<string, string>> {
    const { env_inherit, env_allow } = this.deps.config;
    return buildClientEnv({ env_inherit, env_allow, env: {} }, this.deps.env);
  }

  /**
   * Runs the body of one tool call inside its two events: `tool.called` (the call passed the
   * checks), then, if the tool is heavy, the wait for the semaphore, the body, and `tool.finished`
   * with the outcome. A refusal or a failure of the tool is rethrown after the event. Failing to
   * write an event is logged and does not fail the call (the journal is a record, not a gate).
   */
  async track(
    call: ToolCall,
    summary: string,
    body: (settings: ToolSettings) => Promise<ToolDone>,
  ): Promise<unknown> {
    const { clock } = this.deps;
    const { caller } = call;
    const callId = randomUUID();
    const correlation = caller.correlation;
    const tool = call.tool.name;

    let settings: ToolSettings | undefined;
    let setupError: unknown;
    try {
      settings = await resolveToolSettings(
        this.deps.config,
        this.deps.store,
        caller.attemptId,
        correlation.playId,
      );
    } catch (error) {
      setupError = error;
    }
    const heavy =
      (settings?.config.heavy_commands as readonly string[] | undefined)?.includes(tool) ?? false;
    await this.#emit(
      call,
      buildDaemonEvent('tool.called', {
        tool,
        role: caller.role,
        callId,
        summary: summary.length > 500 ? `${summary.slice(0, 497)}...` : summary,
        heavy,
        ...correlation,
      }),
    );

    let queuedMs = 0;
    let startedAt = clock.now();
    let release: (() => void) | undefined;
    const finish = async (
      fields: Partial<Pick<ToolDone, 'exitCode' | 'outputBytes' | 'truncated'>> & {
        outcome: ToolOutcome;
        errorCode?: string;
      },
    ): Promise<void> => {
      await this.#emit(
        call,
        buildDaemonEvent('tool.finished', {
          tool,
          role: caller.role,
          callId,
          durationMs: Math.max(0, clock.now() - startedAt),
          queuedMs,
          ...fields,
          ...correlation,
        }),
      );
    };

    try {
      if (settings === undefined) throw setupError;
      if (heavy) {
        const requested = clock.now();
        release = await this.semaphoreOf(settings).acquire();
        queuedMs = Math.max(0, clock.now() - requested);
      }
      startedAt = clock.now();
      const done = await body(settings);
      await finish({
        outcome: done.outcome,
        ...(done.exitCode === undefined ? {} : { exitCode: done.exitCode }),
        ...(done.outputBytes === undefined ? {} : { outputBytes: done.outputBytes }),
        ...(done.truncated === undefined ? {} : { truncated: done.truncated }),
      });
      return done.reply;
    } catch (error) {
      const refusal = error instanceof ShellToolRefusal ? error : undefined;
      if (refusal !== undefined) {
        await finish({ outcome: 'refused', errorCode: refusal.reason });
        throw new ToolRefusal(refusal.reason, refusal.message);
      }
      if (error instanceof ToolRefusal) {
        await finish({ outcome: 'refused', errorCode: error.code });
      } else if (error instanceof ToolTimeout) {
        await finish({ outcome: 'timed_out', errorCode: error.code });
      } else if (error instanceof ToolFailure) {
        await finish({ outcome: 'error', errorCode: error.code });
      } else {
        await finish({ outcome: 'error', errorCode: 'internal_error' });
      }
      throw error;
    } finally {
      release?.();
    }
  }

  async #emit(call: ToolCall, event: ReturnType<typeof buildDaemonEvent>): Promise<void> {
    try {
      await call.caller.record(event);
    } catch (error) {
      this.deps.logger?.warn({ err: error, tool: call.tool.name }, 'could not record a tool event');
    }
  }
}
