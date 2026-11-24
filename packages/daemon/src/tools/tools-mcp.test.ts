// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, RolePolicy } from '@otheater/core';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { makeRepo } from '../execution/attempt-fixture.js';
import type { AttemptSpec } from '../execution/attempt-runner.js';
import { createSilentLogger } from '../logger.js';
import {
  buildRolePolicy,
  defaultPolicySettings,
  type PolicySettings,
} from '../orchestration/role-policy.js';
import { buildDaemonRegistries } from '../registries.js';
import { makeTempDataDir, TEST_PROFILE } from '../test-helpers.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * The work tools end to end (architecture 5.8): the fake agent over the REAL ACP stdio transport
 * gets the URL and the token of the framework MCP server, calls `restricted_shell`, `git_commit`
 * and `http_get` as the actor, and the daemon answers with the handlers it registered. The events
 * `tool.called` and `tool.finished` land in the log of the attempt. The client is the compiled
 * `dist/cli.js`, so `pnpm build` comes first.
 */

const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

const CONFIG = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
tools:
  commands:
    test: [node, -e, "console.log('tests pass')"]
shell:
  http_get:
    # The test server is on 127.0.0.1, which block_private refuses by default.
    block_private: off
`);

/**
 * The policy of the Actor as the daemon resolves it (P1): the default of the role (with the shells,
 * owner decision of 2026-11-17) and `network.allow` of the test server, so `mcpTools` lists
 * `http_get` as well.
 */
function policyOf(settings: Partial<PolicySettings> = {}): RolePolicy {
  return buildRolePolicy(
    'actor',
    { ...defaultPolicySettings('actor'), network: { allow: ['127.0.0.1'] }, ...settings },
    buildDaemonRegistries().tools.list(),
  );
}

const ACTOR = policyOf();

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
  policy: RolePolicy = ACTOR,
): AttemptSpec {
  return {
    playId: 'play-tools',
    demandId,
    attempt: 1,
    repo,
    base: 'main',
    profile: TEST_PROFILE,
    executor: { model: 'fake-model' },
    policy,
    prompt,
    role: 'actor',
  };
}

function script(tool: string, args: unknown): string {
  return `#script:mcp-call ${JSON.stringify({ tool, arguments: args })}\nx`;
}

async function runTool(
  daemon: DaemonHandle,
  repo: string,
  demandId: string,
  tool: string,
  args: unknown,
): Promise<{ text: string; events: readonly EventEnvelope[] }> {
  const runner = daemon.execution?.runner;
  if (runner === undefined) throw new Error('the daemon has no execution');
  const result = await runner.run(specOf(repo, demandId, script(tool, args)));
  expect(result).toMatchObject({ state: 'completed' });
  const events = ofAttempt(await daemon.store.events.readFrom(0, 100_000), result.attemptId);
  return { text: chunksOf(events), events };
}

function payloadsOf(events: readonly EventEnvelope[], type: string): Record<string, unknown>[] {
  return events
    .filter((event) => event.type === type)
    .map((event) => event.payload as Record<string, unknown>);
}

describeWithLauncher('the work tools through the framework MCP server', () => {
  it('lists the tools of the actor and runs restricted_shell in the worktree of the attempt', async () => {
    await withDaemon(async (daemon, repo) => {
      const { text, events } = await runTool(daemon, repo, 'shell-ok', 'restricted_shell', {
        argv: ['ls'],
      });
      expect(text).toContain('README.md');
      expect(text).toContain('exitCode');
      const called = payloadsOf(events, 'tool.called');
      const finished = payloadsOf(events, 'tool.finished');
      expect(called).toHaveLength(1);
      expect(called[0]).toMatchObject({
        tool: 'restricted_shell',
        role: 'actor',
        summary: 'ls',
        heavy: false,
        playId: 'play-tools',
        demandId: 'shell-ok',
      });
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ tool: 'restricted_shell', outcome: 'ok', exitCode: 0 });
      const types = events.map((event) => event.type);
      expect(types.indexOf('tool.called')).toBeLessThan(types.indexOf('tool.finished'));
    });
  }, 60_000);

  it('answers a refusal as an error result and records it as refused', async () => {
    await withDaemon(async (daemon, repo) => {
      const { text, events } = await runTool(daemon, repo, 'shell-refused', 'restricted_shell', {
        argv: ['rm', '-rf', '.'],
      });
      expect(text).toContain('program_not_allowed');
      expect(payloadsOf(events, 'tool.finished')[0]).toMatchObject({
        outcome: 'refused',
        errorCode: 'program_not_allowed',
      });
      const escape = await runTool(daemon, repo, 'shell-escape', 'restricted_shell', {
        argv: ['cat', '/etc/passwd'],
      });
      expect(escape.text).toContain('path_escapes');
    });
  }, 60_000);

  it('runs run_tests with the command of the config, and nothing the model sends', async () => {
    await withDaemon(async (daemon, repo) => {
      const { text, events } = await runTool(daemon, repo, 'tests-ok', 'run_tests', {});
      expect(text).toContain('tests pass');
      expect(payloadsOf(events, 'tool.called')[0]).toMatchObject({
        tool: 'run_tests',
        heavy: true,
      });
      expect(payloadsOf(events, 'tool.finished')[0]).toMatchObject({ outcome: 'ok', queuedMs: 0 });

      // install_deps has no command anywhere: the tool says so, it does not guess one.
      const install = await runTool(daemon, repo, 'install-none', 'install_deps', {});
      expect(install.text).toContain('no_command');
    });
  }, 60_000);

  it('answers nothing_to_commit for git_commit on an unchanged worktree', async () => {
    await withDaemon(async (daemon, repo) => {
      const { text, events } = await runTool(daemon, repo, 'commit-empty', 'git_commit', {
        message: 'Nothing here',
      });
      expect(text).toContain('nothing_to_commit');
      expect(payloadsOf(events, 'tool.finished')[0]).toMatchObject({ outcome: 'error' });
    });
  }, 60_000);

  describe('http_get', () => {
    it('reads a page of the role domains and refuses any other', async () => {
      const server: Server = createServer((_request, response) => {
        response.end('page of the test server');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        await withDaemon(async (daemon, repo) => {
          const ok = await runTool(daemon, repo, 'http-ok', 'http_get', {
            url: `http://127.0.0.1:${String(port)}/page`,
          });
          expect(ok.text).toContain('page of the test server');
          expect(ok.text).toContain('untrusted');
          const refused = await runTool(daemon, repo, 'http-refused', 'http_get', {
            url: 'http://example.invalid/page',
          });
          expect(refused.text).toContain('domain_not_allowed');
          expect(payloadsOf(refused.events, 'tool.finished')[0]).toMatchObject({
            outcome: 'refused',
          });
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        );
      }
    }, 60_000);
  });

  it('does not list the shells for an Actor whose policy closes them (native_shell: none)', async () => {
    await withDaemon(async (daemon, repo) => {
      const runner = daemon.execution?.runner;
      if (runner === undefined) throw new Error('the daemon has no execution');
      const closed = policyOf({ nativeShell: 'none' });
      expect(JSON.stringify(closed.mcpTools)).not.toContain('restricted_shell');
      const result = await runner.run(
        specOf(repo, 'closed', script('restricted_shell', { argv: ['ls'] }), closed),
      );
      const events = ofAttempt(await daemon.store.events.readFrom(0, 100_000), result.attemptId);
      expect(chunksOf(events)).toContain('mcp error');
      expect(events.map((event) => event.type)).not.toContain('tool.called');
    });
  }, 60_000);

  it('does not give the tools of the actor to another role', async () => {
    await withDaemon(async (daemon, repo) => {
      const runner = daemon.execution?.runner;
      if (runner === undefined) throw new Error('the daemon has no execution');
      const result = await runner.run({
        ...specOf(repo, 'wrong-role', script('restricted_shell', { argv: ['ls'] })),
        role: 'author',
      });
      const events = ofAttempt(await daemon.store.events.readFrom(0, 100_000), result.attemptId);
      expect(chunksOf(events)).toContain('mcp error');
      expect(events.map((event) => event.type)).not.toContain('tool.called');
    });
  }, 60_000);
});
