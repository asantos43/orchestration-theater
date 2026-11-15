import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Jsonl } from './jsonl.ts';

/**
 * Servidor MCP HTTP de teste, com ferramentas de argumentos estruturados.
 * Usa o `Server` de baixo nível para registrar TODA chamada, inclusive a de argumentos inválidos
 * (o `McpServer` recusaria antes de o código ver os argumentos).
 */
export const Team = z.enum(['backend', 'frontend', 'infra']);
export const Priority = z.enum(['low', 'medium', 'high', 'critical']);
export const Severity = z.enum(['info', 'warning', 'error']);

export const SCHEMAS = {
  get_sprint_info: z.object({}),
  create_task: z.object({
    title: z.string().min(3),
    priority: Priority,
    labels: z.array(z.string().min(1)).min(1),
    assignee: z.object({ name: z.string().min(1), team: Team }),
    estimate_hours: z.number().positive().optional(),
  }),
  record_findings: z.object({
    findings: z.array(z.object({ file: z.string().min(1), line: z.number().int().positive(), severity: Severity })).min(1),
  }),
  submit_result: z.object({
    status: z.enum(['done', 'blocked']),
    summary: z.string().min(1),
    artifacts: z.array(z.string()).optional(),
  }),
} as const;
export type ToolName = keyof typeof SCHEMAS;

const JSON_SCHEMAS: Record<ToolName, { description: string; inputSchema: Record<string, unknown> }> = {
  get_sprint_info: {
    description: 'Returns the current sprint id, its owner and the owner team as JSON. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  create_task: {
    description: 'Create a task in the tracker. All of title, priority, labels and assignee are required.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title, at least 3 characters' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        labels: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'At least one label' },
        assignee: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            team: { type: 'string', enum: ['backend', 'frontend', 'infra'] },
          },
          required: ['name', 'team'],
        },
        estimate_hours: { type: 'number', description: 'Optional estimate in hours, positive' },
      },
      required: ['title', 'priority', 'labels', 'assignee'],
    },
  },
  record_findings: {
    description: 'Record review findings. Each finding has a file, a line number (integer) and a severity.',
    inputSchema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'integer', minimum: 1 },
              severity: { type: 'string', enum: ['info', 'warning', 'error'] },
            },
            required: ['file', 'line', 'severity'],
          },
        },
      },
      required: ['findings'],
    },
  },
  submit_result: {
    description: 'Submit the final result of the task. Call exactly once, as the last step.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'blocked'] },
        summary: { type: 'string', description: 'Short summary of what was done' },
        artifacts: { type: 'array', items: { type: 'string' }, description: 'Optional list of file paths or ids produced' },
      },
      required: ['status', 'summary'],
    },
  },
};

export type McpCall = { task: string; tool: string; args: unknown; valid: boolean; issues?: string; atMs: number };
export type McpHandle = {
  url: string;
  port: number;
  calls: McpCall[];
  setTask(t: string): void;
  close(): Promise<void>;
};

export async function startMcp(logFile: string, port: number): Promise<McpHandle> {
  const log = new Jsonl(logFile);
  const calls: McpCall[] = [];
  let task = 'none';
  let taskSeq = 0;
  const build = () => {
    const s = new Server({ name: 'otheater-test-mcp', version: '0.0.1' }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (Object.keys(JSON_SCHEMAS) as ToolName[]).map((name) => ({ name, ...JSON_SCHEMAS[name] })),
    }));
    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = req.params.name;
      const args = req.params.arguments ?? {};
      const schema = (SCHEMAS as Record<string, z.ZodTypeAny>)[tool];
      if (!schema) {
        const rec = { task, tool, args, valid: false, issues: 'unknown tool', atMs: log.now() };
        calls.push(rec);
        log.write({ ev: 'tool_call', ...rec });
        return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${tool}` }] };
      }
      const parsed = schema.safeParse(args);
      const rec: McpCall = parsed.success
        ? { task, tool, args, valid: true, atMs: log.now() }
        : { task, tool, args, valid: false, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), atMs: log.now() };
      calls.push(rec);
      log.write({ ev: 'tool_call', ...rec });
      if (!parsed.success) {
        return { isError: true, content: [{ type: 'text', text: `Invalid arguments for ${tool}: ${rec.issues}` }] };
      }
      switch (tool as ToolName) {
        case 'get_sprint_info':
          return { content: [{ type: 'text', text: JSON.stringify({ sprint: 'S-42', owner: 'carla', team: 'infra' }) }] };
        case 'create_task':
          return { content: [{ type: 'text', text: `task created: T-${100 + ++taskSeq}` }] };
        case 'record_findings':
          return { content: [{ type: 'text', text: `recorded ${(parsed.data as { findings: unknown[] }).findings.length} findings` }] };
        case 'submit_result':
          return { content: [{ type: 'text', text: 'result recorded' }] };
      }
    });
    return s;
  };
  const server: HttpServer = createServer(async (req, res) => {
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
    log.write({ ev: 'rpc', method: (body as { method?: string }).method });
    const mcp = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    calls,
    setTask: (t) => { task = t; },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
