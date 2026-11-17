// SPDX-License-Identifier: MPL-2.0
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import {
  AdapterUnavailable,
  askProducerInput,
  type Registries,
  type ToolDefinition,
} from '@otheater/core';
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
import type { Logger } from '../logger.js';
import type { McpAccess, McpGrant, McpGrantInput } from './access.js';
import { producerQuestionErrors, type ProducerQuestionMode } from './ask-producer.js';
import { notImplemented, ToolHandlers } from './handlers.js';
import { describeIssues, isSubmitTool, runSubmit, type ToolReply } from './submit.js';
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

function asResult(reply: ToolReply): CallToolResult {
  const { value } = reply;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const structured =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return {
    content: [{ type: 'text', text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    ...(reply.ok ? {} : { isError: true }),
  };
}

function rejected(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * The framework MCP server (architecture 5.3): the tools of each role, over Streamable HTTP, on
 * `127.0.0.1` only. It lives and dies with the daemon.
 *
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
  readonly #mcp: McpHttpHandler;
  #url: string;
  #stopped: Promise<void> | undefined;

  private constructor(options: FrameworkMcpOptions, http: HttpServer, port: number) {
    this.#options = options;
    this.#handlers = options.handlers ?? new ToolHandlers();
    this.#http = http;
    this.#url = `http://${MCP_HOST}:${String(port)}${MCP_PATH}`;
    this.#book = new GrantBook(() => this.#url);
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
    const current = new FrameworkMcpServer(options, http, address.port);
    ready.server = current;
    options.logger.info({ url: current.url }, 'MCP framework server listening');
    return current;
  }

  get url(): string {
    return this.#url;
  }

  /** The grants alive now (tests and the daemon status read it). */
  get grants(): number {
    return this.#book.size;
  }

  grant(input: McpGrantInput): McpGrant {
    return this.#book.grant(input);
  }

  /** Ends every token, closes the connections and stops listening. Idempotent. */
  stop(): Promise<void> {
    this.#stopped ??= (async () => {
      this.#book.revokeAll();
      await this.#mcp.close().catch(() => undefined);
      await new Promise<void>((resolve) => {
        this.#http.close(() => {
          resolve();
        });
        this.#http.closeAllConnections();
      });
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
      (context) => {
        const record = context.authInfo?.extra?.record as GrantRecord | undefined;
        const server = new McpServer({ name: 'otheater', version });
        if (record === undefined) return server;
        for (const tool of this.#options.registries.tools.list()) {
          if (!tool.roles.includes(record.input.role)) continue;
          server.registerTool(
            tool.name,
            { description: describe(tool), inputSchema: deferred(tool.input) },
            async (args) => asResult(await this.#call(record, tool, args)),
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

  /** One call of a tool: the order is revoked? submit? input valid? handler? */
  async #call(record: GrantRecord, tool: ToolDefinition, args: unknown): Promise<ToolReply> {
    if (record.revoked) return { ok: false, value: { error: 'revoked' } };
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
          record: record.input.record,
        },
      });
      return { ok: true, value };
    } catch (error) {
      this.#options.logger.error({ err: error, tool: tool.name }, 'MCP tool failed');
      return {
        ok: false,
        value: { error: 'internal_error', message: `The tool ${tool.name} failed.` },
      };
    }
  }
}
