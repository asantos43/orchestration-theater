// SPDX-License-Identifier: MPL-2.0
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@otheater/core';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir, NO_CLIENTS, TEST_PROFILE } from '../test-helpers.js';
import { defaultPolicySettings } from '../orchestration/role-policy.js';
import { ASKING_WRITER, refusedEditsOf, WRITER } from './acceptance-policy-fixture.js';
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
 * - `edit-file` under {@link ASKING_WRITER} (no `editInWorktree`): the agent asks, and the policy
 *   (`onAsk: 'reject'`, architecture 5.8 [V]) always rejects: the tool call fails, nothing is
 *   written and nothing is checkpointed.
 * - `edit-file` under {@link WRITER}, the policy of the drafts of the real clients: the agent asks
 *   (as Claude Code does when its mode does not spare the request), and layer 2 allows the edit
 *   inside the worktree (`editInWorktree: allow`, N182), so the file lands and is checkpointed.
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
    'write-file completes; edit-file is refused when the role asks and allowed inside the worktree when it writes',
    async () => {
      const tmp = await makeTempDataDir();
      const real = defaultLauncher();
      if (real === undefined) throw new Error('this platform has no process launcher');
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        config: CONFIG,
        overrides: { clock: new FakeClock(), vault: new InMemorySecretVault(), launcher: real },
        clients: (parts) => [
          ...productionClients(CONFIG, NO_CLIENTS)(parts),
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
        const spec = (
          demandId: string,
          prompt: string,
          policy: AttemptSpec['policy'] = ASKING_WRITER,
        ): AttemptSpec => ({
          playId: 'play-sim',
          demandId,
          attempt: 1,
          repo,
          base: 'main',
          profile: TEST_PROFILE,
          executor: { model: 'fake-model' },
          policy,
          prompt,
        });
        const [written, refused, allowed] = await Promise.all([
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
          runner.run(
            spec(
              'sim-allowed',
              '#script:edit-file {"path":"draft.txt","content":"draft\\n"}\nedit',
              WRITER,
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
        expect(refusedEditsOf(events, refused.attemptId)).toMatchObject([
          // Layer 2 records the real path (on macOS /var is a link to /private/var).
          { answer: 'reject', paths: [join(realpathSync(refused.worktree), 'sim.txt')] },
        ]);

        // edit-file under the policy of the real drafts: the ask is allowed inside the worktree.
        expect(allowed).toMatchObject({ state: 'completed', stopReason: 'end_turn' });
        expect(refusedEditsOf(events, allowed.attemptId)).toEqual([]);
        const allowedEvents = ofAttempt(events, allowed.attemptId);
        expect(allowedEvents.map((event) => event.type)).toContain('attempt.checkpoint');
        expect(await testGit(allowed.worktree, 'show', 'HEAD:draft.txt')).toBe('draft');

        expect(new Set([written, refused, allowed].map((outcome) => outcome.worktree)).size).toBe(
          3,
        );
      } finally {
        await dispose();
        await daemon.stop();
        await tmp.dispose();
      }
    },
    60_000,
  );
});

describe('the policies of the real acceptance', () => {
  // The defect of 2026-11-25 [V]: the drafts of the real clients ran under a policy with no
  // `editInWorktree`, so Claude Code opened in `default` and asked for every `Write`. Absent counts
  // as `ask` (N182); the adapter tests cover the mode that follows (policy.test.ts, sessionModeOf).
  it('gives the drafts the editInWorktree of the Actor and leaves it absent in the asking writer', () => {
    const actor = defaultPolicySettings('actor').editInWorktree;
    expect(actor).toBe('allow');
    expect(WRITER.editInWorktree).toBe(actor);
    expect(WRITER.nativeTools).toEqual(expect.arrayContaining(['edit', 'write']));
    expect(ASKING_WRITER.editInWorktree).toBeUndefined();
    expect(ASKING_WRITER.nativeTools).toEqual(expect.arrayContaining(['edit', 'write']));
  });
});
