// SPDX-License-Identifier: MPL-2.0
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterUnavailable, type NewEvent } from '@otheater/core';
import { buildDaemonRegistries } from '../registries.js';
import { captureLogger } from '../test-helpers.js';
import { FrameworkMcpServer, MCP_PATH, ToolHandlers, type McpGrant } from './index.js';

const registries = buildDaemonRegistries();

interface Harness {
  readonly server: FrameworkMcpServer;
  readonly events: NewEvent[];
  grant(role: string, attemptId?: string): McpGrant;
}

const running: FrameworkMcpServer[] = [];

async function harness(
  options: {
    retries?: number;
    port?: 'auto' | number;
    handlers?: ToolHandlers;
    producerQuestions?: 'choices' | 'choices_strict' | 'free';
  } = {},
): Promise<Harness> {
  const { logger } = captureLogger();
  const server = await FrameworkMcpServer.start({
    registries,
    port: options.port ?? 'auto',
    submitRetries: options.retries ?? 2,
    ...(options.handlers === undefined ? {} : { handlers: options.handlers }),
    ...(options.producerQuestions === undefined
      ? {}
      : { producerQuestions: options.producerQuestions }),
    logger,
    version: '0.0.0-test',
  });
  running.push(server);
  const events: NewEvent[] = [];
  return {
    server,
    events,
    grant: (role, attemptId = 'p1/d1/1') =>
      server.grant({
        attemptId,
        role,
        correlation: { playId: 'p1', demandId: 'd1', attemptId },
        record: (event) => {
          events.push(event);
          return Promise.resolve();
        },
      }),
  };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

function authOf(grant: McpGrant): Record<string, string> {
  return { ...grant.server.headers };
}

interface Rpc {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

let nextId = 1;

async function rpc(
  url: string,
  headers: Record<string, string>,
  method: string,
  params?: unknown,
): Promise<Rpc> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text.length > 0) {
    // The answer is JSON, or one SSE `data:` frame with the JSON.
    const data = text.startsWith('{')
      ? text
      : (text
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice(5)
          .trim() ?? '{}');
    body = JSON.parse(data) as Record<string, unknown>;
  }
  return { status: response.status, body };
}

async function listTools(grant: McpGrant, url: string): Promise<string[]> {
  const { body } = await rpc(url, authOf(grant), 'tools/list', {});
  const result = body.result as { tools: { name: string }[] };
  return result.tools.map((tool) => tool.name).sort();
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

async function callTool(
  grant: McpGrant,
  url: string,
  name: string,
  args: unknown,
): Promise<{ result: ToolResult | undefined; body: Record<string, unknown> }> {
  const { body } = await rpc(url, authOf(grant), 'tools/call', { name, arguments: args });
  return { result: body.result as ToolResult | undefined, body };
}

describe('the framework MCP server: start and stop', () => {
  it('listens on 127.0.0.1 only, on a free port with auto, and stops listening', async () => {
    const a = await harness();
    const b = await harness();
    expect(a.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(a.server.url).not.toBe(b.server.url);
    expect(MCP_PATH).toBe('/mcp');
    const url = a.server.url;
    await a.server.stop();
    await a.server.stop(); // idempotent
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
  });

  it('rejects with AdapterUnavailable when a fixed port is taken', async () => {
    const first = await harness();
    const port = Number(new URL(first.server.url).port);
    await expect(harness({ port })).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('serves nothing outside /mcp', async () => {
    const h = await harness();
    const other = new URL(h.server.url);
    other.pathname = '/other';
    const response = await fetch(other, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});

describe('the token and the role', () => {
  it('answers 401 without a token, with a wrong one and after the token was revoked', async () => {
    const h = await harness();
    const grant = h.grant('author');
    expect((await rpc(h.server.url, {}, 'tools/list', {})).status).toBe(401);
    expect(
      (await rpc(h.server.url, { authorization: 'Bearer nope' }, 'tools/list', {})).status,
    ).toBe(401);
    expect((await rpc(h.server.url, { authorization: 'Basic abc' }, 'tools/list', {})).status).toBe(
      401,
    );
    expect((await rpc(h.server.url, authOf(grant), 'tools/list', {})).status).toBe(200);
    grant.revoke();
    expect((await rpc(h.server.url, authOf(grant), 'tools/list', {})).status).toBe(401);
    expect(h.server.grants).toBe(0);
  });

  it('hands the session the url and an Authorization Bearer header, and binds the session', async () => {
    const h = await harness();
    const grant = h.grant('actor');
    expect(grant.server.name).toBe('otheater');
    expect(grant.server.url).toBe(h.server.url);
    expect(grant.server.headers?.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{40,}$/);
    expect(grant.sessionId).toBeUndefined();
    grant.bind('sess-1');
    expect(grant.sessionId).toBe('sess-1');
  });

  it('lists only the tools of the role of the token', async () => {
    const h = await harness();
    const expected = (role: string): string[] =>
      registries.tools
        .list()
        .filter((tool) => tool.roles.includes(role))
        .map((tool) => tool.name)
        .sort();
    for (const role of ['director', 'author', 'reviewer', 'scriptwriter', 'actor', 'critic']) {
      const grant = h.grant(role);
      expect(await listTools(grant, h.server.url), role).toEqual(expected(role));
    }
    const author = await listTools(h.grant('author'), h.server.url);
    expect(author).toContain('submit_plan');
    expect(author).not.toContain('submit_critique');
    expect(author).not.toContain('ask_producer');
    const director = await listTools(h.grant('director'), h.server.url);
    expect(director).toContain('ask_producer');
    expect(director).not.toContain('submit');
  });

  it('gives each tool its real JSON schema (ask_producer lists the questions)', async () => {
    const h = await harness();
    const { body } = await rpc(h.server.url, authOf(h.grant('director')), 'tools/list', {});
    const tools = (body.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const ask = tools.find((tool) => tool.name === 'ask_producer');
    const schema = JSON.stringify(ask?.inputSchema);
    expect(schema).toContain('multi_select');
    expect(schema).toContain('recommended');
    expect(schema).toContain('"maxItems":4');
  });

  it('announces the real schema of the stage tools, not a free record', async () => {
    const h = await harness();
    const schemaOf = async (role: string, name: string): Promise<Record<string, unknown>> => {
      const { body } = await rpc(h.server.url, authOf(h.grant(role)), 'tools/list', {});
      const tools = (body.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
      return tools.find((tool) => tool.name === name)?.inputSchema as Record<string, unknown>;
    };
    const plan = await schemaOf('author', 'submit_plan');
    expect(plan.required).toEqual(['plan']);
    expect(plan.properties).toMatchObject({
      plan: { type: 'string', minLength: 1 },
      openQuestions: { type: 'array', items: { type: 'string' } },
    });
    for (const [role, name] of [
      ['reviewer', 'submit_plan_review'],
      ['author', 'submit_script_review'],
      ['critic', 'submit_critique'],
    ] as const) {
      const review = await schemaOf(role, name);
      expect(review.required, name).toEqual(['approved']);
      expect(review.properties, name).toMatchObject({
        approved: { type: 'boolean' },
        reason: { type: 'string' },
      });
    }
    const script = await schemaOf('scriptwriter', 'submit_script');
    expect(script.required).toEqual(['script']);
  });

  it("a role's token cannot call the tool of another role, and nothing is recorded", async () => {
    const h = await harness();
    const author = h.grant('author');
    const { result, body } = await callTool(author, h.server.url, 'submit_critique', {
      verdict: 'pass',
    });
    // Either a protocol error or an error result: never an accepted submit.
    expect(result?.isError === true || body.error !== undefined).toBe(true);
    expect(h.events).toEqual([]);
    const actor = h.grant('actor');
    const asDirector = await callTool(actor, h.server.url, 'next_action', {});
    expect(asDirector.result?.isError === true || asDirector.body.error !== undefined).toBe(true);
  });
});

describe('Host and Origin', () => {
  it('refuses a Host outside localhost and an Origin outside localhost', async () => {
    const h = await harness();
    const grant = h.grant('author');
    const url = new URL(h.server.url);
    const send = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: Number(url.port),
            path: MCP_PATH,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              ...authOf(grant),
              ...headers,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
      });
    expect(await send({ host: 'evil.example.com' })).toBe(403);
    expect(await send({ host: `evil.example.com:${url.port}` })).toBe(403);
    expect(await send({ origin: 'http://evil.example.com' })).toBe(403);
    expect(await send({ origin: 'https://attacker.test:3000' })).toBe(403);
    expect(await send({ origin: 'http://localhost:3000' })).toBe(200);
    expect(await send({})).toBe(200);
  });
});

describe('submit tools', () => {
  const plan = { plan: 'write a, then b', openQuestions: [] };

  it('a valid submit is accepted and writes attempt.submitted with the correlation', async () => {
    const h = await harness();
    const grant = h.grant('author');
    const { result } = await callTool(grant, h.server.url, 'submit_plan', plan);
    expect(result?.isError).toBeUndefined();
    expect(result?.structuredContent).toEqual({ accepted: true });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'attempt.submitted',
      schemaVersion: 1,
      payload: {
        tool: 'submit_plan',
        role: 'author',
        output: plan,
        calls: 1,
        playId: 'p1',
        demandId: 'd1',
        attemptId: 'p1/d1/1',
      },
    });
  });

  it.each([
    ['plan missing', {}],
    ['plan empty', { plan: '' }],
    ['plan an object', { plan: { steps: ['a'] } }],
    ['openQuestions with an object', { plan: 'p', openQuestions: [{ question: 'q?' }] }],
    ['openQuestions with an empty string', { plan: 'p', openQuestions: [''] }],
    ['openQuestions not a list', { plan: 'p', openQuestions: 'q?' }],
  ])('submit_plan refuses %s inside the tool and counts it as a try', async (_name, input) => {
    const h = await harness({ retries: 1 });
    const grant = h.grant('author');
    const bad = await callTool(grant, h.server.url, 'submit_plan', input);
    expect(bad.result?.isError).toBe(true);
    expect(bad.result?.content[0]?.text).toContain('call submit_plan again');
    expect(h.events).toEqual([]);
    // The model fixes it and the very same attempt goes on.
    const good = await callTool(grant, h.server.url, 'submit_plan', { plan: 'p' });
    expect(good.result?.isError).toBeUndefined();
    expect(h.events.map((e) => e.type)).toEqual(['attempt.submitted']);
    expect(h.events[0]?.payload).toMatchObject({
      calls: 2,
      output: { plan: 'p', openQuestions: [] },
    });
  });

  it('submit_plan: the N+1-th invalid call is the failure of the attempt, with the errors', async () => {
    const h = await harness({ retries: 1 });
    const grant = h.grant('author');
    const input = { plan: { steps: ['a'] } };
    await callTool(grant, h.server.url, 'submit_plan', input);
    const second = await callTool(grant, h.server.url, 'submit_plan', input);
    expect(second.result?.structuredContent?.error).toBe('submit_failed');
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'attempt.submit_failed',
      payload: { tool: 'submit_plan' },
    });
    expect((h.events[0]?.payload as { errors: string }).errors).toContain('plan');
  });

  it.each([
    ['reviewer', 'submit_plan_review'],
    ['author', 'submit_script_review'],
    ['critic', 'submit_critique'],
  ])('%s: %s needs a boolean approved and a reason for a veto', async (role, tool) => {
    const h = await harness({ retries: 4 });
    const grant = h.grant(role);
    for (const bad of [
      {},
      { approved: 'true' },
      { approved: false },
      { approved: false, reason: ' ' },
    ]) {
      const reply = await callTool(grant, h.server.url, tool, bad);
      expect(reply.result?.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(h.events).toEqual([]);
    const veto = await callTool(grant, h.server.url, tool, { approved: false, reason: 'no tests' });
    expect(veto.result?.isError).toBeUndefined();
    expect(h.events[0]?.payload).toMatchObject({
      output: { approved: false, reason: 'no tests' },
      calls: 5,
    });
  });

  it('approved needs no reason, and an extra field is kept', async () => {
    const h = await harness();
    const reply = await callTool(h.grant('critic'), h.server.url, 'submit_critique', {
      approved: true,
      notes: 'fine',
    });
    expect(reply.result?.isError).toBeUndefined();
    expect(h.events[0]?.payload).toMatchObject({ output: { approved: true, notes: 'fine' } });
  });

  it('submit_script needs the script key; what is inside is checked by the script validation', async () => {
    const h = await harness({ retries: 1 });
    const grant = h.grant('scriptwriter');
    const missing = await callTool(grant, h.server.url, 'submit_script', { demands: [] });
    expect(missing.result?.isError).toBe(true);
    const malformed = await callTool(grant, h.server.url, 'submit_script', {
      script: 'not a script',
    });
    expect(malformed.result?.isError).toBeUndefined();
    expect(h.events.map((e) => e.type)).toEqual(['attempt.submitted']);
  });

  it('the common submit validates its own schema: result is required', async () => {
    const h = await harness({ retries: 1 });
    const grant = h.grant('actor');
    const bad = await callTool(grant, h.server.url, 'submit', { wrong: 1 });
    expect(bad.result?.isError).toBe(true);
    expect(bad.result?.content[0]?.text).toContain('call submit again');
    expect(h.events).toEqual([]);
    const good = await callTool(grant, h.server.url, 'submit', { result: { done: true } });
    expect(good.result?.isError).toBeUndefined();
    expect(h.events.map((e) => e.type)).toEqual(['attempt.submitted']);
    expect(h.events[0]?.payload).toMatchObject({ calls: 2 });
  });

  it('an invalid submit returns the error and counts; the N+1-th is the failure', async () => {
    const h = await harness({ retries: 2 });
    const grant = h.grant('actor');
    const invalid = { nope: true };
    const first = await callTool(grant, h.server.url, 'submit', invalid);
    expect(first.result?.isError).toBe(true);
    expect(first.result?.content[0]?.text).toContain('2 tries left');
    const second = await callTool(grant, h.server.url, 'submit', invalid);
    expect(second.result?.isError).toBe(true);
    expect(second.result?.content[0]?.text).toContain('1 try left');
    expect(h.events).toEqual([]);
    const third = await callTool(grant, h.server.url, 'submit', invalid);
    expect(third.result?.isError).toBe(true);
    expect(third.result?.structuredContent?.error).toBe('submit_failed');
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'attempt.submit_failed',
      payload: { tool: 'submit', role: 'actor', calls: 3, attemptId: 'p1/d1/1' },
    });
    // Closed: a valid call after the failure is not accepted and writes nothing more.
    const late = await callTool(grant, h.server.url, 'submit', { result: {} });
    expect(late.result?.isError).toBe(true);
    expect(late.result?.structuredContent?.error).toBe('submit_closed');
    expect(h.events).toHaveLength(1);
  });

  it('with submit_retries 0 the first invalid submit is already the failure', async () => {
    const h = await harness({ retries: 0 });
    const grant = h.grant('actor');
    const reply = await callTool(grant, h.server.url, 'submit', {});
    expect(reply.result?.structuredContent?.error).toBe('submit_failed');
    expect(h.events.map((e) => e.type)).toEqual(['attempt.submit_failed']);
  });

  it('a valid submit resets the count of invalid ones, and each grant counts alone', async () => {
    const h = await harness({ retries: 1 });
    const one = h.grant('actor');
    const two = h.grant('actor');
    await callTool(one, h.server.url, 'submit', {});
    await callTool(one, h.server.url, 'submit', { result: {} });
    const again = await callTool(one, h.server.url, 'submit', {});
    expect(again.result?.structuredContent?.error).toBe('invalid_output');
    const other = await callTool(two, h.server.url, 'submit', {});
    expect(other.result?.structuredContent?.error).toBe('invalid_output');
    expect(h.events.map((e) => e.type)).toEqual(['attempt.submitted']);
  });
});

describe('tools without a handler and with one', () => {
  it('a tool with no handler answers a structured not_implemented error', async () => {
    const h = await harness();
    const { result } = await callTool(h.grant('actor'), h.server.url, 'read_blackboard', {
      key: 'k',
    });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({
      error: 'not_implemented',
    });
  });

  it('validates the input of a tool before its handler, and passes who is calling', async () => {
    const seen: unknown[] = [];
    const handlers = new ToolHandlers().register('read_blackboard', (call) => {
      seen.push(call);
      return { value: 42 };
    });
    const h = await harness({ handlers });
    const grant = h.grant('actor');
    grant.bind('sess-9');
    const bad = await callTool(grant, h.server.url, 'read_blackboard', {});
    expect(bad.result?.isError).toBe(true);
    expect(bad.result?.structuredContent?.error).toBe('invalid_input');
    expect(seen).toHaveLength(0);
    const good = await callTool(grant, h.server.url, 'read_blackboard', { key: 'k' });
    expect(good.result?.structuredContent).toEqual({ value: 42 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      input: { key: 'k' },
      caller: { role: 'actor', attemptId: 'p1/d1/1', sessionId: 'sess-9' },
    });
  });

  it('refuses a second handler for the same tool', () => {
    const handlers = new ToolHandlers().register('status', () => ({}));
    expect(() => handlers.register('status', () => ({}))).toThrow();
  });

  it('a handler that throws answers an error result without leaking the message', async () => {
    const handlers = new ToolHandlers().register('status', () => {
      throw new Error('secret detail');
    });
    const h = await harness({ handlers });
    const { result } = await callTool(h.grant('director'), h.server.url, 'status', {});
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).not.toContain('secret detail');
  });
});

describe('ask_producer', () => {
  const options = [
    { label: 'pr', description: 'Open a pull request' },
    { label: 'merge', description: 'Merge now' },
  ];
  const handlers = (): ToolHandlers =>
    new ToolHandlers().register('ask_producer', () => ({ answers: ['pr'] }));

  it('accepts 1 to 4 questions with 2 to 4 options, a recommended one and the flags', async () => {
    const h = await harness({ handlers: handlers() });
    const { result } = await callTool(h.grant('director'), h.server.url, 'ask_producer', {
      questions: [
        { question: 'How to deliver?', options, recommended: 'pr', multi_select: true },
        { question: 'What is the project name?', open: true },
      ],
    });
    expect(result?.isError).toBeUndefined();
    expect(result?.structuredContent).toEqual({ answers: ['pr'] });
  });

  it('refuses 0 or 5 questions, 1 or 5 options and a recommended that is no option', async () => {
    const h = await harness({ handlers: handlers() });
    const grant = h.grant('director');
    const ask = async (questions: unknown): Promise<string | undefined> => {
      const { result } = await callTool(grant, h.server.url, 'ask_producer', { questions });
      return result?.isError === true ? 'refused' : 'accepted';
    };
    const q = { question: 'x', options };
    expect(await ask([])).toBe('refused');
    expect(await ask([q, q, q, q, q])).toBe('refused');
    expect(await ask([{ question: 'x', options: options.slice(0, 1) }])).toBe('refused');
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `o${String(i)}`, description: '' }));
    expect(await ask([{ question: 'x', options: five }])).toBe('refused');
    expect(await ask([{ ...q, recommended: 'ghost' }])).toBe('refused');
    expect(await ask([q])).toBe('accepted');
  });

  it('choices: a question without options needs open; choices_strict: always options; free: none', async () => {
    const run = async (
      mode: 'choices' | 'choices_strict' | 'free',
      question: Record<string, unknown>,
    ): Promise<boolean> => {
      const h = await harness({ handlers: handlers(), producerQuestions: mode });
      const { result } = await callTool(h.grant('director'), h.server.url, 'ask_producer', {
        questions: [question],
      });
      const refused = result?.isError === true;
      if (refused) expect(result.structuredContent?.error).toBe('invalid_input');
      return !refused;
    };
    expect(await run('choices', { question: 'free text?' })).toBe(false);
    expect(await run('choices', { question: 'free text?', open: true })).toBe(true);
    expect(await run('choices_strict', { question: 'free text?', open: true })).toBe(false);
    expect(await run('choices_strict', { question: 'pick', options })).toBe(true);
    expect(await run('free', { question: 'free text?' })).toBe(true);
  });
});
