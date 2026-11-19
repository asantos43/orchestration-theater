// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, RolePolicy } from '@otheater/core';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir, TEST_PROFILE } from '../test-helpers.js';
import { makeRepo } from './attempt-fixture.js';
import type { AttemptSpec } from './attempt-runner.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * The framework MCP server (architecture 5.3) end to end: the fake agent over the REAL ACP stdio
 * transport receives the URL and the token of the server in `session/new`, calls the tools with
 * `fetch` and delivers a valid output, and the daemon records `attempt.submitted` in the log of
 * the attempt. The client is the compiled `dist/cli.js`, so `pnpm build` comes first.
 */

const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

const CONFIG = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
limits:
  submit_retries: 1
`);

const WITH_FRAMEWORK: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: ['otheater'],
  mcpTools: { otheater: 'all' },
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

const WITHOUT_FRAMEWORK: RolePolicy = { ...WITH_FRAMEWORK, mcpServers: [] };

beforeAll(() => {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
});
afterAll(disposeTestGitIsolation);

function ofAttempt(events: readonly EventEnvelope[], attemptId: string): readonly EventEnvelope[] {
  return events.filter((event) => event.attemptId === attemptId);
}

function chunksOf(events: readonly EventEnvelope[]): string {
  return events
    .filter((event) => event.type === 'session.update')
    .map((event) => JSON.stringify(event.payload))
    .join('\n');
}

async function withDaemon(
  body: (daemon: DaemonHandle, repo: string) => Promise<void>,
): Promise<void> {
  const tmp = await makeTempDataDir();
  const real = defaultLauncher();
  if (real === undefined) throw new Error('this platform has no process launcher');
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    config: CONFIG,
    overrides: { clock: new FakeClock(), vault: new InMemorySecretVault(), launcher: real },
    clients: (parts) => [
      ...productionClients(CONFIG)(parts),
      new FakeClientAdapter({
        launcher: parts.launcher,
        baseEnv: {},
        adapterVersion: '1.0.0',
        command: { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
      }),
    ],
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  const { repo, dispose } = await makeRepo();
  try {
    await body(daemon, repo);
  } finally {
    await dispose();
    await daemon.stop();
    await tmp.dispose();
  }
}

function specOf(
  repo: string,
  demandId: string,
  prompt: string,
  extra: Partial<AttemptSpec> = { role: 'author' },
): AttemptSpec {
  const spec: AttemptSpec = {
    playId: 'play-mcp',
    demandId,
    attempt: 1,
    repo,
    base: 'main',
    profile: TEST_PROFILE,
    executor: { model: 'fake-model' },
    policy: WITH_FRAMEWORK,
    prompt,
    ...extra,
  };
  return spec;
}

describeWithLauncher('framework MCP server over the real ACP stdio transport', () => {
  it('hands the session its URL and token, and a valid submit is recorded as attempt.submitted', async () => {
    await withDaemon(async (daemon, repo) => {
      const runner = daemon.execution?.runner;
      if (runner === undefined) throw new Error('the daemon has no execution');
      expect(daemon.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

      const result = await runner.run(
        specOf(
          repo,
          'mcp-ok',
          '#script:submit {"tool":"submit_plan","output":{"plan":"do a, then b","openQuestions":[]}}\nsubmit',
        ),
      );
      expect(result).toMatchObject({ state: 'completed', stopReason: 'end_turn' });

      const events = ofAttempt(await daemon.store.events.readFrom(0, 100_000), result.attemptId);
      const submitted = events.filter((event) => event.type === 'attempt.submitted');
      expect(submitted).toHaveLength(1);
      expect(submitted[0]?.payload).toMatchObject({
        tool: 'submit_plan',
        role: 'author',
        output: { plan: 'do a, then b', openQuestions: [] },
        calls: 1,
      });
      expect(events.map((event) => event.type)).not.toContain('attempt.submit_failed');
    });
  }, 60_000);

  it('lists only the tools of the role and answers a tool of another role with an error', async () => {
    await withDaemon(async (daemon, repo) => {
      const runner = daemon.execution?.runner;
      if (runner === undefined) throw new Error('the daemon has no execution');

      const listed = await runner.run(
        specOf(
          repo,
          'mcp-list',
          '#script:mcp-call {"tool":"submit_plan_review","arguments":{}}\nx',
        ),
      );
      const events = ofAttempt(await daemon.store.events.readFrom(0, 100_000), listed.attemptId);
      const text = chunksOf(events);
      const listing = /tools: ([a-z_, ]+)/.exec(text)?.[1]?.split(', ') ?? [];
      expect(listing).toContain('submit_plan');
      expect(listing).toContain('submit_script_review');
      expect(listing).not.toContain('submit_plan_review');
      expect(listing).not.toContain('submit_script');
      // `submit_plan_review` belongs to the reviewer: the author's token cannot call it.
      expect(text).toContain('mcp error');
      expect(events.map((event) => event.type)).not.toContain('attempt.submitted');
    });
  }, 60_000);

  it('counts invalid submits: submit_retries + 1 of them is the failure of the attempt', async () => {
    await withDaemon(async (daemon, repo) => {
      const runner = daemon.execution?.runner;
      if (runner === undefined) throw new Error('the daemon has no execution');

      // `submit` takes `{ result }` only: `wrong` is invalid, always.
      const result = await runner.run(
        specOf(
          repo,
          'mcp-bad',
          '#script:submit {"tool":"submit","output":{"wrong":1},"repeat":4}\nx',
        ),
      );
      const events = ofAttempt(await daemon.store.events.readFrom(0, 100_000), result.attemptId);
      expect(events.map((event) => event.type)).not.toContain('attempt.submitted');
      const failed = events.filter((event) => event.type === 'attempt.submit_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({ tool: 'submit', role: 'author' });
    });
  }, 60_000);

  it('gives no server to an attempt whose policy does not list it, and refuses a policy that does without a role', async () => {
    await withDaemon(async (daemon, repo) => {
      const runner = daemon.execution?.runner;
      if (runner === undefined) throw new Error('the daemon has no execution');

      const noPolicy = await runner.run(
        specOf(repo, 'mcp-nopolicy', '#script:mcp-call\nx', {
          role: 'author',
          policy: WITHOUT_FRAMEWORK,
        }),
      );
      expect(noPolicy).toMatchObject({ state: 'completed' });
      const events = await daemon.store.events.readFrom(0, 100_000);
      expect(chunksOf(ofAttempt(events, noPolicy.attemptId))).toContain(
        'no MCP server \\"otheater\\" in this session',
      );

      // The policy lists the server but the attempt has no role: nobody can mint a token, and
      // the adapter refuses the server it cannot resolve (the attempt fails, it does not run blind).
      const noRole = await runner.run(specOf(repo, 'mcp-norole', '#script:mcp-call\nx', {}));
      expect(noRole).toMatchObject({ state: 'failed' });
      expect(noRole.cause).toContain('otheater');
    });
  }, 60_000);
});
