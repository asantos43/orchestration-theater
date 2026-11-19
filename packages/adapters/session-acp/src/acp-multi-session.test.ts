// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SharedProcessRegistry,
  type AgentSession,
  type KillReport,
  type LaunchedProcess,
  type LaunchOptions,
  type NormalizedUpdate,
  type SessionExtensionHandler,
  type SessionNormalizer,
  type SessionOpenParams,
} from '@otheater/core';
import { normalizeFakeError, normalizeFakeUpdate } from '@otheater/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AcpTransport,
  type AcpTransportOptions,
  type AcpTransportWarning,
} from './acp-transport.js';
import { NodeProcessLauncher } from './testing/node-process-launcher.js';
import { removeDir } from './testing/remove-dir.js';

// One connection, several sessions: `AcpTransport` against a stub agent that serves any number of
// sessions in one process (raw JSON-RPC on stdio). The prompt text picks what the stub does, so
// each test says exactly what the agent sends and about which session.

const STUB = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const cfg = JSON.parse(process.env.STUB_CONFIG ?? '{}');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const record = (entry) => appendFileSync(cfg.recordTo, JSON.stringify(entry) + '\n');
const chunk = (sessionId, text) =>
  send({
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });
let created = 0;
let outgoing = 1000;
const hanging = new Map();
const waiting = new Map();
// A request the stub sent to the client; the answer resumes the turn that asked.
const ask = (method, params, then) => {
  const id = outgoing++;
  waiting.set(id, then);
  send({ id, method, params });
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    // An answer to a request of the stub.
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  record({ method: message.method, params: message.params });
  switch (message.method) {
    case 'initialize':
      send({
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          agentCapabilities: { loadSession: true },
          authMethods: [],
        },
      });
      return;
    case 'session/new': {
      if (cfg.silentNewFrom !== undefined && created >= cfg.silentNewFrom) return;
      created += 1;
      send({ id: message.id, result: { sessionId: cfg.fixedId ?? 'stub-' + created } });
      return;
    }
    case 'session/load':
      send({ id: message.id, result: {} });
      return;
    case 'session/cancel': {
      const turn = hanging.get(message.params.sessionId);
      if (turn !== undefined) {
        hanging.delete(message.params.sessionId);
        send({ id: turn, result: { stopReason: 'cancelled' } });
      }
      return;
    }
    case 'session/prompt': {
      const { sessionId } = message.params;
      const text = message.params.prompt.map((block) => block.text ?? '').join('');
      const done = () => send({ id: message.id, result: { stopReason: 'end_turn' } });
      if (text === 'hang') {
        hanging.set(sessionId, message.id);
      } else if (text === 'exit') {
        process.exit(3);
      } else if (text.startsWith('say:')) {
        chunk(sessionId, text.slice(4));
        done();
      } else if (text.startsWith('about:')) {
        // An update about ANOTHER session id, then the turn of this one ends.
        chunk(text.slice(6), 'for-someone-else');
        done();
      } else if (text === 'ask') {
        ask(
          'session/request_permission',
          {
            sessionId,
            toolCall: { toolCallId: 'tool-1', title: 'Write', kind: 'edit' },
            options: [
              { optionId: 'allow-' + sessionId, name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject-' + sessionId, name: 'Reject', kind: 'reject_once' },
            ],
          },
          (answer) => {
            record({ method: 'permission-answer', params: { sessionId, answer: answer.result } });
            done();
          },
        );
      } else if (text === 'ext') {
        ask('_otheater/ping', { sessionId }, (answer) => {
          record({ method: 'ext-answer', params: { sessionId, answer } });
          done();
        });
      } else if (text === 'stray') {
        chunk('ghost', 'nobody owns this');
        ask(
          'session/request_permission',
          {
            sessionId: 'ghost',
            toolCall: { toolCallId: 'tool-9', title: 'Write', kind: 'edit' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
          (answer) => {
            record({ method: 'permission-answer', params: { sessionId: 'ghost', answer: answer.result } });
            done();
          },
        );
      } else {
        done();
      }
      return;
    }
    default:
      return;
  }
});
`;

const normalizer: SessionNormalizer = {
  normalizeUpdate: normalizeFakeUpdate,
  normalizeError: normalizeFakeError,
};

const NOT_KILLED: KillReport = { found: 0, forced: false, remaining: [] };

let dir: string;
let stubPath: string;
const launcher = new NodeProcessLauncher();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otheater-acp-multi-'));
  stubPath = join(dir, 'stub-agent.mjs');
  await writeFile(stubPath, STUB);
});

afterAll(async () => {
  expect(launcher.aliveGroups()).toBe(0);
  await removeDir(dir);
});

let counter = 0;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0)) await task();
  await launcher.killAll();
});

interface Rig {
  readonly record: string;
  readonly spec: LaunchOptions;
  readonly registry: SharedProcessRegistry;
}

/** What the sessions of one stub process share: the launch spec and the registry that leases the process. */
function rig(config: Record<string, unknown> = {}): Rig {
  counter += 1;
  const record = join(dir, `multi-${String(counter)}.jsonl`);
  return {
    record,
    spec: {
      cmd: globalThis.process.execPath,
      args: [stubPath],
      cwd: dir,
      env: { STUB_CONFIG: JSON.stringify({ recordTo: record, ...config }) },
    },
    registry: new SharedProcessRegistry(launcher, 8),
  };
}

const openParams = (
  process: LaunchedProcess,
  extra: Partial<SessionOpenParams> & { onPermissionId?: string } = {},
): SessionOpenParams => {
  const { onPermissionId, ...rest } = extra;
  return {
    process,
    cwd: dir,
    setup: { via: 'acp', configOptions: {} },
    mcpServers: [],
    normalizer,
    onPermission: (request) => ({
      outcome: 'selected',
      optionId: `${onPermissionId ?? 'unset'}:${request.options[0]?.optionId ?? ''}`,
    }),
    ...rest,
  };
};

/** Opens a session of `transport` on the process of `r`, with a lease of its own, as the base does. */
async function openOn(
  transport: AcpTransport,
  r: Rig,
  extra: Partial<SessionOpenParams> & { onPermissionId?: string } = {},
): Promise<AgentSession> {
  const process = await r.registry.acquire('stub', r.spec);
  try {
    return await transport.open(openParams(process, extra));
  } catch (error) {
    // What the base does when a transport refuses the session: the lease goes back.
    await process.killTree({ graceMs: 200 });
    throw error;
  }
}

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

async function recorded(file: string): Promise<RecordedCall[]> {
  const raw = await readFile(file, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RecordedCall);
}

const text = (update: NormalizedUpdate): string =>
  update.kind === 'agent_message_chunk' && update.content.type === 'text'
    ? update.content.text
    : '';

function listen(session: AgentSession): string[] {
  const seen: string[] = [];
  session.onUpdate((update) => seen.push(text(update)));
  return seen;
}

const say = (word: string) => [{ type: 'text' as const, text: `say:${word}` }];
const plain = (word: string) => [{ type: 'text' as const, text: word }];

function transportOf(options: AcpTransportOptions = {}): {
  transport: AcpTransport;
  warnings: AcpTransportWarning[];
} {
  const warnings: AcpTransportWarning[] = [];
  return {
    transport: new AcpTransport({
      cancelGraceMs: 100,
      killGraceMs: 500,
      startTimeoutMs: 3000,
      onWarning: (warning) => warnings.push(warning),
      ...options,
    }),
    warnings,
  };
}

describe('AcpTransport, several sessions on one process', () => {
  it('initializes once and gives each session its own id', async () => {
    const r = rig();
    const { transport } = transportOf();
    const a = await openOn(transport, r);
    const b = await openOn(transport, r);
    expect(a.sessionId).toBe('stub-1');
    expect(b.sessionId).toBe('stub-2');
    const calls = (await recorded(r.record)).map((entry) => entry.method);
    expect(calls.filter((method) => method === 'initialize')).toHaveLength(1);
    expect(calls.filter((method) => method === 'session/new')).toHaveLength(2);
    await a.close();
    await b.close();
  });

  it('routes session/update by sessionId: each listener hears only its own session', async () => {
    const r = rig();
    const { transport, warnings } = transportOf();
    const a = await openOn(transport, r);
    const b = await openOn(transport, r);
    const seenA = listen(a);
    const seenB = listen(b);
    await Promise.all([a.prompt(say('alpha')), b.prompt(say('beta'))]);
    expect(seenA).toEqual(['alpha']);
    expect(seenB).toEqual(['beta']);
    expect(warnings).toEqual([]);
    await a.close();
    await b.close();
  });

  it('routes session/request_permission by sessionId, to the policy of that session', async () => {
    const r = rig();
    const { transport } = transportOf();
    const a = await openOn(transport, r, { onPermissionId: 'A' });
    const b = await openOn(transport, r, { onPermissionId: 'B' });
    await Promise.all([a.prompt(plain('ask')), b.prompt(plain('ask'))]);
    const answers = (await recorded(r.record)).filter(
      (entry) => entry.method === 'permission-answer',
    );
    const bySession = Object.fromEntries(
      answers.map((entry) => [
        entry.params.sessionId as string,
        (entry.params.answer as { outcome: { optionId: string } }).outcome.optionId,
      ]),
    );
    expect(bySession).toEqual({ 'stub-1': 'A:allow-stub-1', 'stub-2': 'B:allow-stub-2' });
    await a.close();
    await b.close();
  });

  it('routes _otheater/* requests by sessionId, to the handlers of that session', async () => {
    const r = rig();
    const { transport } = transportOf();
    const handler = (name: string): SessionExtensionHandler => ({
      method: '_otheater/ping',
      handle: () => ({ pong: name }),
    });
    const a = await openOn(transport, r, { extensions: [handler('A')] });
    const b = await openOn(transport, r, { extensions: [handler('B')] });
    // A session without a handler for the method gets method-not-found, as with one session.
    const c = await openOn(transport, r);
    await Promise.all([a.prompt(plain('ext')), b.prompt(plain('ext')), c.prompt(plain('ext'))]);
    const answers = (await recorded(r.record)).filter((entry) => entry.method === 'ext-answer');
    const bySession = Object.fromEntries(
      answers.map((entry) => [entry.params.sessionId as string, entry.params.answer]),
    );
    expect(bySession['stub-1']).toMatchObject({ result: { pong: 'A' } });
    expect(bySession['stub-2']).toMatchObject({ result: { pong: 'B' } });
    expect(bySession['stub-3']).toMatchObject({ error: { code: -32601 } });
    await a.close();
    await b.close();
    await c.close();
  });

  it('an update or a permission request for a session it never had is dropped and reported', async () => {
    const r = rig();
    const { transport, warnings } = transportOf();
    const a = await openOn(transport, r);
    const b = await openOn(transport, r);
    const seenA = listen(a);
    const seenB = listen(b);
    await a.prompt(plain('stray'));
    expect(seenA).toEqual([]);
    expect(seenB).toEqual([]);
    // The permission request of an unknown session is answered "cancelled", never allowed.
    const answers = (await recorded(r.record)).filter(
      (entry) => entry.method === 'permission-answer',
    );
    expect(answers[0]?.params.answer).toMatchObject({ outcome: { outcome: 'cancelled' } });
    expect(warnings).toEqual([
      { kind: 'unknown_session', method: 'session/update', sessionId: 'ghost' },
      { kind: 'unknown_session', method: 'session/request_permission', sessionId: 'ghost' },
    ]);
    // The sessions that exist keep working.
    await expect(b.prompt(say('fine'))).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(seenB).toEqual(['fine']);
    await a.close();
    await b.close();
  });

  it('a late update of a session that already left is dropped without a warning', async () => {
    const r = rig();
    const { transport, warnings } = transportOf();
    const a = await openOn(transport, r);
    const b = await openOn(transport, r);
    const seenB = listen(b);
    await a.close();
    await b.prompt(plain(`about:${a.sessionId}`));
    expect(seenB).toEqual([]);
    expect(warnings).toEqual([]);
    await b.close();
  });

  it('closing a session keeps the connection for the others; the last one closes it', async () => {
    const r = rig();
    const { transport } = transportOf();
    const a = await openOn(transport, r);
    const b = await openOn(transport, r);
    const seen = listen(b);
    await a.close();
    expect(launcher.aliveGroups()).toBe(1);
    await expect(b.prompt(say('still here'))).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(seen).toEqual(['still here']);
    await b.close();
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('cancel of one session ends its turn; the other turn and the process go on', async () => {
    const r = rig();
    // The stub answers the cancel, and this test is about that answer: with the 100 ms grace of the
    // other tests a loaded runner (seen on main, 2026-11-19) answers late, the transport kills the
    // tree as it should for a deaf client, and the other session dies with it.
    const { transport } = transportOf({ cancelGraceMs: 10_000 });
    const a = await openOn(transport, r);
    const b = await openOn(transport, r);
    const runningA = a.prompt(plain('hang'));
    const runningB = b.prompt(plain('hang'));
    let bEnded = false;
    void runningB.then(() => {
      bEnded = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await a.cancel();
    await expect(runningA).resolves.toMatchObject({ stopReason: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bEnded).toBe(false);
    expect(launcher.aliveGroups()).toBe(1);
    await b.cancel();
    await expect(runningB).resolves.toMatchObject({ stopReason: 'cancelled' });
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('a client that exits drops every session with AdapterUnavailable', async () => {
    const r = rig();
    const { transport } = transportOf();
    const a = await openOn(transport, r);
    const b = await openOn(transport, r);
    const runningB = b.prompt(plain('hang')).then(
      () => undefined,
      (error: unknown) => error,
    );
    const runningA = a.prompt(plain('exit')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(await runningA).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    expect(await runningB).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    await expect(a.prompt(plain('x'))).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    await expect(b.prompt(plain('x'))).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    await a.close();
    await b.close();
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('refuses a session id the connection already serves, and leaves the first one working', async () => {
    const r = rig({ fixedId: 'same' });
    const { transport } = transportOf();
    const a = await openOn(transport, r);
    await expect(openOn(transport, r)).rejects.toMatchObject({ code: 'CONFLICT' });
    const seen = listen(a);
    await expect(a.prompt(say('alone'))).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(seen).toEqual(['alone']);
    await a.close();
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('a start that times out does not take the other sessions down', async () => {
    const r = rig({ silentNewFrom: 1 });
    const { transport } = transportOf({ startTimeoutMs: 300 });
    const a = await openOn(transport, r);
    await expect(openOn(transport, r)).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    const seen = listen(a);
    await expect(a.prompt(say('alive'))).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(seen).toEqual(['alive']);
    expect(launcher.aliveGroups()).toBe(1);
    await a.close();
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('loads a session onto the connection of a process that already serves another', async () => {
    const r = rig();
    const { transport } = transportOf();
    const a = await openOn(transport, r);
    const process = await r.registry.acquire('stub', r.spec);
    const b = await transport.load({ ...openParams(process), sessionId: 'old-conversation' });
    expect(b.sessionId).toBe('old-conversation');
    const seen = listen(b);
    await b.prompt(say('loaded'));
    expect(seen).toEqual(['loaded']);
    const calls = (await recorded(r.record)).map((entry) => entry.method);
    expect(calls.filter((method) => method === 'initialize')).toHaveLength(1);
    await a.close();
    await b.close();
  });
});

describe('AcpTransport connectionLifetime', () => {
  /** A process whose sessions all hold a view that never kills it: the pool of a daemon that keeps an idle process. */
  async function pooled(config: Record<string, unknown> = {}): Promise<{
    process: LaunchedProcess;
    view: () => LaunchedProcess;
    record: string;
  }> {
    counter += 1;
    const record = join(dir, `pool-${String(counter)}.jsonl`);
    const process = await launcher.launch({
      cmd: globalThis.process.execPath,
      args: [stubPath],
      cwd: dir,
      env: { STUB_CONFIG: JSON.stringify({ recordTo: record, ...config }) },
    });
    cleanup.push(() => process.killTree({ graceMs: 200 }));
    return {
      process,
      record,
      view: () => ({
        get pid() {
          return process.pid;
        },
        get stdin() {
          return process.stdin;
        },
        get stdout() {
          return process.stdout;
        },
        get stderr() {
          return process.stderr;
        },
        get exited() {
          return process.exited;
        },
        killTree: () => Promise.resolve(NOT_KILLED),
      }),
    };
  }

  const open = (transport: AcpTransport, process: LaunchedProcess): Promise<AgentSession> =>
    transport.open(openParams(process));

  it('last_session (default): the last session to leave closes the connection, and it is not reused', async () => {
    const pool = await pooled();
    const { transport } = transportOf();
    const a = await open(transport, pool.view());
    const b = await open(transport, pool.view());
    await a.close();
    // `b` still holds the connection: it works.
    await expect(b.prompt(say('b is here'))).resolves.toMatchObject({ stopReason: 'end_turn' });
    await b.close();
    // The connection is gone, so a process kept idle cannot serve a new session through it, and the
    // refusal is a typed error rather than a stream error.
    await expect(open(transport, pool.view())).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
  });

  it('process: the connection outlives its sessions, so an idle process can serve the next one', async () => {
    const pool = await pooled();
    const { transport } = transportOf({ connectionLifetime: 'process' });
    const a = await open(transport, pool.view());
    await a.close();
    const b = await open(transport, pool.view());
    await expect(b.prompt(say('again'))).resolves.toMatchObject({ stopReason: 'end_turn' });
    const calls = (await recorded(pool.record)).map((entry) => entry.method);
    expect(calls.filter((method) => method === 'initialize')).toHaveLength(1);
    await b.close();
  });
});
