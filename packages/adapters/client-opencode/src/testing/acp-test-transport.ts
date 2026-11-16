// SPDX-License-Identifier: MPL-2.0
// COPY, for the tests of this package only, of `AcpTransport` of `@otheater/adapter-session-acp`
// (same ACP calls, same order): the `adapter-isolation` rule forbids one adapter from importing
// another, and the conformance suites and the real tests need a transport that speaks ACP over
// the standard streams. When `AcpTransport` changes, change this copy too. It is not exported by
// the package.
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type ContentBlock as AcpContentBlock,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  AdapterUnavailable,
  InvalidInput,
  isOTheaterError,
  ManagedAgentSession,
  NotFound,
  typedErrorOf,
  type ConfigValue,
  type ContentBlock,
  type OTheaterError,
  type PermissionRequest,
  type SessionDriver,
  type SessionLoadParams,
  type SessionOpenParams,
  type SessionTransport,
  type SessionWarning,
  type StopReason,
} from '@otheater/core';

/** How long `initialize`, `session/new`, `session/load` and the config calls may take together. [proposta] */
export const DEFAULT_START_TIMEOUT_MS = 30_000;

/** ACP `resource not found`: the code a client answers `session/load` with for a conversation it does not have. */
const ACP_RESOURCE_NOT_FOUND = -32002;
/** JSON-RPC `invalid params`: what a client answers `session/set_config_option` with for an id or value it does not offer. */
const JSON_RPC_INVALID_PARAMS = -32602;

export interface AcpTestTransportOptions {
  /** Sent in `initialize` as `clientInfo`. Default `otheater`. */
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Limit for the handshake and the session setup; on expiry the open rejects with `AdapterUnavailable`. Default {@link DEFAULT_START_TIMEOUT_MS}. */
  readonly startTimeoutMs?: number;
  /** Wait after `session/cancel` before the process tree is killed anyway. See `ManagedSessionOptions`. */
  readonly cancelGraceMs?: number;
  readonly killGraceMs?: number;
  readonly onWarning?: (warning: AcpTestTransportWarning) => void;
}

/** Something the transport noticed and did not fail on. */
export type AcpTestTransportWarning =
  SessionWarning | { readonly kind: 'permission_handler_threw'; readonly error: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a stream to its end and drops what it carries: a client that writes logs must not block on a full pipe. */
function drain(stream: ReadableStream<Uint8Array>): void {
  stream.pipeTo(new WritableStream<Uint8Array>({ write: () => undefined })).catch(() => undefined);
}

function timeoutAfter(ms: number, message: string): { promise: Promise<never>; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AdapterUnavailable(message));
    }, ms);
  });
  return {
    promise,
    stop: () => {
      clearTimeout(timer);
    },
  };
}

/** The reduction of a `session/request_permission` to what the policy needs (architecture 5.8, layer 2). */
function permissionRequestOf(params: RequestPermissionRequest): PermissionRequest {
  const { toolCall } = params;
  return {
    toolCallId: toolCall.toolCallId,
    ...(typeof toolCall.title === 'string' ? { title: toolCall.title } : {}),
    ...(typeof toolCall.kind === 'string' ? { toolKind: toolCall.kind } : {}),
    options: params.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };
}

/**
 * A prompt block in ACP form. The core block carries the same fields; the only difference is that
 * an absent optional field may be `undefined` there and must not be on the wire.
 */
function acpContentOf(block: ContentBlock): AcpContentBlock {
  return Object.fromEntries(
    Object.entries(block).filter(([, value]) => value !== undefined),
  ) as unknown as AcpContentBlock;
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/** What one connection needs to know once the session exists, and what it needs before. */
interface Route {
  /** Known up front for `session/load`, learnt from the answer for `session/new`. */
  sessionId: string | undefined;
  /** Set once the session exists; updates before that (a `session/load` replays history) are dropped. */
  deliver: ((raw: unknown) => void) | undefined;
}

class AcpDriver implements SessionDriver {
  readonly #connection: ClientConnection;
  readonly #sessionId: string;

  constructor(connection: ClientConnection, sessionId: string) {
    this.#connection = connection;
    this.#sessionId = sessionId;
  }

  async runTurn(blocks: readonly ContentBlock[]): Promise<StopReason> {
    const prompt = blocks.map(acpContentOf);
    try {
      const response = await this.#connection.agent.request(methods.agent.session.prompt, {
        sessionId: this.#sessionId,
        prompt,
      });
      return response.stopReason;
    } catch (error) {
      throw this.#classified(error);
    }
  }

  async requestCancel(): Promise<void> {
    await this.#connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.#sessionId,
    });
  }

  async applyConfig(id: string, value: ConfigValue): Promise<void> {
    try {
      await this.#connection.agent.request(
        methods.agent.session.setConfigOption,
        typeof value === 'boolean'
          ? { sessionId: this.#sessionId, configId: id, type: 'boolean', value }
          : { sessionId: this.#sessionId, configId: id, value },
      );
    } catch (error) {
      if (error instanceof RequestError && error.code === JSON_RPC_INVALID_PARAMS) {
        throw new InvalidInput(
          `the client does not accept ${id}=${String(value)}: ${error.message}`,
          {
            cause: error,
          },
        );
      }
      throw this.#classified(error);
    }
  }

  disconnect(): void {
    this.#connection.close();
  }

  /** A closed connection is a client that is gone; an answer of the client goes up as it came, for the normalizer. */
  #classified(error: unknown): unknown {
    if (error instanceof RequestError || isOTheaterError(error)) return error;
    if (this.#connection.signal.aborted) {
      return new AdapterUnavailable('the connection to the client closed', { cause: error });
    }
    return error;
  }
}

/**
 * ACP over the standard streams of the client process: the `SessionTransport` with `id: 'acp'`
 * (architecture 5.2, "Casca de agente"). One connection per process, one session per connection.
 *
 * What it does, in order, for `open` and `load`:
 * 1. `initialize`, offering NO `fs` and NO `terminal` capability: the client does its own file work
 *    and runs its own shell, and the daemon answers neither (architecture 5.8, layers 1 and 3 hold
 *    the line, not a delegated tool). Any `fs/*` or `terminal/*` request gets `method not found`.
 * 2. `session/new` with the worktree, the HTTP MCP servers and the `_meta` of the setup, or
 *    `session/load` when the client announced `loadSession`.
 * 3. `session/set_config_option` for each config option of the setup.
 *
 * Then `session/update` goes through `normalizer.normalizeUpdate` to the listeners,
 * `session/request_permission` goes to `onPermission` (layer 2), a failure goes through
 * `normalizer.normalizeError` and comes out as the typed error, and `cancel` sends
 * `session/cancel` and, after a short grace period, ends the process tree. The contract of the
 * `AgentSession` itself lives in `ManagedAgentSession`, shared with every process-based transport.
 *
 * The transport never reads the environment and never starts a process: the `LaunchedProcess`
 * arrives already running, started by the `ClientAdapter` through the `ProcessLauncher`.
 */
export class AcpTestTransport implements SessionTransport {
  readonly id = 'acp';
  readonly #options: AcpTestTransportOptions;

  constructor(options: AcpTestTransportOptions = {}) {
    this.#options = options;
  }

  open(params: SessionOpenParams): Promise<ManagedAgentSession> {
    return this.#start(params, undefined);
  }

  load(params: SessionLoadParams): Promise<ManagedAgentSession> {
    return this.#start(params, params.sessionId);
  }

  async #start(
    params: SessionOpenParams,
    loadId: string | undefined,
  ): Promise<ManagedAgentSession> {
    if (params.setup.via !== 'acp') {
      throw new InvalidInput(`the acp transport needs an acp setup, got ${params.setup.via}`);
    }
    const { meta, configOptions } = params.setup;
    if (meta !== undefined && !isRecord(meta)) {
      throw new InvalidInput('the _meta of the session setup must be an object');
    }
    drain(params.process.stderr);
    const route: Route = { sessionId: loadId, deliver: undefined };
    const connection = this.#connect(params, route);
    const timeout = timeoutAfter(
      this.#options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      'the client did not finish starting the session in time',
    );
    try {
      const session = await Promise.race([
        this.#handshake(connection, params, route, loadId, meta, configOptions),
        timeout.promise,
      ]);
      return session;
    } catch (error) {
      connection.close();
      throw this.#typedStartError(error, connection, params, loadId !== undefined);
    } finally {
      timeout.stop();
    }
  }

  #connect(params: SessionOpenParams, route: Route): ClientConnection {
    const options = this.#options;
    const app = client({ name: options.clientName ?? 'otheater' })
      .onRequest(methods.client.session.requestPermission, ({ params: request }) => {
        if (route.sessionId !== undefined && request.sessionId !== route.sessionId) {
          return CANCELLED;
        }
        try {
          const answer = params.onPermission(permissionRequestOf(request));
          return answer.outcome === 'selected'
            ? { outcome: { outcome: 'selected' as const, optionId: answer.optionId } }
            : CANCELLED;
        } catch (error) {
          // A handler that breaks must not leave a tool allowed: refuse, and say so.
          options.onWarning?.({ kind: 'permission_handler_threw', error });
          return CANCELLED;
        }
      })
      .onNotification(methods.client.session.update, ({ params: notification }) => {
        if (route.sessionId !== undefined && notification.sessionId !== route.sessionId) return;
        route.deliver?.(notification.update);
      });
    return app.connect(ndJsonStream(params.process.stdin, params.process.stdout));
  }

  async #handshake(
    connection: ClientConnection,
    params: SessionOpenParams,
    route: Route,
    loadId: string | undefined,
    meta: unknown,
    configOptions: Readonly<Record<string, string>>,
  ): Promise<ManagedAgentSession> {
    const options = this.#options;
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      // Explicitly nothing: no file system and no terminal for the client to call back into.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: {
        name: options.clientName ?? 'otheater',
        version: options.clientVersion ?? '0.0.0',
      },
    });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new AdapterUnavailable(
        `the client speaks ACP version ${String(initialized.protocolVersion)}, this transport speaks ${String(PROTOCOL_VERSION)}`,
      );
    }
    const canLoad = initialized.agentCapabilities?.loadSession === true;
    const mcpServers = this.#mcpServers(
      params,
      initialized.agentCapabilities?.mcpCapabilities?.http,
    );
    const metaField = meta === undefined ? {} : { _meta: meta as Record<string, unknown> };

    let sessionId: string;
    if (loadId === undefined) {
      const created = await connection.agent.request(methods.agent.session.new, {
        cwd: params.cwd,
        mcpServers,
        ...metaField,
      });
      sessionId = created.sessionId;
      route.sessionId = sessionId;
    } else {
      if (!canLoad) {
        throw new AdapterUnavailable('the client did not announce loadSession');
      }
      sessionId = loadId;
      await connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: params.cwd,
        mcpServers,
        ...metaField,
      });
    }

    const session = new ManagedAgentSession({
      sessionId,
      canLoad,
      driver: new AcpDriver(connection, sessionId),
      process: params.process,
      normalizer: params.normalizer,
      ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    });
    for (const [configId, value] of Object.entries(configOptions)) {
      await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId,
        value,
      });
    }
    // From here on the updates reach the session (and, through it, the listeners).
    route.deliver = (raw) => {
      session.deliver(raw);
    };
    return session;
  }

  /** The HTTP MCP servers of the role, in ACP form; refuses what the client said it cannot take. */
  #mcpServers(params: SessionOpenParams, http: boolean | null | undefined): McpServer[] {
    if (params.mcpServers.length === 0) return [];
    if (http !== true) {
      throw new AdapterUnavailable(
        'the role names MCP servers and the client did not announce HTTP MCP support',
      );
    }
    return params.mcpServers.map((server) => ({
      type: 'http' as const,
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
    }));
  }

  #typedStartError(
    error: unknown,
    connection: ClientConnection,
    params: SessionOpenParams,
    loading: boolean,
  ): OTheaterError {
    if (isOTheaterError(error)) return error;
    if (error instanceof RequestError) {
      if (loading && error.code === ACP_RESOURCE_NOT_FOUND) {
        return new NotFound(`the client has no such conversation: ${error.message}`, {
          cause: error,
        });
      }
      try {
        return typedErrorOf(params.normalizer.normalizeError(error));
      } catch (cause) {
        return new AdapterUnavailable('the client failed and its error could not be normalized', {
          cause,
        });
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    return new AdapterUnavailable(
      connection.signal.aborted
        ? 'the connection to the client closed before the session was ready'
        : `the client session could not be started: ${reason}`,
      { cause: error },
    );
  }
}
