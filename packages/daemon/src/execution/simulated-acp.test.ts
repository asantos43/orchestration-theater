// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, RolePolicy } from '@otheater/core';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir, TEST_PROFILE } from '../test-helpers.js';
import { makeRepo } from './attempt-fixture.js';
import type { AttemptSpec } from './attempt-runner.js';
import { itWithLauncher } from '../launcher-fixture.js';

/**
 * The two simulated attempts of `acceptance.real.test.ts` (the fake agent over the REAL ACP stdio
 * transport, with the daemon's real launcher), runnable without any real client: a plain
 * `pnpm test` covers them. The client is the compiled `dist/cli.js`, so `pnpm build` comes first
 * (as for `acp-e2e.test.ts`).
 *
 * - `write-file`: the agent writes with no permission request (a client whose mode already allows
 *   the edit), so the edit completes and an edit-batch checkpoint commits it.
 * - `edit-file`: the agent asks, and the policy (`onAsk: 'reject'`, architecture 5.8 [V]) always
 *   rejects: the tool call fails, nothing is written and nothing is checkpointed.
 */

const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

const CONFIG = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
resume:
  checkpoint_edit_batch: 1
  checkpoint_every: 5m
`);

const WRITING: RolePolicy = {
  nativeTools: ['read', 'search', 'edit', 'write'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
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

function ofAttempt(events: readonly EventEnvelope[], attemptId: string): readonly EventEnvelope[] {
  return events.filter((event) => event.attemptId === attemptId);
}

describe('simulated attempts over the real ACP stdio transport', () => {
  itWithLauncher(
    'write-file completes and is checkpointed; edit-file is refused, with no file and no checkpoint',
    async () => {
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
        const runner = daemon.execution?.runner;
        if (runner === undefined) throw new Error('the daemon has no execution');
        const spec = (demandId: string, prompt: string): AttemptSpec => ({
          playId: 'play-sim',
          demandId,
          attempt: 1,
          repo,
          base: 'main',
          profile: TEST_PROFILE,
          executor: { model: 'fake-model' },
          policy: WRITING,
          prompt,
        });
        const [written, refused] = await Promise.all([
          runner.run(
            spec(
              'sim-edit',
              '#script:write-file {"path":"sim.txt","content":"simulated\\n"}\nedit',
            ),
          ),
          runner.run(
            spec(
              'sim-refused',
              '#script:edit-file {"path":"sim.txt","content":"simulated\\n"}\nedit',
            ),
          ),
        ]);
        const events = await daemon.store.events.readFrom(0, 100_000);

        // write-file: no ask, so the edit completes and the edit batch is committed.
        expect(written).toMatchObject({ state: 'completed', stopReason: 'end_turn' });
        const writtenEvents = ofAttempt(events, written.attemptId);
        expect(writtenEvents.map((event) => event.type)).toContain('attempt.checkpoint');
        expect(existsSync(join(written.worktree, 'sim.txt'))).toBe(true);
        expect(await testGit(written.worktree, 'show', 'HEAD:sim.txt')).toBe('simulated');

        // edit-file: the ask is rejected, the tool call fails, nothing lands in the worktree.
        expect(refused).toMatchObject({ state: 'completed', stopReason: 'end_turn' });
        const refusedEvents = ofAttempt(events, refused.attemptId);
        expect(refusedEvents.map((event) => event.type)).not.toContain('attempt.checkpoint');
        expect(
          refusedEvents.some(
            (event) =>
              event.type === 'session.update' &&
              JSON.stringify(event.payload).includes('"kind":"tool_call_update"') &&
              JSON.stringify(event.payload).includes('"status":"failed"'),
          ),
        ).toBe(true);
        expect(existsSync(join(refused.worktree, 'sim.txt'))).toBe(false);

        expect(written.worktree).not.toBe(refused.worktree);
      } finally {
        await dispose();
        await daemon.stop();
        await tmp.dispose();
      }
    },
    60_000,
  );
});
