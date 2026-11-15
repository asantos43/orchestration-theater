import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Jsonl } from './jsonl.ts';

export type McpHandle = {
  url: string;
  port: number;
  log: Jsonl;
  calls: { tool: string; args: unknown; path: string }[];
  close(): Promise<void>;
};

/** Servidor MCP Streamable HTTP (sem estado) em 127.0.0.1, com `ping` e `submit_result`. */
export async function startMcp(logFile: string): Promise<McpHandle> {
  const log = new Jsonl(logFile);
  const calls: McpHandle['calls'] = [];
  const build = (path: string) => {
    const s = new McpServer({ name: 'otheater-spike-mcp', version: '0.0.1' });
    s.registerTool(
      'ping',
      { description: 'Health check. Returns "pong".', inputSchema: {} },
      async () => {
        calls.push({ tool: 'ping', args: {}, path });
        log.write({ ev: 'tool_call', tool: 'ping', path });
        return { content: [{ type: 'text', text: 'pong' }] };
      },
    );
    s.registerTool(
      'submit_result',
      {
        description: 'Submit the final result of the task. Call exactly once when done.',
        inputSchema: { summary: z.string().describe('Short summary of what was done') },
      },
      async ({ summary }) => {
        calls.push({ tool: 'submit_result', args: { summary }, path });
        log.write({ ev: 'tool_call', tool: 'submit_result', path, summary });
        return { content: [{ type: 'text', text: 'result recorded' }] };
      },
    );
    return s;
  };
  const server: Server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    log.write({ ev: 'http', method: req.method, path, ua: req.headers['user-agent'] });
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return;
    }
    log.write({ ev: 'rpc', path, method: (body as { method?: string }).method });
    const mcp = build(path);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    log,
    calls,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
