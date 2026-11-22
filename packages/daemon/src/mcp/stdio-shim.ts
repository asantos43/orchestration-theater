// SPDX-License-Identifier: MPL-2.0
import { request } from 'node:http';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import * as nodeSea from 'node:sea';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

/**
 * The stdio shim of the framework MCP server (N161). On macOS, Seatbelt refuses a confined client
 * the loopback of the host, so the client cannot reach `http://127.0.0.1:<port>/mcp`; it can
 * connect to a Unix socket in the one folder the sandbox lists. The client starts this file as an
 * MCP server over stdio (ACP `McpServerStdio`), and the shim carries each JSON-RPC message of
 * stdin as one Streamable HTTP POST over that socket, with the token of the session, and writes
 * each JSON-RPC message of the answer to stdout, one per line.
 *
 * Only Node built-ins: the client runs it with the Node of the daemon, from the `dist` of the
 * daemon, and nothing else of the daemon loads. The framework server is stateless (one request,
 * one answer), so the shim keeps no stream open: no GET, no server-to-client requests.
 */

/** The socket of the server, absolute. */
export const SHIM_SOCKET_ENV = 'OT_MCP_SOCKET';
/** The whole `Authorization` value of the session (`Bearer <token>`). */
export const SHIM_AUTHORIZATION_ENV = 'OT_MCP_AUTHORIZATION';

/** JSON-RPC code of a failure of the shim itself (the server not reachable, an HTTP error). */
export const SHIM_ERROR_CODE = -32000;
const PARSE_ERROR = -32700;

export interface ShimOptions {
  readonly socketPath: string;
  readonly authorization: string;
  /** Path of the server; default `/mcp`. */
  readonly path?: string;
  readonly input: Readable;
  readonly output: Writable;
}

interface Answer {
  readonly status: number;
  readonly type: string;
  readonly sessionId: string | undefined;
  readonly body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The id of a request; `undefined` for a notification, a response or a batch. */
function requestId(message: unknown): string | number | null | undefined {
  if (!isRecord(message) || typeof message.method !== 'string') return undefined;
  const id = message.id;
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : undefined;
}

/** The JSON-RPC messages of an answer: a JSON body, or the `data` of each event of a stream. */
export function messagesOf(type: string, body: string): unknown[] {
  if (body.trim() === '') return [];
  if (!type.includes('text/event-stream')) return [JSON.parse(body) as unknown];
  const messages: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data.trim() !== '') messages.push(JSON.parse(data) as unknown);
  }
  return messages;
}

/** Carries stdin to the server until stdin ends and every answer is written. */
export async function runShim(options: ShimOptions): Promise<void> {
  const path = options.path ?? '/mcp';
  let protocol: string | undefined;
  let sessionId: string | undefined;
  const pending = new Set<Promise<void>>();

  const write = (message: unknown): void => {
    options.output.write(`${JSON.stringify(message)}\n`);
  };
  const fail = (
    id: string | number | null | undefined,
    message: string,
    code = SHIM_ERROR_CODE,
  ) => {
    if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const post = (body: string): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const outgoing = request(
        {
          socketPath: options.socketPath,
          path,
          method: 'POST',
          headers: {
            // The server checks Host against localhost (DNS rebinding); over the socket it is ours.
            host: '127.0.0.1',
            authorization: options.authorization,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': Buffer.byteLength(body),
            ...(protocol === undefined ? {} : { 'mcp-protocol-version': protocol }),
            ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('error', reject);
          incoming.on('end', () => {
            const header = incoming.headers['mcp-session-id'];
            resolve({
              status: incoming.statusCode ?? 0,
              type: incoming.headers['content-type'] ?? '',
              sessionId: typeof header === 'string' ? header : undefined,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });

  const carry = async (line: string): Promise<void> => {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      fail(null, 'the shim got a line that is not JSON', PARSE_ERROR);
      return;
    }
    const id = requestId(message);
    let answer: Answer;
    try {
      answer = await post(JSON.stringify(message));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? String(error);
      fail(id, `the MCP server of the daemon is not reachable (${code})`);
      return;
    }
    if (answer.sessionId !== undefined) sessionId = answer.sessionId;
    let messages: unknown[];
    try {
      messages = messagesOf(answer.type, answer.body);
    } catch {
      messages = [];
    }
    const replies = messages.filter((reply) => isRecord(reply) && 'jsonrpc' in reply);
    if (answer.status >= 400 && replies.length === 0) {
      fail(id, `the MCP server of the daemon answered HTTP ${String(answer.status)}`);
      return;
    }
    for (const reply of replies) {
      if (isRecord(reply) && isRecord(reply.result)) {
        const version = reply.result.protocolVersion;
        if (typeof version === 'string' && isRecord(message) && message.method === 'initialize') {
          protocol = version;
        }
      }
      write(reply);
    }
  };

  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const task = carry(line).finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
}

/** The absolute path of this file once built, from the sources or from `dist`. */
export const STDIO_SHIM_PATH = fileURLToPath(
  new URL('../../dist/mcp/stdio-shim.js', import.meta.url),
);

/** Local on purpose: this file loads nothing but Node built-ins (see the note on top). */
function isSea(): boolean {
  try {
    return nodeSea.isSea();
  } catch {
    return false;
  }
}

function invokedDirectly(): boolean {
  // In the single executable (Phase 10, P1) the shim is a mode of the executable (`runShimMain`);
  // `argv[1]` there is the executable's own name, never this module.
  if (isSea()) return false;
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * The body of the shim process: reads the socket and the authorization from the environment and
 * bridges stdin and stdout until the client closes them. The exit code is left in `process.exitCode`
 * (2 when the environment is incomplete). Called by `invokedDirectly` (the checkout, `node
 * stdio-shim.js`) and by the `mcp-shim` mode of the single executable.
 */
export async function runShimMain(): Promise<void> {
  const socketPath = process.env[SHIM_SOCKET_ENV];
  const authorization = process.env[SHIM_AUTHORIZATION_ENV];
  if (socketPath === undefined || authorization === undefined) {
    process.stderr.write(
      `otheater MCP shim: ${SHIM_SOCKET_ENV} and ${SHIM_AUTHORIZATION_ENV} are required\n`,
    );
    process.exitCode = 2;
    return;
  }
  // A client that closes our stdout first has gone: nothing left to answer.
  process.stdout.on('error', () => process.exit(0));
  await runShim({ socketPath, authorization, input: process.stdin, output: process.stdout });
}

// Not awaited: a top-level `await` cannot be bundled into the one CommonJS file of the executable.
if (invokedDirectly()) {
  void runShimMain();
}
