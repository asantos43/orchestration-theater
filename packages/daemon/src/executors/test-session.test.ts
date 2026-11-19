// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RolePolicy } from '@otheater/core';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { makeRepo } from '../execution/attempt-fixture.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir, TEST_PROFILE } from '../test-helpers.js';
import { attemptTestSession, type TestSession } from './test-session.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * The short test session of the cadastro (architecture 5.7, step 4) on the REAL attempt runner of a
 * daemon, with the fake agent over the real ACP stdio transport in place of a model. The fake agent
 * is the compiled `dist/cli.js`, so `pnpm build` comes first. No real client runs here.
 */

const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

const CONFIG = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
`);

const POLICY: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: ['otheater'],
  mcpTools: { otheater: ['submit'] },
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

beforeAll(() => {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
});
afterAll(disposeTestGitIsolation);

async function withSession(
  prompt: string,
  body: (session: TestSession, daemon: DaemonHandle) => Promise<void>,
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
  try {
    const runner = daemon.execution?.runner;
    if (runner === undefined) throw new Error('the daemon has no execution');
    const session = attemptTestSession({
      runner,
      events: daemon.store.events,
      scratch: async () => {
        const { repo, dispose } = await makeRepo();
        return { repo, base: 'main', dispose };
      },
      policy: POLICY,
      prompt,
      timeoutMs: 30_000,
    });
    await body(session, daemon);
  } finally {
    await daemon.stop();
    await tmp.dispose();
  }
}

const REQUEST = {
  profile: TEST_PROFILE,
  model: 'fake-model',
  effort: null,
  executorId: 'fake-model-medium@fake/one',
} as const;

describeWithLauncher('attemptTestSession on the fake agent', () => {
  it('approves a model that calls the tool submit and ends', async () => {
    await withSession(
      '#script:submit {"tool":"submit","output":{"result":{"ok":true}}}\nx',
      async (session, daemon) => {
        const result = await session.run(REQUEST);
        expect(result).toMatchObject({ ok: true });
        const events = await daemon.store.events.readFrom(0, 100_000);
        expect(events.filter((event) => event.type === 'attempt.submitted')).toHaveLength(1);
      },
    );
  }, 60_000);

  it('fails a model whose session ends well but never calls submit', async () => {
    await withSession('#script:echo\nhello', async (session) => {
      const result = await session.run(REQUEST);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/did not call the tool "submit"/);
    });
  }, 60_000);
});

describe('attemptTestSession on a runner that ends badly', () => {
  const runnerEnding = (state: string, cause?: string) => ({
    run: () =>
      Promise.resolve({
        attemptId: 'a/1',
        state,
        ...(cause === undefined ? {} : { cause }),
      } as never),
  });
  const events = { lastId: () => Promise.resolve(0), readFrom: () => Promise.resolve([]) } as never;

  it.each([
    ['failed', 'the process died'],
    ['interrupted', undefined],
  ])(
    'fails when the attempt ends %s, and still disposes the scratch repository',
    async (state, cause) => {
      let disposed = 0;
      const session = attemptTestSession({
        runner: runnerEnding(state, cause),
        events,
        scratch: () =>
          Promise.resolve({
            repo: '/nowhere',
            base: 'main',
            dispose: () => {
              disposed += 1;
              return Promise.resolve();
            },
          }),
        policy: POLICY,
      });
      const result = await session.run(REQUEST);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain(`the session ended ${state}`);
      if (cause !== undefined) expect(result.detail).toContain(cause);
      expect(disposed).toBe(1);
    },
  );
});
