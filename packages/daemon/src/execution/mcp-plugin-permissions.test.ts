// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePluginManifest, type EventEnvelope, type RolePolicy } from '@otheater/core';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { describeWithLauncher } from '../launcher-fixture.js';
import { createSilentLogger } from '../logger.js';
import type { ActivePlugin } from '../plugins/aggregate.js';
import type { PluginNotice } from '../plugins/runtime-config.js';
import { FIXTURE_SERVER_PATH, StaticPluginSource } from '../plugins/test-plugin-fixture.js';
import { makeTempDataDir, TEST_PROFILE } from '../test-helpers.js';
import { makeRepo } from './attempt-fixture.js';
import type { AttemptSpec } from './attempt-runner.js';

/**
 * Permissions generated from the manifest (P6, N237) through the whole daemon: the fake agent over
 * the REAL ACP stdio transport lists the tools of the `otheater` server and calls a plugin tool, as
 * the Author (who writes) and as the Critic (who only reads), with the same manifest. The policy
 * of the role decides, never the manifest. The client is the compiled `dist/cli.js`.
 */

const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

const CONFIG = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
`);

const BASE: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: ['otheater'],
  mcpTools: { otheater: 'all' },
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};
const WRITER: RolePolicy = { ...BASE, nativeTools: ['read', 'search', 'edit', 'write'] };
const READER: RolePolicy = BASE;

function plugin(): ActivePlugin {
  const result = parsePluginManifest({
    manifest_version: 1,
    id: 'demo',
    version: '1.0.0',
    server: { type: 'stdio', command: [process.execPath, FIXTURE_SERVER_PATH] },
    tools: [
      // The same manifest lists the Critic for both tools: the effect is what tells them apart.
      { name: 'echo', roles: ['author', 'critic'], effects: 'read' },
      { name: 'env_report', roles: ['author', 'critic'], effects: 'local_write' },
    ],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  const { manifest } = result;
  return {
    id: manifest.id,
    version: manifest.version,
    manifest,
    dir: dirname(FIXTURE_SERVER_PATH),
    manifestHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  };
}

beforeAll(() => {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
});
afterAll(disposeTestGitIsolation);

function chunksOf(events: readonly EventEnvelope[], attemptId: string): string {
  return events
    .filter((event) => event.attemptId === attemptId && event.type === 'session.update')
    .map((event) => JSON.stringify(event.payload))
    .join('\n');
}

async function withDaemon(
  body: (daemon: DaemonHandle, repo: string, notices: PluginNotice[]) => Promise<void>,
): Promise<void> {
  const tmp = await makeTempDataDir();
  const real = defaultLauncher();
  if (real === undefined) throw new Error('this platform has no process launcher');
  const notices: PluginNotice[] = [];
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
    plugins: new StaticPluginSource({ sc1: [plugin()] }),
    pluginNotices: (notice) => notices.push(notice),
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  await daemon.store.scenarios.create({
    id: 'sc1',
    kind: 'project',
    flowId: 'software',
    name: 'Scenario',
    folder: tmp.dir,
    profile: 'software',
    conventions: {},
    configOverride: {},
  });
  await daemon.store.plays.create({
    id: 'play-perm',
    scenarioId: 'sc1',
    need: 'something',
    flowId: 'software',
    flowVersion: 1,
    state: 'PLANNING',
  });
  const { repo, dispose } = await makeRepo();
  try {
    await body(daemon, repo, notices);
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
  role: string,
  policy: RolePolicy,
): AttemptSpec {
  return {
    playId: 'play-perm',
    demandId,
    attempt: 1,
    repo,
    base: 'main',
    profile: TEST_PROFILE,
    executor: { model: 'fake-model' },
    policy,
    prompt,
    role,
  };
}

const listing = (text: string): string[] =>
  (/tools: ([a-z_, ]+)/.exec(text)?.[1]?.split(', ') ?? []).filter((name) =>
    name.startsWith('demo__'),
  );

describeWithLauncher('plugin tools by role and effect, over the real ACP stdio transport', () => {
  it('the Author, who writes, sees both tools and calls the write one', async () => {
    await withDaemon(async (daemon, repo, notices) => {
      const runner = daemon.execution?.runner;
      if (runner === undefined) throw new Error('the daemon has no execution');
      const result = await runner.run(
        specOf(
          repo,
          'author',
          '#script:mcp-call {"tool":"demo__env_report","arguments":{"name":"PATH"}}\nx',
          'author',
          WRITER,
        ),
      );
      const text = chunksOf(await daemon.store.events.readFrom(0, 100_000), result.attemptId);
      expect(listing(text)).toEqual(['demo__echo', 'demo__env_report']);
      expect(text).toContain('keys');
      expect(notices.filter((notice) => notice.kind === 'tool_refused')).toEqual([]);
    });
  }, 60_000);

  it('the Critic, listed by the manifest for the write tool, does not see it and cannot call it', async () => {
    await withDaemon(async (daemon, repo, notices) => {
      const runner = daemon.execution?.runner;
      if (runner === undefined) throw new Error('the daemon has no execution');
      const result = await runner.run(
        specOf(
          repo,
          'critic',
          '#script:mcp-call {"tool":"demo__env_report","arguments":{"name":"PATH"}}\nx',
          'critic',
          READER,
        ),
      );
      const text = chunksOf(await daemon.store.events.readFrom(0, 100_000), result.attemptId);
      expect(listing(text)).toEqual(['demo__echo']);
      expect(text).toContain('mcp error');
      // The plugin did not run: its report is not in the reply.
      expect(text).not.toContain('keys');
      expect(notices.filter((notice) => notice.kind === 'tool_refused')).toEqual([]);
    });
  }, 60_000);

  it('the Critic calls the read tool', async () => {
    await withDaemon(async (daemon, repo) => {
      const runner = daemon.execution?.runner;
      if (runner === undefined) throw new Error('the daemon has no execution');
      const result = await runner.run(
        specOf(
          repo,
          'critic-read',
          '#script:mcp-call {"tool":"demo__echo","arguments":{"text":"hi"}}\nx',
          'critic',
          READER,
        ),
      );
      const text = chunksOf(await daemon.store.events.readFrom(0, 100_000), result.attemptId);
      expect(text).toContain('echo:hi');
    });
  }, 60_000);
});
