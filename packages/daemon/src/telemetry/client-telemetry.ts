// SPDX-License-Identifier: MPL-2.0
import type { ClientOtel } from '@otheater/core';
import type { Logger } from '../logger.js';
import type { TelemetrySessionEntry, TelemetrySessions } from './sessions.js';

/**
 * What the daemon tells a client about where to send its telemetry (Phase 8, P2 and P3, N211 to
 * N213; architecture 5.11): the `ClientOtel` of each session, built from the address and the token
 * of the receiver, the `telemetry.*` configuration and the ids of the work the session is for.
 *
 * [proposta] Two resources per session, because the clients differ in how much a process can say:
 * - the **session** resource (`sessionOtel`) carries every id (`otheater.play_id`, `.stage_id`,
 *   `.attempt_id`, `.scenario_id`, `.profile`, `.client`). It is what a client that starts a
 *   process for each session (Claude Code) exports with, and what the adapter of a shared client
 *   reads for its session-level setup (Codex names its title from it);
 * - the **process** resource (`processOtel`) carries only what is stable for the whole life of a
 *   process (`otheater.profile`, `otheater.client`). It is what `launchSpec` gets for a client that
 *   serves many sessions in one process (Codex, OpenCode). The environment of a process is part of
 *   its pool key (`sharedProcessKey`), so a per-attempt resource there would give each attempt its
 *   own process and defeat `sessions_per_process`. The records of such a client are tied to an
 *   attempt by the session id they carry, through the table of open sessions.
 * `otheater.session_id` is in neither: the session id is assigned by the client at `session/new`,
 * after the process was launched, so it is not known when the resource is built.
 */

/** The ids of the work a session is opened for; everything is optional (a direct session has none). */
export interface TelemetryContext {
  readonly scenarioId?: string | undefined;
  readonly playId?: string | undefined;
  /** The stage the attempt runs for: the `stage-<name>` demand of its play. */
  readonly stageId?: string | undefined;
  readonly attemptId?: string | undefined;
}

/** What the pool needs from the telemetry of a session: the two `ClientOtel` and the table entry. */
export interface PreparedTelemetry {
  /** For `launchSpec` of a shared process: stable resource only. */
  readonly process: ClientOtel;
  /** For `openSession`/`openSessionOn` (`options.otel`): the full resource. */
  readonly session: ClientOtel;
  readonly entry: Omit<TelemetrySessionEntry, 'sessionId'>;
}

/** The part of {@link ClientTelemetry} the session pool uses (an interface, so a test can fake it). */
export interface SessionTelemetry {
  /** Never throws: a session is opened with no telemetry rather than not opened. */
  prepare(
    client: string,
    profileId: string,
    context: TelemetryContext | undefined,
  ): Promise<PreparedTelemetry | undefined>;
  /** The session exists: its records can be tied to the work from now on. */
  opened(sessionId: string, prepared: PreparedTelemetry): void;
  /** The session ended (its records still arrive for a while). */
  closed(sessionId: string): void;
}

/** What `telemetry.clients.<client>` says, for the clients that have a key. */
export interface ClientTelemetrySwitches {
  readonly clients: Readonly<
    Record<string, { readonly enabled: 'on' | 'off' } & Readonly<Record<string, unknown>>>
  >;
}

export interface ClientTelemetryOptions {
  /** `TelemetryReceiver.url` and `.token`. */
  readonly endpoint: string;
  readonly token: string;
  /** `config.telemetry` (only `clients` is read). */
  readonly config: ClientTelemetrySwitches;
  readonly sessions: TelemetrySessions;
  readonly logger?: Pick<Logger, 'warn'>;
  /** The scenario of a play, when the caller did not say it. A failure is the same as `null`. */
  readonly scenarioOf?: (playId: string) => Promise<string | null | undefined>;
  /**
   * Extra resource attributes for the session resource, by context. The daemon connects
   * `traceResourceExtras` (`reparent.ts`, Phase 9, P1) here: it adds `otheater.trace_id`, the trace
   * the receiver puts the client's spans in. Same limits as the rest of the resource: no `,`, `=`,
   * space or control character. Default: none.
   */
  readonly resourceExtras?: (client: string, context: TelemetryContext) => Record<string, string>;
}

/** What `OTEL_RESOURCE_ATTRIBUTES` can carry (the check `otelResourceAttributes` makes, without the throw). */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CARRIABLE = /^[^,=\s\u0000-\u001f\u007f]+$/u;

export class ClientTelemetry implements SessionTelemetry {
  readonly #options: ClientTelemetryOptions;
  readonly #warned = new Set<string>();

  constructor(options: ClientTelemetryOptions) {
    this.#options = options;
  }

  /** `telemetry.clients.<client>` is `off`: that client sends nothing. A client with no key sends. */
  enabled(client: string): boolean {
    return this.#options.config.clients[client]?.enabled !== 'off';
  }

  async prepare(
    client: string,
    profileId: string,
    context: TelemetryContext | undefined,
  ): Promise<PreparedTelemetry | undefined> {
    if (!this.enabled(client)) return undefined;
    try {
      let scenarioId = context?.scenarioId ?? null;
      if (scenarioId === null && context?.playId !== undefined && this.#options.scenarioOf) {
        scenarioId = (await this.#options.scenarioOf(context.playId).catch(() => null)) ?? null;
      }
      const stable = { 'otheater.client': client, 'otheater.profile': profileId };
      const ids: Record<string, string | undefined> = {
        'otheater.scenario_id': scenarioId ?? undefined,
        'otheater.play_id': context?.playId,
        'otheater.stage_id': context?.stageId,
        'otheater.attempt_id': context?.attemptId,
        ...this.#options.resourceExtras?.(client, context ?? {}),
      };
      return {
        process: this.#otel(client, this.#carriable(stable)),
        session: this.#otel(client, this.#carriable({ ...stable, ...ids })),
        entry: {
          client,
          profile: profileId,
          scenarioId,
          playId: context?.playId ?? null,
          stageId: context?.stageId ?? null,
          attemptId: context?.attemptId ?? null,
        },
      };
    } catch (error) {
      this.#options.logger?.warn(
        { client, err: error instanceof Error ? error.message : String(error) },
        'telemetry for a session could not be prepared; it starts without',
      );
      return undefined;
    }
  }

  opened(sessionId: string, prepared: PreparedTelemetry): void {
    this.#options.sessions.open({ ...prepared.entry, sessionId });
  }

  closed(sessionId: string): void {
    this.#options.sessions.close(sessionId);
  }

  #otel(client: string, resource: Record<string, string>): ClientOtel {
    const { config } = this.#options;
    const own = config.clients[client];
    return {
      endpoint: this.#options.endpoint,
      headers: { Authorization: `Bearer ${this.#options.token}` },
      resource,
      traces: client === 'claude-code' && own?.traces === 'on',
      ...(client === 'claude-code' && typeof own?.metrics_interval === 'number'
        ? { metricsIntervalMs: own.metrics_interval }
        : {}),
      experimental: client === 'opencode' && own?.ai_spans === 'on',
    };
  }

  /** Drops what the resource format cannot carry (and says so once per name), never throws. */
  #carriable(attributes: Readonly<Record<string, string | undefined>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined) continue;
      if (CARRIABLE.test(key) && CARRIABLE.test(value)) {
        out[key] = value;
      } else if (!this.#warned.has(key)) {
        this.#warned.add(key);
        this.#options.logger?.warn(
          { attribute: key },
          'a telemetry resource attribute cannot be carried by OTEL_RESOURCE_ATTRIBUTES and was left out',
        );
      }
    }
    return out;
  }
}
