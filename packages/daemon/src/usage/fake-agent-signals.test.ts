// SPDX-License-Identifier: MPL-2.0
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { builtInPricing } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { UsageService } from './service.js';

/**
 * The fake agent as a real process, over the ACP stdio wire (the client is the compiled
 * `dist/cli.js`, so `pnpm build` comes first, as for `simulated-acp.test.ts`): the `usage` signals
 * it sends go to the `UsageService` the way the daemon will hand them over, and the acceptance of
 * P10 (architecture 5.6) is read off the rows. Nothing real runs: the agent is a script.
 */
const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));
const QUOTA_SIGNAL_METHOD = '_otheater/quota/signal';

interface Wire {
  readonly signals: unknown[];
  prompt(text: string): Promise<unknown>;
  close(): Promise<void>;
}

/** Opens a session of the fake agent and returns what it sends as quota signals. */
async function openFakeAgent(cwd: string): Promise<Wire & { sessionId: string }> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [FAKE_AGENT_CLI], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '' },
  });
  const signals: unknown[] = [];
  const waiting = new Map<number, (result: unknown) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (message.method === QUOTA_SIGNAL_METHOD) signals.push(message.params);
    else if (message.id !== undefined && message.method === undefined) {
      waiting.get(message.id)?.(message.error ?? message.result);
      waiting.delete(message.id);
    }
  });
  let next = 0;
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      next += 1;
      waiting.set(next, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
    });
  await request('initialize', { protocolVersion: 1 });
  const created = (await request('session/new', { cwd, mcpServers: [] })) as {
    sessionId: string;
  };
  return {
    sessionId: created.sessionId,
    signals,
    prompt: (text) =>
      request('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text }],
      }),
    close: () =>
      new Promise((done) => {
        child.once('exit', () => {
          done();
        });
        child.stdin.end();
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }),
  };
}

beforeAll(() => {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
});

let sandbox: string | undefined;
afterAll(async () => {
  if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true });
});

describe('UsageService with the usage signals of the fake agent (P10 acceptance)', () => {
  it('prices the tokens of an API profile, takes the cost of the client first and never sums a subscription equivalent as spending', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'usage-fake-agent-'));
    const clock = new FakeClock(Date.UTC(2026, 10, 18, 12));
    const store = new InMemoryStore({ clock });
    await store.profiles.create({
      client: 'claude-code',
      name: 'api',
      kind: 'api',
      provider: 'anthropic',
      dir: '/p/api',
    });
    await store.profiles.create({
      client: 'claude-code',
      name: 'work',
      kind: 'token_plan',
      provider: 'anthropic',
      dir: '/p/work',
    });
    const service = new UsageService({
      store,
      clock,
      settings: {
        subscriptionDisplay: 'quota_and_equivalent',
        costSource: 'client_then_pricing',
        monthlyPriceUsd: new Map(),
        pricing: builtInPricing(),
      },
      logger: createSilentLogger(),
    });
    const agent = await openFakeAgent(sandbox);
    try {
      service.bindSession(agent.sessionId, {
        profile: 'claude-code/api',
        executorId: 'claude-opus-high@claude-code/api',
        playId: 'play-1',
      });
      // 1) No cost from the client: the table prices it (1000 x 4 + 200 x 20 per million).
      await agent.prompt('#script:usage-signal {"model":"claude-opus-5-5"}');
      // 2) The client reports its own cost: it wins over the table.
      await agent.prompt('#script:usage-signal {"model":"claude-opus-5-5","costUsd":0.5}');
      // 3) A model with no price: unknown, never 0.
      await agent.prompt('#script:usage-signal {"model":"no-such-model"}');
      await expect.poll(() => agent.signals.length, { timeout: 5000 }).toBe(3);
      for (const params of agent.signals) await service.ingestNotification(params);

      const rows = await store.usage.list({ sessionId: agent.sessionId });
      expect(rows.map((r) => [r.model, r.costSource, r.costKind])).toEqual([
        ['claude-opus-5-5', 'pricing_table', 'real'],
        ['claude-opus-5-5', 'client', 'real'],
        ['no-such-model', null, null],
      ]);
      expect(rows[0]?.costUsd).toBeCloseTo(0.008, 12);
      expect(rows[1]?.costUsd).toBe(0.5);
      expect(rows[2]?.costUsd).toBeNull();

      const totals = await service.totals({ sessionId: agent.sessionId });
      expect(totals.realUsd).toBeCloseTo(0.508, 12);
      expect(totals.unknownCostTurns).toBe(1);
      expect(totals.complete).toBe(false);

      // The same agent on a subscription profile: an equivalent, apart from the spending.
      service.bindSession(agent.sessionId, {
        profile: 'claude-code/work',
        executorId: 'claude-opus-high@claude-code/work',
      });
      await agent.prompt('#script:usage-signal {"model":"claude-opus-5-5"}');
      await expect.poll(() => agent.signals.length, { timeout: 5000 }).toBe(4);
      await service.ingestNotification(agent.signals[3]);
      const everything = await service.totals();
      expect(everything.realUsd).toBeCloseTo(0.508, 12);
      expect(everything.apiEquivalentUsd).toBeCloseTo(0.008, 12);
      expect(
        await service.totals({ sessionId: agent.sessionId, profileId: 'claude-code/api' }),
      ).toEqual(totals);
    } finally {
      await agent.close();
    }
  }, 30_000);
});
