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
import { parseConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { QuotaService } from '../quota/service.js';
import { UsageService } from '../usage/service.js';
import { BudgetService } from './service.js';
import { budgetSettingsOf } from './settings.js';

/**
 * The fake agent as a real process, over the ACP stdio wire (the client is the compiled
 * `dist/cli.js`, so `pnpm build` comes first, as for `usage/fake-agent-signals.test.ts`): the
 * `usage` signals it sends go to the `UsageService`, and the `BudgetService` reads the cap of an API
 * profile off the rows (P11 acceptance, architecture 5.6). Nothing real runs: the agent is a script.
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

describe('BudgetService with the usage signals of the fake agent (P11 acceptance)', () => {
  it('warns at 80% of the day and puts the profile in exhausted(budget) when the turns pass the cap', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'budget-fake-agent-'));
    const clock = new FakeClock(Date.UTC(2026, 10, 18, 12));
    const store = new InMemoryStore({ clock });
    await store.profiles.create({
      client: 'claude-code',
      name: 'api',
      kind: 'api',
      provider: 'anthropic',
      dir: '/p/api',
    });
    const logger = createSilentLogger();
    const quota = new QuotaService({
      store,
      clock,
      settings: {
        nearLimitAt: 0.8,
        staleAfterMs: 600_000,
        delivery: 'poll',
        pollEveryMs: 3_600_000,
      },
      logger,
    });
    const usage = new UsageService({
      store,
      clock,
      settings: {
        subscriptionDisplay: 'quota_and_equivalent',
        costSource: 'client_then_pricing',
        monthlyPriceUsd: new Map(),
        pricing: builtInPricing(),
      },
      logger,
    });
    const config = parseConfig('profiles:\n  claude-code/api:\n    budget:\n      daily_usd: 10\n');
    const budget = new BudgetService({
      store,
      clock,
      settings: budgetSettingsOf(config),
      logger,
      quota,
      usage,
    });
    await quota.start();
    await budget.start();
    const warnings: unknown[] = [];
    budget.onWarning((warning) => warnings.push(warning));
    const agent = await openFakeAgent(sandbox);
    try {
      usage.bindSession(agent.sessionId, {
        profile: 'claude-code/api',
        executorId: 'claude-opus-high@claude-code/api',
      });
      let fed = 0;
      const feed = async (count: number): Promise<void> => {
        await expect.poll(() => agent.signals.length, { timeout: 5000 }).toBe(fed + count);
        for (const params of agent.signals.slice(fed)) await usage.ingestNotification(params);
        fed += count;
        await budget.flush();
      };

      // Two turns of US$ 3.5 each: US$ 7, under the 80% of US$ 10.
      await agent.prompt(
        '#script:usage-signal {"model":"claude-opus-5-5","costUsd":3.5,"repeat":2}',
      );
      await feed(2);
      expect(warnings).toEqual([]);
      expect((await quota.statusOf('claude-code/api')).state).not.toBe('exhausted');

      // The third turn takes it to US$ 8.5: the warning, and the profile is still usable.
      await agent.prompt('#script:usage-signal {"model":"claude-opus-5-5","costUsd":1.5}');
      await feed(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        profile: 'claude-code/api',
        period: 'day',
        thresholdFraction: 0.8,
        limitUsd: 10,
      });
      expect((await quota.statusOf('claude-code/api')).state).not.toBe('exhausted');

      // The fourth turn passes the cap: exhausted(budget) until midnight of São Paulo.
      await agent.prompt('#script:usage-signal {"model":"claude-opus-5-5","costUsd":2}');
      await feed(1);
      expect(await quota.statusOf('claude-code/api')).toMatchObject({
        state: 'exhausted',
        cause: 'budget',
        untilReset: Date.UTC(2026, 10, 19, 3),
      });
      expect(warnings).toHaveLength(1);
    } finally {
      await agent.close();
      await budget.stop();
      await quota.stop();
    }
  }, 30_000);
});
