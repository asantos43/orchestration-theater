// SPDX-License-Identifier: MPL-2.0
import { rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer, serve } from '@hono/node-server';
import {
  AdapterUnavailable,
  askProducerInput,
  type Registries,
  type ToolDefinition,
} from '@otheater/core';
import { buildDaemonEvent } from '@otheater/protocol';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  originValidationResponse,
  type AuthInfo,
  type CallToolResult,
  type McpHttpHandler,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import type { AskApproval } from '../browser/approval.js';
import type { Logger } from '../logger.js';
import { approvalDetailOf, askProducerToApprove } from '../plugins/approval.js';
import type { PluginAggregator, PluginSnapshot, PluginToolBinding } from '../plugins/aggregate.js';
import {
  allowedPluginTools,
  approvalOf,
  DEFAULT_PLUGIN_PERMISSIONS,
  type PluginPermissionSettings,
} from '../plugins/permissions.js';
import type { PluginNotice, PluginNoticeSink } from '../plugins/runtime-config.js';
import type { RecoveryGate } from '../recovery/gate.js';
import { resolveSelfCommand } from '../sea/self-command.js';
import type { McpAccess, McpGrant, McpGrantInput, PluginToolsQuery } from './access.js';
import { producerQuestionErrors, type ProducerQuestionMode } from './ask-producer.js';
import { notImplemented, ToolFailure, ToolHandlers, ToolWithImage } from './handlers.js';
import { describeIssues, isSubmitTool, runSubmit, type ToolReply } from './submit.js';
import { SHIM_AUTHORIZATION_ENV, SHIM_SOCKET_ENV, STDIO_SHIM_PATH } from './stdio-shim.js';
import { bearerToken, GrantBook, type GrantRecord } from './tokens.js';

/** The only path of the server; everything else is a 404. */
export const MCP_PATH = '/mcp';

/** Address the server listens on: the loopback only, never another interface (5.3). */
export const MCP_HOST = '127.0.0.1';

export interface FrameworkMcpOptions {
  /** The tools come from here: the server lists, per role, what the tool registry says. */
  readonly registries: Pick<Registries, 'tools'>;
  /** `'auto'` takes a free port at each start; a number is that port (`mcp.port`, N81). */
  readonly port: 'auto' | number;
  /** `limits.submit_retries` (N79). */
  readonly submitRetries: number;
  /** What runs when a tool is called; `submit*` is built in. Default: none registered. */
  readonly handlers?: ToolHandlers;
  /** `chat.producer_questions`; default `choices` (5.3). */
  readonly producerQuestions?: ProducerQuestionMode;
  readonly logger: Logger;
  readonly version: string;
  /** Calls wait here while the reconciliation of the start-up runs (5.21). Default: no wait. */
  readonly gate?: Pick<RecoveryGate, 'wait'>;
  /**
   * A Unix socket to listen on too, absolute (N161, `sandbox.mcp_bridge: unix`). Each grant then
   * carries the stdio shim that a confined client starts to reach the server through it. The folder
   * must exist; a file already at the path is removed first. Default: no socket.
   */
  readonly socketPath?: string;
  /**
   * The tools of the plugins active in the project of the session, added under `<id>__<tool>`
   * (N234, Phase 9 P5). Without it the server has the framework tools only.
   */
  readonly plugins?: PluginAggregator;
  /**
   * The project of a grant that does not carry one (`McpGrantInput.project`): the daemon answers
   * from the play of the attempt. `undefined` means no project, so no plugin tool.
   */
  readonly projectOf?: (
    input: Pick<McpGrantInput, 'correlation' | 'project'>,
  ) => Promise<string | undefined>;
  /**
   * `plugins.permissions` (P6): what the effects of a plugin tool need of the policy of the role,
   * and whether `external_write` asks the Producer. A getter, so a change of the configuration
   * holds at the next call. Default: `DEFAULT_PLUGIN_PERMISSIONS`.
   */
  readonly pluginPermissions?: () => PluginPermissionSettings;
  /**
   * The card of the approval of a plugin tool (`requires_producer_approval`, or `external_write`
   * under `plugins.permissions.external_write_approval: ask`): the same path of the other tools that
   * ask the Producer (`OrchestrationHandlers.openApproval`, the chat prompt queue). Without it a
   * tool that needs approval is refused: nobody can be asked, never a yes.
   */
  readonly askApproval?: AskApproval;
  /** Where the notices of a plugin tool the permissions refused go besides the log (P8 binds it). */
  readonly onPluginNotice?: PluginNoticeSink;
  /**
   * The tools of the registry the server leaves out of every listing (P13 of Phase 11b: the notes
   * board under `collab.notes.mode: off`). A getter, read at each session, so a change of the
   * configuration holds for the sessions opened after it. A hidden tool that is called anyway
   * still reaches its handler, which refuses it.
   */
  readonly hiddenTools?: () => ReadonlySet<string>;
  /**
   * The messages of the Director's supervision (P14 of Phase 11b) waiting for an Actor attempt:
   * called after each tool call of an Actor (not a `submit*`), it returns the text blocks to add
   * to the reply, already marked as the Director's, and marks them delivered. [proposta] A failure
   * only loses the attachment; the reply of the tool goes on untouched.
   */
  readonly notices?: (context: {
    readonly attemptId: string;
    readonly playId: string;
    readonly demandId: string;
  }) => Promise<readonly string[]>;
}

/**
 * The schema the SDK sees for a tool: it lists the real JSON schema of the zod schema (what the
 * Executor reads in `tools/list`) and accepts any value when a call comes in. The validation is
 * ours, in `FrameworkMcpServer.#call`, because a `submit*` the SDK refused would never reach the
 * counter of `limits.submit_retries`.
 */
function deferred(schema: ToolDefinition['input']): StandardSchemaWithJSON {
  return {
    '~standard': {
      version: 1,
      vendor: 'otheater',
      validate: (value: unknown) => ({ value }),
      jsonSchema: schema['~standard'].jsonSchema,
    },
  };
}

function describe(tool: ToolDefinition): string {
  if (isSubmitTool(tool.name)) {
    return (
      `Deliver the output of your role (${tool.name}). The output is validated; if it is invalid ` +
      'the errors come back and you may fix it and call again, a limited number of times.'
    );
  }
  if (tool.name === 'ask_producer') {
    return (
      'Ask the Producer 1 to 4 questions at once, each with 2 to 4 options (label and description) ' +
      'and the recommended one. Mark "open" for a question that does not fit options. The interface ' +
      'adds "Other" with free text by itself.'
    );
  }
  return `OTheater framework tool ${tool.name}.`;
}

function isRevoked(record: GrantRecord): boolean {
  return record.revoked;
}

function asResult(reply: ToolReply): CallToolResult {
  const { value } = reply;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const structured =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return {
    content: [
      { type: 'text', text },
      ...(reply.image === undefined
        ? []
        : [{ type: 'image' as const, data: reply.image.data, mimeType: reply.image.mimeType }]),
    ],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    ...(reply.ok ? {} : { isError: true }),
  };
}

/**
 * The schema the SDK sees for a tool of a plugin: the JSON Schema of the server of the plugin,
 * and no validation here, because the server validates its own arguments (N233).
 */
function pluginSchema(schema: Record<string, unknown>): StandardSchemaWithJSON {
  return {
    '~standard': {
      version: 1,
      vendor: 'otheater',
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

function rejected(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}

/** The same app on a Unix socket (N161): the stdio shim of a confined client posts here. */
function listenUnix(
  fetch: (request: Request) => Response | Promise<Response>,
  socketPath: string,
): Promise<HttpServer> {
  // A socket left by a daemon that died would make the listen fail with EADDRINUSE.
  rmSync(socketPath, { force: true });
  const server = createAdaptorServer({ fetch }) as HttpServer;
  return new Promise<HttpServer>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(
        new AdapterUnavailable(
          `The MCP server could not listen on the socket ${socketPath}: ${error.message}`,
        ),
      );
    };
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

/**
 * The framework MCP server (architecture 5.3): the tools of each role, over Streamable HTTP, on
 * `127.0.0.1` only. It lives and dies with the daemon.
 *
 * - With `socketPath` (N161, macOS) the same app also listens on a Unix socket, and each grant
 *   carries the stdio shim (`stdio-shim.ts`) that a client confined by Seatbelt starts to reach the
 *   server through the socket: Seatbelt refuses it the loopback of the host. The checks below are
 *   the same on both ways; the shim sends `Host: 127.0.0.1`.
 * - Host and Origin are checked against localhost before anything else (DNS rebinding).
 * - Every call carries `Authorization: Bearer <token>`; the token is one session of one attempt
 *   and is bound to its role (`GrantBook`). Without a valid token the answer is 401.
 * - The factory of the SDK registers only the tools the role of the token sees, taken from the
 *   tool registry. A tool of another role is not there to be called.
 * - The mode is the SDK's stateless one: each request gets a new server from the factory, so
 *   nothing of a session lives in the server. [proposta] The state that matters (the token and the
 *   counters of `submit*`) lives in the `GrantBook`, which the daemon owns.
 */
export class FrameworkMcpServer implements McpAccess {
  readonly #options: FrameworkMcpOptions;
  readonly #handlers: ToolHandlers;
  readonly #book: GrantBook;
  readonly #http: HttpServer;
  readonly #unix: HttpServer | undefined;
  readonly #mcp: McpHttpHandler;
  /** The plugins a grant sees, taken at its first request and kept for its life. */
  readonly #snapshots = new WeakMap<McpGrantInput, Promise<PluginSnapshot | undefined>>();
  #url: string;
  #stopped: Promise<void> | undefined;

  private constructor(
    options: FrameworkMcpOptions,
    http: HttpServer,
    port: number,
    unix: HttpServer | undefined,
  ) {
    this.#options = options;
    this.#handlers = options.handlers ?? new ToolHandlers();
    this.#http = http;
    this.#unix = unix;
    this.#url = `http://${MCP_HOST}:${String(port)}${MCP_PATH}`;
    const socketPath = unix === undefined ? undefined : options.socketPath;
    this.#book = new GrantBook(
      () => this.#url,
      socketPath === undefined
        ? undefined
        : (authorization) => {
            // Node plus the shim script in a checkout, the executable plus its `mcp-shim` mode in
            // the single one (Phase 10, P1).
            const self = resolveSelfCommand('mcp-shim') ?? {
              command: process.execPath,
              args: [STDIO_SHIM_PATH],
            };
            return {
              command: self.command,
              args: [...self.args],
              env: { [SHIM_SOCKET_ENV]: socketPath, [SHIM_AUTHORIZATION_ENV]: authorization },
            };
          },
    );
    this.#mcp = this.#createHandler();
  }

  /**
   * Starts listening. With `port: 'auto'` the system gives a free port, different at each start;
   * `url` carries the one it got. A fixed port that is taken rejects with `AdapterUnavailable`.
   */
  static async start(options: FrameworkMcpOptions): Promise<FrameworkMcpServer> {
    const app = new Hono();
    // Filled in below: the routes need the instance, which needs the listening server.
    const ready: { server?: FrameworkMcpServer } = {};
    app.all(MCP_PATH, (c) => {
      if (ready.server === undefined) return Promise.resolve(rejected(503, 'starting'));
      return ready.server.#serve(c.req.raw);
    });
    const http = await new Promise<HttpServer>((resolve, reject) => {
      const server = serve(
        {
          fetch: app.fetch,
          hostname: MCP_HOST,
          port: options.port === 'auto' ? 0 : options.port,
        },
        () => {
          server.off('error', onError);
          resolve(server);
        },
      ) as HttpServer;
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(
          new AdapterUnavailable(
            error.code === 'EADDRINUSE'
              ? `The MCP port ${String(options.port)} is already in use (mcp.port); pick another or use "auto".`
              : `The MCP server could not listen on ${MCP_HOST}: ${error.message}`,
          ),
        );
      };
      server.once('error', onError);
    });
    const address = http.address() as AddressInfo;
    let unix: HttpServer | undefined;
    if (options.socketPath !== undefined) {
      try {
        unix = await listenUnix(app.fetch, options.socketPath);
      } catch (error) {
        await closeServer(http);
        throw error;
      }
    }
    const current = new FrameworkMcpServer(options, http, address.port, unix);
    ready.server = current;
    options.logger.info(
      { url: current.url, ...(unix === undefined ? {} : { socket: options.socketPath }) },
      'MCP framework server listening',
    );
    return current;
  }

  get url(): string {
    return this.#url;
  }

  /** The Unix socket the server also listens on; `undefined` without one (N161). */
  get socketPath(): string | undefined {
    return this.#unix === undefined ? undefined : this.#options.socketPath;
  }

  /** The grants alive now (tests and the daemon status read it). */
  get grants(): number {
    return this.#book.size;
  }

  grant(input: McpGrantInput): McpGrant {
    return this.#book.grant(input);
  }

  /**
   * The plugin tools the role may call under its policy (P6): the project's active plugins, the
   * roles of each manifest, then the effects against the policy (`plugins/permissions.ts`). A
   * failure here costs the plugin tools, never the framework ones.
   */
  async pluginTools(query: PluginToolsQuery): Promise<readonly string[]> {
    const plugins = this.#options.plugins;
    if (plugins === undefined) return [];
    try {
      const project = query.project ?? (await this.#options.projectOf?.(query));
      if (project === undefined) return [];
      return allowedPluginTools(
        plugins.snapshot(project).names,
        query.role,
        query.policy,
        this.#permissions(),
      );
    } catch (error) {
      this.#options.logger.warn({ err: error }, 'plugin tool permissions could not be worked out');
      return [];
    }
  }

  /** Ends every token, closes the connections and stops listening. Idempotent. */
  stop(): Promise<void> {
    this.#stopped ??= (async () => {
      this.#book.revokeAll();
      await this.#mcp.close().catch(() => undefined);
      await Promise.all([
        closeServer(this.#http),
        this.#unix === undefined ? undefined : closeServer(this.#unix),
      ]);
      const socketPath = this.socketPath;
      if (socketPath !== undefined) rmSync(socketPath, { force: true });
      // The processes of the plugins live and die with the server that hands their tools out.
      await this.#options.plugins?.stop().catch(() => undefined);
    })();
    return this.#stopped;
  }

  // ---- request path ----

  async #serve(request: Request): Promise<Response> {
    const hostError = hostHeaderValidationResponse(request, localhostAllowedHostnames());
    if (hostError !== undefined) return hostError;
    const originError = originValidationResponse(request, localhostAllowedOrigins());
    if (originError !== undefined) return originError;
    const token = bearerToken(request.headers.get('authorization'));
    const record = token === undefined ? undefined : this.#book.resolve(token);
    if (record === undefined) {
      return rejected(401, 'unauthorized', { 'www-authenticate': 'Bearer realm="otheater"' });
    }
    const authInfo: AuthInfo = {
      token: record.id,
      clientId: record.input.attemptId,
      scopes: [record.input.role],
      extra: { record },
    };
    return this.#mcp.fetch(request, { authInfo });
  }

  #createHandler(): McpHttpHandler {
    const { logger, version } = this.#options;
    return createMcpHandler(
      async (context) => {
        const record = context.authInfo?.extra?.record as GrantRecord | undefined;
        const server = new McpServer({ name: 'otheater', version });
        if (record === undefined) return server;
        const hidden = this.#options.hiddenTools?.() ?? new Set<string>();
        for (const tool of this.#options.registries.tools.list()) {
          if (!tool.roles.includes(record.input.role)) continue;
          if (hidden.has(tool.name)) continue;
          if (record.input.tools !== undefined && !record.input.tools.includes(tool.name)) continue;
          server.registerTool(
            tool.name,
            { description: describe(tool), inputSchema: deferred(tool.input) },
            async (args, context) =>
              await this.#withNotices(
                record,
                tool,
                asResult(await this.#call(record, tool, args, context.mcpReq.signal)),
              ),
          );
        }
        for (const binding of await this.#pluginTools(record)) {
          server.registerTool(
            binding.name,
            { description: binding.description, inputSchema: pluginSchema(binding.inputSchema) },
            async (args) => await this.#callPlugin(record, binding, args),
          );
        }
        return server;
      },
      {
        onerror: (error) => {
          logger.warn({ err: error }, 'MCP request failed');
        },
      },
    );
  }

  /**
   * The tools of the plugins this grant sees. The set of plugins is the one active in the project
   * at the grant's first request (a session in course keeps it); a failure here costs the plugin
   * tools, never the framework ones.
   */
  async #pluginTools(record: GrantRecord): Promise<readonly PluginToolBinding[]> {
    const plugins = this.#options.plugins;
    if (plugins === undefined) return [];
    try {
      const { input } = record;
      let snapshot = this.#snapshots.get(input);
      if (snapshot === undefined) {
        snapshot = (async () => {
          const project = input.project ?? (await this.#options.projectOf?.(input));
          return project === undefined ? undefined : plugins.snapshot(project);
        })();
        this.#snapshots.set(input, snapshot);
      }
      const resolved = await snapshot;
      if (resolved === undefined) return [];
      return await plugins.tools(resolved, input.role, input.pluginTools ?? input.tools);
    } catch (error) {
      this.#options.logger.warn({ err: error }, 'plugin tools could not be listed');
      return [];
    }
  }

  /**
   * One call of a plugin tool: revoked? in the grant of the session? recovery gate? approval of the
   * Producer? then the process of the plugin. A refusal never reaches the plugin (P6).
   */
  async #callPlugin(
    record: GrantRecord,
    binding: PluginToolBinding,
    args: unknown,
  ): Promise<CallToolResult> {
    if (record.revoked) return asResult({ ok: false, value: { error: 'revoked' } });
    const { input } = record;
    const allow = input.pluginTools ?? input.tools;
    if (allow !== undefined && !allow.includes(binding.name)) {
      return this.#refuse(
        record,
        binding,
        'not_allowed',
        'The policy of your role does not allow this tool.',
      );
    }
    await this.#options.gate?.wait();
    const plugins = this.#options.plugins;
    if (plugins === undefined) return asResult({ ok: false, value: { error: 'revoked' } });
    const given =
      typeof args === 'object' && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : undefined;
    const approval = approvalOf(binding.tool, this.#permissions());
    if (approval !== 'none') {
      const refusal = await this.#askProducer(record, binding, given);
      if (refusal !== undefined) return refusal;
      // The session may have ended while the Producer decided (the flag is read again on purpose).
      if (isRevoked(record)) return asResult({ ok: false, value: { error: 'revoked' } });
    }
    return await plugins.call(binding, given);
  }

  #permissions(): PluginPermissionSettings {
    return this.#options.pluginPermissions?.() ?? DEFAULT_PLUGIN_PERMISSIONS;
  }

  /** What the card shows of the arguments (`plugins.permissions.approval_detail`). */
  #detailOf(args: Record<string, unknown> | undefined): string {
    return approvalDetailOf(args, this.#permissions().approvalDetail);
  }

  /**
   * Asks the Producer whether the call may run: `undefined` when it may, the tool error otherwise.
   * The two events of the permission (`permission.asked` and `permission.answered`) tell the
   * answer, with the reasons `plugin_tool_approved` and `plugin_tool_refused`.
   */
  async #askProducer(
    record: GrantRecord,
    binding: PluginToolBinding,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult | undefined> {
    await this.#say(record, binding, 'asked');
    const outcome = await askProducerToApprove(
      this.#options.askApproval,
      binding.project,
      `Allow the tool ${binding.name} (${binding.tool.effects}, role ${record.input.role})? ` +
        this.#detailOf(args),
    );
    await this.#say(record, binding, outcome === 'approved' ? 'approved' : 'refused');
    if (outcome === 'approved') return undefined;
    const message = {
      approval_unavailable:
        'This tool needs the Producer to approve it and nobody can be asked right now.',
      approval_cancelled: 'The question to the Producer ended without an answer.',
      approval_denied: `The Producer did not approve this call of ${binding.name}. Do not try it again unless the task needs it, and then say why.`,
    }[outcome];
    return this.#refuse(record, binding, outcome, message);
  }

  /** The tool error of a refused call, and the notice of it. The plugin is never called. */
  #refuse(
    record: GrantRecord,
    binding: PluginToolBinding,
    reason: Extract<PluginNotice, { kind: 'tool_refused' }>['reason'],
    message: string,
  ): CallToolResult {
    this.#options.logger.warn(
      { plugin: binding.plugin.id, tool: binding.tool.name, role: record.input.role, reason },
      'plugin tool call refused: it did not reach the plugin',
    );
    try {
      this.#options.onPluginNotice?.({
        kind: 'tool_refused',
        plugin: binding.plugin.id,
        project: binding.project,
        tool: binding.tool.name,
        role: record.input.role,
        reason,
      });
    } catch (error) {
      this.#options.logger.warn({ err: error }, 'plugin notice sink failed');
    }
    return asResult({ ok: false, value: { error: reason, message } });
  }

  /** `permission.asked`, then `permission.answered`, for the card of a plugin tool. */
  async #say(
    record: GrantRecord,
    binding: PluginToolBinding,
    state: 'asked' | 'approved' | 'refused',
  ): Promise<void> {
    const { correlation } = record.input;
    const common = {
      sessionId: record.sessionId ?? record.input.attemptId,
      tool: binding.name.slice(0, 256),
      paths: [],
      pathCount: 0,
      ...(correlation.playId === undefined ? {} : { playId: correlation.playId }),
      ...(correlation.demandId === undefined ? {} : { demandId: correlation.demandId }),
      attemptId: record.input.attemptId,
    };
    try {
      await record.input.record(
        state === 'asked'
          ? buildDaemonEvent('permission.asked', common)
          : buildDaemonEvent('permission.answered', {
              ...common,
              answer: state === 'approved' ? 'allow' : 'reject',
              rule: `plugin:${binding.plugin.id}`.slice(0, 256),
              reason: state === 'approved' ? 'plugin_tool_approved' : 'plugin_tool_refused',
            }),
      );
    } catch (error) {
      this.#options.logger.warn({ err: error }, 'permission event of a plugin tool not recorded');
    }
  }

  /**
   * The reply of a tool of an Actor with the Director's pending messages added as text blocks
   * (`supervision.delivery: tool_reply`). A `submit*` is left alone: it ends the work, and the
   * attempt that gets here is still working.
   */
  async #withNotices(
    record: GrantRecord,
    tool: ToolDefinition,
    result: CallToolResult,
  ): Promise<CallToolResult> {
    const { notices } = this.#options;
    const { playId, demandId } = record.input.correlation;
    if (notices === undefined || record.input.role !== 'actor') return result;
    if (isSubmitTool(tool.name) || playId === undefined || demandId === undefined) return result;
    try {
      const blocks = await notices({ attemptId: record.input.attemptId, playId, demandId });
      if (blocks.length === 0) return result;
      return {
        ...result,
        content: [...result.content, ...blocks.map((text) => ({ type: 'text' as const, text }))],
      };
    } catch (error) {
      this.#options.logger.warn({ err: error }, 'the supervision notices were not attached');
      return result;
    }
  }

  /** One call of a tool: the order is revoked? submit? input valid? handler? */
  async #call(
    record: GrantRecord,
    tool: ToolDefinition,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ToolReply> {
    if (record.revoked) return { ok: false, value: { error: 'revoked' } };
    await this.#options.gate?.wait();
    try {
      if (isSubmitTool(tool.name)) {
        return await runSubmit(record, tool, args, this.#options.submitRetries);
      }
      const parsed = tool.input.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          ok: false,
          value: { error: 'invalid_input', message: describeIssues(parsed.error) },
        };
      }
      if (tool.name === 'ask_producer') {
        const questions = askProducerInput.parse(parsed.data);
        const errors = producerQuestionErrors(
          questions,
          this.#options.producerQuestions ?? 'choices',
        );
        if (errors.length > 0) {
          return { ok: false, value: { error: 'invalid_input', message: errors.join('\n') } };
        }
      }
      const handler = this.#handlers.get(tool.name);
      if (handler === undefined) return { ok: false, value: notImplemented(tool.name) };
      const value = await handler({
        tool,
        input: parsed.data,
        caller: {
          role: record.input.role,
          attemptId: record.input.attemptId,
          sessionId: record.sessionId,
          correlation: record.input.correlation,
          worktree: record.input.worktree,
          networkAllow: record.input.networkAllow ?? [],
          record: record.input.record,
          signal,
        },
      });
      if (value instanceof ToolFailure) {
        return {
          ok: false,
          value: { ...value.details, error: value.code, message: value.message },
        };
      }
      if (value instanceof ToolWithImage) {
        return { ok: true, value: value.value, image: value.image };
      }
      return { ok: true, value };
    } catch (error) {
      if (error instanceof ToolFailure) {
        return {
          ok: false,
          value: { ...error.details, error: error.code, message: error.message },
        };
      }
      this.#options.logger.error({ err: error, tool: tool.name }, 'MCP tool failed');
      return {
        ok: false,
        value: { error: 'internal_error', message: `The tool ${tool.name} failed.` },
      };
    }
  }
}
