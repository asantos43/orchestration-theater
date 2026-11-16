// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchedProcess, SessionNormalizer, SessionOpenParams } from '@otheater/core';
import { normalizeFakeError, normalizeFakeUpdate } from '@otheater/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AcpTransport, type AcpTransportWarning } from './acp-transport.js';
import { NodeProcessLauncher } from './testing/node-process-launcher.js';
import { removeDir } from './testing/remove-dir.js';

// `AcpTransport` against a stub agent: a few lines of plain Node that speak raw JSON-RPC on stdio,
// so each test can make the agent say exactly what it needs (no `loadSession`, `session/load` that
// answers not-found, silence, an agent that ignores `session/cancel` and leaves a grandchild).

const STUB = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const cfg = JSON.parse(process.env.STUB_CONFIG ?? '{}');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const record = (method, params) => {
  if (cfg.recordTo) appendFileSync(cfg.recordTo, JSON.stringify({ method, params }) + '\n');
};
if (cfg.grandchild) {
  // Same process group (POSIX) or process tree (Windows) as the stub: a tree kill has to reach it.
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  record('grandchild', { pid: grandchild.pid });
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  record(message.method, message.params);
  switch (message.method) {
    case 'initialize':
      if (cfg.silent) return;
      send({
        id: message.id,
        result: {
          protocolVersion: cfg.protocolVersion ?? message.params.protocolVersion,
          agentCapabilities: {
            loadSession: cfg.loadSession === true,
            mcpCapabilities: { http: cfg.http === true },
          },
          authMethods: [],
        },
      });
      return;
    case 'session/new':
      send({ id: message.id, result: { sessionId: 'stub-1' } });
      return;
    case 'session/load':
      send({ id: message.id, error: { code: -32002, message: 'session not found' } });
      return;
    default:
      // session/prompt never answers; session/cancel is ignored on purpose.
      return;
  }
});
`;

const normalizer: SessionNormalizer = {
  normalizeUpdate: normalizeFakeUpdate,
  normalizeError: normalizeFakeError,
};

let dir: string;
let stubPath: string;
const launcher = new NodeProcessLauncher();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otheater-acp-stub-'));
  stubPath = join(dir, 'stub-agent.mjs');
  await writeFile(stubPath, STUB);
});

afterAll(async () => {
  expect(launcher.aliveGroups()).toBe(0);
  await removeDir(dir);
});

const launched: LaunchedProcess[] = [];
afterEach(async () => {
  await Promise.all(launched.splice(0).map((process) => process.killTree({ graceMs: 200 })));
});

interface StubOptions {
  readonly config?: Record<string, unknown>;
  readonly mcpServers?: SessionOpenParams['mcpServers'];
  readonly meta?: unknown;
  readonly configOptions?: Record<string, string>;
}

async function params(
  name: string,
  options: StubOptions = {},
): Promise<{ open: SessionOpenParams; record: string }> {
  const record = join(dir, `${name}.jsonl`);
  const process = await launcher.launch({
    cmd: globalThis.process.execPath,
    args: [stubPath],
    cwd: dir,
    env: { STUB_CONFIG: JSON.stringify({ recordTo: record, ...options.config }) },
  });
  launched.push(process);
  return {
    record,
    open: {
      process,
      cwd: dir,
      setup: {
        via: 'acp',
        ...(options.meta === undefined ? {} : { meta: options.meta }),
        configOptions: options.configOptions ?? {},
      },
      mcpServers: options.mcpServers ?? [],
      normalizer,
      onPermission: () => ({ outcome: 'cancelled' }),
    },
  };
}

/** True while a process with this pid exists (signal 0 only probes). */
function pidAlive(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function recorded(file: string): Promise<{ method: string; params: unknown }[]> {
  const raw = await readFile(file, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { method: string; params: unknown });
}

describe('AcpTransport against a stub agent', () => {
  it('has the id acp', () => {
    expect(new AcpTransport().id).toBe('acp');
  });

  it('announces NO fs and NO terminal capability in initialize', async () => {
    const { open, record } = await params('capabilities');
    const session = await new AcpTransport({ clientVersion: '9.9.9' }).open(open);
    const [initialize] = await recorded(record);
    expect(initialize?.method).toBe('initialize');
    expect(initialize?.params).toMatchObject({
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'otheater', version: '9.9.9' },
    });
    await session.close();
  });

  it('sends cwd, the MCP servers and _meta in session/new', async () => {
    const { open, record } = await params('new', {
      config: { http: true },
      meta: { claudeCode: { options: { settingSources: [] } } },
      mcpServers: [{ name: 'docs', url: 'http://127.0.0.1:9/mcp', headers: { 'x-a': 'b' } }],
    });
    const session = await new AcpTransport().open(open);
    expect(session.sessionId).toBe('stub-1');
    expect(session.canLoad).toBe(false);
    const created = (await recorded(record)).find((entry) => entry.method === 'session/new');
    expect(created?.params).toMatchObject({
      cwd: dir,
      mcpServers: [
        {
          type: 'http',
          name: 'docs',
          url: 'http://127.0.0.1:9/mcp',
          headers: [{ name: 'x-a', value: 'b' }],
        },
      ],
      _meta: { claudeCode: { options: { settingSources: [] } } },
    });
    await session.close();
  });

  it('refuses MCP servers when the client did not announce HTTP', async () => {
    const { open } = await params('no-http', {
      mcpServers: [{ name: 'docs', url: 'http://127.0.0.1:9/mcp' }],
    });
    await expect(new AcpTransport().open(open)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
  });

  it('load rejects with AdapterUnavailable when the client did not announce loadSession', async () => {
    const { open } = await params('no-load');
    await expect(new AcpTransport().load({ ...open, sessionId: 'any' })).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
  });

  it('load of an unknown conversation rejects with NotFound', async () => {
    const { open } = await params('not-found', { config: { loadSession: true } });
    await expect(new AcpTransport().load({ ...open, sessionId: 'gone' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects with AdapterUnavailable when the protocol version is not the one offered', async () => {
    const { open } = await params('version', { config: { protocolVersion: 99 } });
    await expect(new AcpTransport().open(open)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
  });

  it('rejects with AdapterUnavailable when the client stays silent past startTimeoutMs', async () => {
    const { open } = await params('silent', { config: { silent: true } });
    const started = Date.now();
    await expect(new AcpTransport({ startTimeoutMs: 200 }).open(open)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects with AdapterUnavailable when the process ends before answering', async () => {
    const { open } = await params('dies', { config: { silent: true } });
    const opening = new AcpTransport({ startTimeoutMs: 5000 }).open(open);
    const failure = opening.then(
      () => undefined,
      (error: unknown) => error,
    );
    await open.process.killTree({ graceMs: 100 });
    expect(await failure).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });

  it('cancel does not trust the client: the tree is killed, grandchild included', async () => {
    const warnings: AcpTransportWarning[] = [];
    const { open, record } = await params('ignores-cancel', { config: { grandchild: true } });
    const session = await new AcpTransport({
      cancelGraceMs: 100,
      killGraceMs: 500,
      onWarning: (warning) => warnings.push(warning),
    }).open(open);
    const running = session.prompt([{ type: 'text', text: 'hang' }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await session.cancel();
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
    expect(launcher.aliveGroups()).toBe(0);
    // The group/tree check above sees the root (Windows) or the group (POSIX); the grandchild
    // itself is checked by its own pid, on both.
    const grandchild = (await recorded(record)).find((entry) => entry.method === 'grandchild');
    const { pid } = grandchild?.params as { pid: number };
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(pidAlive(pid)).toBe(false);
    });
    expect(warnings).toEqual([]);
  });

  it('close ends the process even though the client never answered a prompt', async () => {
    const { open } = await params('close');
    const session = await new AcpTransport({ killGraceMs: 500 }).open(open);
    const running = session.prompt([{ type: 'text', text: 'hang' }]).then(
      () => 'resolved',
      () => 'rejected',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.close();
    expect(await running).toBe('rejected');
    expect(launcher.aliveGroups()).toBe(0);
  });
});
