// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  client,
  methods,
  ndJsonStream,
  RequestError,
  type AgentApp,
  type ClientContext,
  type PromptResponse,
  type RequestPermissionRequest,
  type SessionUpdate,
  type Stream,
} from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectToStreams, createFakeAgent } from './agent.js';
import {
  QUOTA_EXHAUSTED_CODE,
  QUOTA_SIGNAL_METHOD,
  quotaExhaustedDataSchema,
  quotaSignalParamsSchema,
  type QuotaSignalParams,
} from '@otheater/protocol';
import { parsePrompt, parseScriptSpec, ScriptError } from './scripts.js';

interface Recorded {
  updates: SessionUpdate[];
  permissions: RequestPermissionRequest[];
  quota: QuotaSignalParams[];
}

interface Harness {
  cx: ClientContext;
  recorded: Recorded;
  cwd: string;
  sessionId: string;
}

let sandbox: string;
let cwd: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'fake-agent-test-'));
  cwd = join(sandbox, 'session');
  await mkdir(cwd);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function recordingClient(permission: 'allow' | 'reject') {
  const recorded: Recorded = { updates: [], permissions: [], quota: [] };
  const app = client({ name: 'fake-agent-test' })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      recorded.permissions.push(params);
      const wanted = permission === 'allow' ? 'allow_once' : 'reject_once';
      const option = params.options.find((candidate) => candidate.kind === wanted);
      if (option === undefined) throw new Error(`no ${wanted} option offered`);
      return { outcome: { outcome: 'selected' as const, optionId: option.optionId } };
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      recorded.updates.push(params.update);
    })
    .onNotification(QUOTA_SIGNAL_METHOD, quotaSignalParamsSchema, ({ params }) => {
      recorded.quota.push(params);
    });
  return { app, recorded };
}

/** Connects a test client to `target` (an in-process agent or a stream) and opens a session. */
async function withSession<T>(
  target: AgentApp | Stream,
  fn: (harness: Harness) => Promise<T>,
  permission: 'allow' | 'reject' = 'allow',
): Promise<T> {
  const { app, recorded } = recordingClient(permission);
  return app.connectWith(target, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1 });
    const { sessionId } = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
    return fn({ cx, recorded, cwd, sessionId });
  });
}

function prompt(h: Harness, text: string): Promise<PromptResponse> {
  return h.cx.request(methods.agent.session.prompt, {
    sessionId: h.sessionId,
    prompt: [{ type: 'text', text }],
  });
}

async function rejection(promise: Promise<unknown>): Promise<RequestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  throw new Error('expected the request to be rejected');
}

function agentText(updates: SessionUpdate[]): string {
  return updates
    .map((u) =>
      u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? u.content.text : '',
    )
    .join('');
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('timed out waiting for the condition');
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('script parsing', () => {
  it('reads a bare name, name plus options and full JSON', () => {
    expect(parseScriptSpec('echo')).toEqual({ name: 'echo' });
    expect(parseScriptSpec('edit-file {"path":"a.txt"}')).toMatchObject({
      name: 'edit-file',
      path: 'a.txt',
    });
    expect(parseScriptSpec('{"name":"fail","message":"boom"}')).toEqual({
      name: 'fail',
      message: 'boom',
    });
  });

  it('rejects unknown names, unknown options and malformed JSON', () => {
    expect(() => parseScriptSpec('nope')).toThrow(ScriptError);
    expect(() => parseScriptSpec('echo {"extra":1}')).toThrow(ScriptError);
    expect(() => parseScriptSpec('echo {oops')).toThrow(ScriptError);
    expect(() => parseScriptSpec('')).toThrow(ScriptError);
  });

  it('splits the directive line from the prompt text', () => {
    expect(parsePrompt('#script:echo\nhello')).toEqual({ script: { name: 'echo' }, text: 'hello' });
    expect(parsePrompt('hello')).toEqual({ script: undefined, text: 'hello' });
  });
});

describe('fake agent in process', () => {
  it('initializes with minimal capabilities', async () => {
    await withSession(createFakeAgent(), async ({ cx }) => {
      const response = await cx.request(methods.agent.initialize, { protocolVersion: 1 });
      expect(response.protocolVersion).toBe(1);
      expect(response.agentCapabilities?.loadSession).toBe(true);
      expect(response.agentInfo?.name).toBe('otheater-fake-agent');
      await cx.request(methods.agent.authenticate, { methodId: 'none' });
    });
  });

  it('echo streams the prompt text and ends the turn', async () => {
    await withSession(createFakeAgent(), async (h) => {
      const response = await prompt(h, '#script:echo\nhello brave new world');
      expect(response.stopReason).toBe('end_turn');
      await waitFor(() => agentText(h.recorded.updates) === 'hello brave new world');
      expect(h.recorded.updates.length).toBeGreaterThan(1);
    });
  });

  it('plays echo when there is no directive', async () => {
    await withSession(createFakeAgent(), async (h) => {
      await prompt(h, 'just text');
      await waitFor(() => agentText(h.recorded.updates) === 'just text');
    });
  });

  it('uses the default script option for prompts without a directive', async () => {
    const app = createFakeAgent({ defaultScript: parseScriptSpec('tool-call') });
    await withSession(app, async (h) => {
      await prompt(h, 'anything');
      await waitFor(() => h.recorded.updates.some((u) => u.sessionUpdate === 'tool_call_update'));
    });
  });

  it('tool-call emits a tool call and a completed update', async () => {
    await withSession(createFakeAgent(), async (h) => {
      const response = await prompt(h, '#script:tool-call {"title":"Run it","output":"done"}');
      expect(response.stopReason).toBe('end_turn');
      await waitFor(() => h.recorded.updates.length === 2);
      const [call, done] = h.recorded.updates;
      expect(call).toMatchObject({ sessionUpdate: 'tool_call', title: 'Run it' });
      expect(done).toMatchObject({
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        rawOutput: 'done',
      });
      expect(call && 'toolCallId' in call && call.toolCallId).toBe(
        done && 'toolCallId' in done && done.toolCallId,
      );
    });
  });

  it('edit-file writes inside the cwd after permission is granted', async () => {
    await withSession(createFakeAgent(), async (h) => {
      const response = await prompt(
        h,
        '#script:edit-file {"path":"nested/out.txt","content":"hello\\n"}',
      );
      expect(response.stopReason).toBe('end_turn');
      expect(await readFile(join(cwd, 'nested', 'out.txt'), 'utf8')).toBe('hello\n');
      expect(h.recorded.permissions).toHaveLength(1);
      expect(h.recorded.permissions[0]?.toolCall.kind).toBe('edit');
      await waitFor(() => h.recorded.updates.some((u) => u.sessionUpdate === 'tool_call_update'));
      const last = h.recorded.updates.at(-1);
      expect(last).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'completed' });
    });
  });

  it('edit-file writes nothing when permission is denied', async () => {
    await withSession(
      createFakeAgent(),
      async (h) => {
        const response = await prompt(h, '#script:edit-file {"path":"denied.txt"}');
        expect(response.stopReason).toBe('end_turn');
        expect(h.recorded.permissions).toHaveLength(1);
        expect(await exists(join(cwd, 'denied.txt'))).toBe(false);
        await waitFor(() => h.recorded.updates.at(-1)?.sessionUpdate === 'tool_call_update');
        expect(h.recorded.updates.at(-1)).toMatchObject({ status: 'failed' });
      },
      'reject',
    );
  });

  it('write-file writes inside the cwd without asking for permission, even when asks are rejected', async () => {
    await withSession(
      createFakeAgent(),
      async (h) => {
        const response = await prompt(
          h,
          '#script:write-file {"path":"nested/out.txt","content":"hello\\n"}',
        );
        expect(response.stopReason).toBe('end_turn');
        expect(await readFile(join(cwd, 'nested', 'out.txt'), 'utf8')).toBe('hello\n');
        expect(h.recorded.permissions).toHaveLength(0);
        await waitFor(() => h.recorded.updates.length === 2);
        const [call, done] = h.recorded.updates;
        expect(call).toMatchObject({
          sessionUpdate: 'tool_call',
          kind: 'edit',
          status: 'in_progress',
          locations: [{ path: (await realpath(join(cwd, 'nested'))) + sep + 'out.txt' }],
        });
        expect(done).toMatchObject({
          sessionUpdate: 'tool_call_update',
          status: 'completed',
          content: [{ type: 'diff', oldText: null, newText: 'hello\n' }],
        });
      },
      'reject',
    );
  });

  it('write-file refuses paths outside the cwd without writing', async () => {
    const outside = join(sandbox, 'outside');
    await mkdir(outside);
    await symlink(outside, join(cwd, 'link'));
    await withSession(createFakeAgent(), async (h) => {
      for (const path of ['../escape.txt', join(sandbox, 'abs.txt'), 'link/escape.txt']) {
        h.recorded.updates.length = 0;
        const response = await prompt(h, `#script:write-file ${JSON.stringify({ path })}`);
        expect(response.stopReason).toBe('end_turn');
        await waitFor(() => h.recorded.updates.length === 1);
        expect(h.recorded.updates[0]).toMatchObject({
          sessionUpdate: 'tool_call',
          status: 'failed',
        });
      }
      expect(h.recorded.permissions).toHaveLength(0);
      expect(await exists(join(sandbox, 'escape.txt'))).toBe(false);
      expect(await exists(join(sandbox, 'abs.txt'))).toBe(false);
      expect(await exists(join(outside, 'escape.txt'))).toBe(false);
    });
  });

  it('probe says what the system answered to a write, a read and a connection', async () => {
    const present = join(cwd, 'present.txt');
    await writeFile(present, 'abc');
    const server = createServer((socket) => socket.end());
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    await withSession(createFakeAgent(), async (h) => {
      const spec = {
        write: [join(cwd, 'new.txt'), join(sandbox, 'no-such-dir', 'x.txt')],
        read: [present, join(sandbox, 'missing.txt')],
        connect: [`127.0.0.1:${String(port)}`],
      };
      const response = await prompt(h, `#script:probe ${JSON.stringify(spec)}`);
      expect(response.stopReason).toBe('end_turn');
      await waitFor(() => agentText(h.recorded.updates).includes('probe connect'));
      const text = agentText(h.recorded.updates);
      expect(text).toContain(`probe write ${join(cwd, 'new.txt')}: ok`);
      expect(text).toContain('x.txt: failed ENOENT');
      expect(text).toContain(`probe read ${present}: ok 3 bytes`);
      expect(text).toContain('missing.txt: failed ENOENT');
      expect(text).toContain(`probe connect 127.0.0.1:${String(port)}: ok`);
    });
    await new Promise<void>((done) =>
      server.close(() => {
        done();
      }),
    );
  });

  it('edit-file refuses paths outside the cwd without asking for permission', async () => {
    const outside = join(sandbox, 'outside');
    await mkdir(outside);
    await symlink(outside, join(cwd, 'link'));
    await withSession(createFakeAgent(), async (h) => {
      for (const path of ['../escape.txt', join(sandbox, 'abs.txt'), 'link/escape.txt']) {
        h.recorded.updates.length = 0;
        const response = await prompt(h, `#script:edit-file ${JSON.stringify({ path })}`);
        expect(response.stopReason).toBe('end_turn');
        await waitFor(() => h.recorded.updates.length === 1);
        expect(h.recorded.updates[0]).toMatchObject({
          sessionUpdate: 'tool_call',
          status: 'failed',
        });
      }
      expect(h.recorded.permissions).toHaveLength(0);
      expect(await exists(join(sandbox, 'escape.txt'))).toBe(false);
      expect(await exists(join(sandbox, 'abs.txt'))).toBe(false);
      expect(await exists(join(outside, 'escape.txt'))).toBe(false);
    });
  });

  it('fail returns a JSON-RPC error', async () => {
    await withSession(createFakeAgent(), async (h) => {
      const error = await rejection(prompt(h, '#script:fail {"message":"boom"}'));
      expect(error.code).toBe(-32603);
      expect(error.message).toContain('boom');
    });
  });

  it('hang waits for session/cancel and then reports cancelled', async () => {
    await withSession(createFakeAgent(), async (h) => {
      const pending = prompt(h, '#script:hang');
      await waitFor(() => h.recorded.updates.length > 0);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await new Promise((done) => setTimeout(done, 50));
      expect(settled).toBe(false);
      await h.cx.notify(methods.agent.session.cancel, { sessionId: h.sessionId });
      expect((await pending).stopReason).toBe('cancelled');
    });
  });

  it('deaf ignores session/cancel and announces the child it leaves running', async () => {
    await withSession(createFakeAgent(), async (h) => {
      let settled = false;
      // The turn never ends: it rejects when the connection closes at the end of the test.
      void prompt(h, '#script:deaf {"child":true}').then(
        () => {
          settled = true;
        },
        () => undefined,
      );
      await waitFor(() => JSON.stringify(h.recorded.updates).includes('ignoring session/cancel'));
      const text = JSON.stringify(h.recorded.updates);
      const pid = Number(/child pid (\d+)/.exec(text)?.[1]);
      expect(Number.isInteger(pid)).toBe(true);
      await h.cx.notify(methods.agent.session.cancel, { sessionId: h.sessionId });
      await new Promise((done) => setTimeout(done, 100));
      expect(settled).toBe(false);
      // The child is a real process of this test: the signal 0 only checks that it is there.
      expect(() => process.kill(pid, 0)).not.toThrow();
      process.kill(pid, 'SIGKILL');
    });
  });

  it('quota-signal emits the extension notification and then fails with QuotaExhausted', async () => {
    await withSession(createFakeAgent(), async (h) => {
      const error = await rejection(
        prompt(h, '#script:quota-signal {"resetsAt":"2026-11-16T20:00:00Z"}'),
      );
      expect(error.code).toBe(QUOTA_EXHAUSTED_CODE);
      expect(quotaExhaustedDataSchema.parse(error.data)).toEqual({
        type: 'QuotaExhausted',
        resetsAt: '2026-11-16T20:00:00Z',
      });
      await waitFor(() => h.recorded.quota.length === 2);
      expect(h.recorded.quota.map((entry) => entry.signal)).toEqual([
        { kind: 'window', window: '5h', usedPercent: 100, resetsAt: '2026-11-16T20:00:00Z' },
        { kind: 'limit_hit', source: 'fake-agent', resetsAt: '2026-11-16T20:00:00Z' },
      ]);
      expect(h.recorded.quota.every((entry) => entry.sessionId === h.sessionId)).toBe(true);
    });
  });

  it('rejects an invalid script and an unknown session', async () => {
    await withSession(createFakeAgent(), async (h) => {
      expect((await rejection(prompt(h, '#script:nope'))).code).toBe(-32602);
      expect((await rejection(prompt(h, '#script:echo {"x":1}'))).code).toBe(-32602);
      const unknown = h.cx.request(methods.agent.session.prompt, {
        sessionId: 'missing',
        prompt: [{ type: 'text', text: 'hi' }],
      });
      expect((await rejection(unknown)).code).toBe(-32002);
    });
  });

  it('loads a session by id', async () => {
    const { app, recorded } = recordingClient('allow');
    await app.connectWith(createFakeAgent(), async (cx) => {
      await cx.request(methods.agent.initialize, { protocolVersion: 1 });
      await cx.request(methods.agent.session.load, {
        sessionId: 'old-session',
        cwd,
        mcpServers: [],
      });
      const response = await cx.request(methods.agent.session.prompt, {
        sessionId: 'old-session',
        prompt: [{ type: 'text', text: 'again' }],
      });
      expect(response.stopReason).toBe('end_turn');
    });
    expect(agentText(recorded.updates)).toBe('again');
  });

  describe('several sessions in one agent', () => {
    /** A client that keeps the updates and the permission requests by the session they name. */
    function bySessionClient() {
      const updates = new Map<string, string[]>();
      const permissions: string[] = [];
      const app = client({ name: 'fake-agent-multi' })
        .onRequest(methods.client.session.requestPermission, ({ params }) => {
          permissions.push(params.sessionId);
          const option = params.options.find((candidate) => candidate.kind === 'allow_once');
          if (option === undefined) throw new Error('no allow_once option offered');
          return { outcome: { outcome: 'selected' as const, optionId: option.optionId } };
        })
        .onNotification(methods.client.session.update, ({ params }) => {
          const { update } = params;
          if (update.sessionUpdate !== 'agent_message_chunk') return;
          if (update.content.type !== 'text') return;
          updates.set(params.sessionId, [
            ...(updates.get(params.sessionId) ?? []),
            update.content.text,
          ]);
        });
      return { app, updates, permissions };
    }

    const promptOf = (sessionId: string, text: string) => ({
      sessionId,
      prompt: [{ type: 'text' as const, text }],
    });

    it('keeps the streams apart: each update names the session it belongs to', async () => {
      const { app, updates } = bySessionClient();
      await app.connectWith(createFakeAgent(), async (cx) => {
        await cx.request(methods.agent.initialize, { protocolVersion: 1 });
        const a = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        const b = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        expect(a.sessionId).not.toBe(b.sessionId);
        await Promise.all([
          cx.request(methods.agent.session.prompt, promptOf(a.sessionId, 'alpha alpha')),
          cx.request(methods.agent.session.prompt, promptOf(b.sessionId, 'beta beta')),
        ]);
        expect((updates.get(a.sessionId) ?? []).join('')).toBe('alpha alpha');
        expect((updates.get(b.sessionId) ?? []).join('')).toBe('beta beta');
      });
    });

    it('a session cancelled while another keeps running leaves the other untouched', async () => {
      const { app, updates } = bySessionClient();
      await app.connectWith(createFakeAgent(), async (cx) => {
        await cx.request(methods.agent.initialize, { protocolVersion: 1 });
        const a = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        const b = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        const hangA: Promise<PromptResponse> = cx.request(
          methods.agent.session.prompt,
          promptOf(a.sessionId, '#script:hang\n'),
        );
        const hangB: Promise<PromptResponse> = cx.request(
          methods.agent.session.prompt,
          promptOf(b.sessionId, '#script:hang\n'),
        );
        let bEnded = false;
        void hangB.then(() => {
          bEnded = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await cx.notify(methods.agent.session.cancel, { sessionId: a.sessionId });
        expect((await hangA).stopReason).toBe('cancelled');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(bEnded).toBe(false);
        // The session that went on still answers, and it is the one that ends next.
        await cx.notify(methods.agent.session.cancel, { sessionId: b.sessionId });
        expect((await hangB).stopReason).toBe('cancelled');
        expect(updates.has(a.sessionId)).toBe(true);
      });
    });

    it('a permission request names the session of its turn', async () => {
      const { app, permissions } = bySessionClient();
      await app.connectWith(createFakeAgent(), async (cx) => {
        await cx.request(methods.agent.initialize, { protocolVersion: 1 });
        const a = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        const b = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        await cx.request(
          methods.agent.session.prompt,
          promptOf(b.sessionId, '#script:edit-file {"path":"from-b.txt"}\n'),
        );
        expect(permissions).toEqual([b.sessionId]);
        expect(existsSync(join(cwd, 'from-b.txt'))).toBe(true);
        expect(a.sessionId).not.toBe(b.sessionId);
      });
    });

    it('a failed turn of one session does not end the agent or the other sessions', async () => {
      const { app, updates } = bySessionClient();
      await app.connectWith(createFakeAgent(), async (cx) => {
        await cx.request(methods.agent.initialize, { protocolVersion: 1 });
        const a = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        const b = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        await rejection(
          cx.request(methods.agent.session.prompt, promptOf(a.sessionId, '#script:fail\n')),
        );
        await cx.request(methods.agent.session.prompt, promptOf(b.sessionId, 'still fine'));
        expect((updates.get(b.sessionId) ?? []).join('')).toBe('still fine');
      });
    });
  });

  it('offers the model, mode and effort config options and applies set_config_option', async () => {
    const { app } = recordingClient('allow');
    await app.connectWith(createFakeAgent(), async (cx) => {
      await cx.request(methods.agent.initialize, { protocolVersion: 1 });
      const created = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      const ids = (created.configOptions ?? []).map((option) => option.id);
      expect(ids).toEqual(['model', 'mode', 'effort']);
      expect(created.configOptions?.find((option) => option.id === 'effort')).toMatchObject({
        category: 'thought_level',
        currentValue: 'medium',
      });
      const changed = await cx.request(methods.agent.session.setConfigOption, {
        sessionId: created.sessionId,
        configId: 'model',
        value: 'fake-model-2',
      });
      expect(changed.configOptions.find((option) => option.id === 'model')).toMatchObject({
        currentValue: 'fake-model-2',
      });
    });
  });

  it('rejects set_config_option for an unknown option or value with invalid params', async () => {
    const { app } = recordingClient('allow');
    await app.connectWith(createFakeAgent(), async (cx) => {
      await cx.request(methods.agent.initialize, { protocolVersion: 1 });
      const { sessionId } = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      const unknownOption = cx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'nope',
        value: 'x',
      });
      expect((await rejection(unknownOption)).code).toBe(-32602);
      const unknownValue = cx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'model',
        value: 'nope',
      });
      expect((await rejection(unknownValue)).code).toBe(-32602);
    });
  });

  it('says nothing during set_config_option by default', async () => {
    await withSession(createFakeAgent(), async (h) => {
      await h.cx.request(methods.agent.session.setConfigOption, {
        sessionId: h.sessionId,
        configId: 'model',
        value: 'fake-model-2',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.recorded.updates).toEqual([]);
    });
  });

  it('with updatesOnConfig, announces commands before the set_config_option response', async () => {
    await withSession(createFakeAgent({ updatesOnConfig: true }), async (h) => {
      await h.cx.request(methods.agent.session.setConfigOption, {
        sessionId: h.sessionId,
        configId: 'model',
        value: 'fake-model-2',
      });
      await waitFor(() => h.recorded.updates.length === 1);
      expect(h.recorded.updates[0]).toMatchObject({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'fake-command' }],
      });
    });
  });

  it('runs over a pair of byte streams', async () => {
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const connection = connectToStreams(createFakeAgent(), toClient.writable, toAgent.readable);
    await withSession(ndJsonStream(toAgent.writable, toClient.readable), async (h) => {
      expect((await prompt(h, 'over streams')).stopReason).toBe('end_turn');
      await waitFor(() => agentText(h.recorded.updates) === 'over streams');
    });
    connection.close();
    await connection.closed;
  });
});

describe('fake-agent binary over stdio', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

  async function withProcess<T>(
    env: Record<string, string>,
    fn: (h: Harness) => Promise<T>,
  ): Promise<T> {
    if (!existsSync(cli)) throw new Error('dist/cli.js not found: run `pnpm build` first');
    const child = spawn(process.execPath, [cli], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const exited = new Promise<void>((done) =>
      child.once('exit', () => {
        done();
      }),
    );
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    try {
      return await withSession(stream, fn);
    } finally {
      child.stdin.end();
      const timer = setTimeout(() => {
        child.kill();
      }, 2000);
      await exited;
      clearTimeout(timer);
    }
  }

  it('plays echo and edit-file through a subprocess', async () => {
    await withProcess({}, async (h) => {
      expect((await prompt(h, 'via stdio')).stopReason).toBe('end_turn');
      await waitFor(() => agentText(h.recorded.updates) === 'via stdio');
      const edit = await prompt(h, '#script:edit-file {"path":"cli.txt","content":"from cli"}');
      expect(edit.stopReason).toBe('end_turn');
      expect(await readFile(join(cwd, 'cli.txt'), 'utf8')).toBe('from cli');
    });
  });

  it('takes the default script from FAKE_AGENT_SCRIPT', async () => {
    await withProcess({ FAKE_AGENT_SCRIPT: 'fail {"message":"env failure"}' }, async (h) => {
      const error = await rejection(prompt(h, 'anything'));
      expect(error.message).toContain('env failure');
    });
  });

  it('takes updatesOnConfig from FAKE_AGENT_UPDATES_ON_CONFIG', async () => {
    await withProcess({ FAKE_AGENT_UPDATES_ON_CONFIG: '1' }, async (h) => {
      await h.cx.request(methods.agent.session.setConfigOption, {
        sessionId: h.sessionId,
        configId: 'mode',
        value: 'plan',
      });
      await waitFor(() => h.recorded.updates.length === 1);
      expect(h.recorded.updates[0]).toMatchObject({ sessionUpdate: 'available_commands_update' });
    });
  });

  it('exits with an error for an invalid FAKE_AGENT_SCRIPT', async () => {
    if (!existsSync(cli)) throw new Error('dist/cli.js not found: run `pnpm build` first');
    const child = spawn(process.execPath, [cli], {
      env: { ...process.env, FAKE_AGENT_SCRIPT: 'nope' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const code = await new Promise<number | null>((done) => child.once('exit', done));
    expect(code).toBe(1);
    expect(stderr).toContain('invalid script');
  });
});
