// SPDX-License-Identifier: MPL-2.0

/** An HTTP MCP server the session was given (`mcpServers` of `session/new` and `session/load`). */
export interface HttpMcpServer {
  readonly name: string;
  readonly url: string;
  /** The headers as the client must send them, `Authorization: Bearer <token>` among them. */
  readonly headers: Readonly<Record<string, string>>;
}

/** What a `tools/call` came back with. */
export interface McpToolOutcome {
  readonly isError: boolean;
  /** The text blocks of the result, joined. */
  readonly text: string;
  readonly structured: unknown;
  /** The `image` blocks of the result: what the model would be shown (the bytes are not kept). */
  readonly images: readonly { readonly mimeType: string; readonly bytes: number }[];
}

/** A failure that is not a tool result: the HTTP status, or a JSON-RPC error. */
export class McpClientError extends Error {
  override name = 'McpClientError';
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

const LATEST_PROTOCOL = '2025-06-18';

/** The answer is JSON, or an event stream whose `data:` frame carries the JSON. */
function bodyOf(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as unknown;
  const frames = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((data) => data !== '');
  const last = frames.at(-1);
  return last === undefined ? undefined : (JSON.parse(last) as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A minimal MCP client over Streamable HTTP, written with `fetch` alone (no client package): what
 * the fake agent needs to play the part of an Executor that calls the framework tools. One
 * instance talks to one server with the headers the session was given.
 */
export class McpHttpClient {
  readonly #server: HttpMcpServer;
  #id = 0;
  #sessionId: string | undefined;
  #protocol = LATEST_PROTOCOL;

  constructor(server: HttpMcpServer) {
    this.#server = server;
  }

  async #post(payload: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(this.#server.url, {
      method: 'POST',
      headers: {
        ...this.#server.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': this.#protocol,
        ...(this.#sessionId === undefined ? {} : { 'mcp-session-id': this.#sessionId }),
      },
      body: JSON.stringify(payload),
    });
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId !== null) this.#sessionId = sessionId;
    const text = await response.text();
    if (!response.ok) {
      throw new McpClientError(
        `MCP server answered HTTP ${String(response.status)}`,
        response.status,
      );
    }
    return bodyOf(text);
  }

  async #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.#id += 1;
    const answer = await this.#post({ jsonrpc: '2.0', id: this.#id, method, params });
    if (!isRecord(answer)) throw new McpClientError(`${method}: no JSON-RPC answer`, undefined);
    const error = answer.error;
    if (isRecord(error)) {
      const message = typeof error.message === 'string' ? error.message : 'error';
      throw new McpClientError(`${method}: ${message}`, undefined);
    }
    return answer.result;
  }

  /** `initialize`, then the `notifications/initialized` the protocol asks for. */
  async initialize(): Promise<void> {
    const result = await this.#request('initialize', {
      protocolVersion: LATEST_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'otheater-fake-agent', version: '0.0.0' },
    });
    if (isRecord(result) && typeof result.protocolVersion === 'string') {
      this.#protocol = result.protocolVersion;
    }
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** The names of the tools the server lists for this token, as it sent them. */
  async listTools(): Promise<string[]> {
    const result = await this.#request('tools/list', {});
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
    const names: string[] = [];
    for (const tool of tools) {
      if (isRecord(tool) && typeof tool.name === 'string') names.push(tool.name);
    }
    return names;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolOutcome> {
    const result = await this.#request('tools/call', { name, arguments: args });
    const record = isRecord(result) ? result : {};
    const content = Array.isArray(record.content) ? record.content : [];
    const text = content
      .map((block) =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string'
          ? block.text
          : '',
      )
      .join('');
    const images = content.flatMap((block) =>
      isRecord(block) &&
      block.type === 'image' &&
      typeof block.mimeType === 'string' &&
      typeof block.data === 'string'
        ? [{ mimeType: block.mimeType, bytes: Buffer.from(block.data, 'base64').length }]
        : [],
    );
    return {
      isError: record.isError === true,
      text,
      structured: record.structuredContent,
      images,
    };
  }
}
