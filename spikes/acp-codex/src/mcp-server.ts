// Servidor MCP HTTP (Streamable HTTP) do spike, em 127.0.0.1, com `ping` e `submit_result`.
import { createServer, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface McpCall {
  at: number;
  tool: string;
  args: unknown;
}

export interface SpikeMcp {
  url: string;
  calls: McpCall[];
  requests: { at: number; method: string; rpc?: string }[];
  close(): Promise<void>;
}

function buildServer(calls: McpCall[]): McpServer {
  const server = new McpServer({ name: 'spike-mcp', version: '0.0.1' });
  server.registerTool(
    'ping',
    { description: 'Responde pong. Serve para testar a conexao MCP.', inputSchema: {} },
    async () => {
      calls.push({ at: Date.now(), tool: 'ping', args: {} });
      return { content: [{ type: 'text', text: 'pong' }] };
    },
  );
  server.registerTool(
    'submit_result',
    {
      description: 'Entrega o resultado final da tarefa. Chame uma vez ao terminar.',
      inputSchema: { summary: z.string().describe('Resumo do que foi feito') },
    },
    async (args) => {
      calls.push({ at: Date.now(), tool: 'submit_result', args });
      return { content: [{ type: 'text', text: 'resultado recebido' }] };
    },
  );
  return server;
}

export async function startMcp(): Promise<SpikeMcp> {
  const calls: McpCall[] = [];
  const requests: SpikeMcp['requests'] = [];
  const http: Server = createServer(async (req, res) => {
    try {
      let body: unknown;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : undefined;
      }
      requests.push({ at: Date.now(), method: req.method ?? '?', rpc: (body as { method?: string } | undefined)?.method });
      // modo sem estado: um servidor e um transporte por requisicao
      const server = buildServer(calls);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const addr = http.address();
  if (!addr || typeof addr === 'string') throw new Error('sem porta');
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    calls,
    requests,
    close: () =>
      new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      }),
  };
}
