// SPDX-License-Identifier: MPL-2.0
import type { Profile, RolePolicy } from '@otheater/core';
import { FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, realClientFlags } from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeRepo } from './attempt-fixture.js';

/**
 * The framework MCP server (architecture 5.3) with a REAL Executor (N57). Nothing here runs by
 * default: a plain `pnpm test` skips the file, so no client is started and no quota is spent.
 *
 * Needs `OT_TEST_REAL_CLIENTS=1` and `OT_TEST_REAL_PROMPTS=1`, plus:
 * - `OT_TEST_CLAUDE_PROFILE_DIR`: a logged-in Claude Code profile, pointed at and never copied or
 *   deleted (the pattern of `acceptance.real.test.ts`);
 * - `OT_TEST_CLAUDE_MODEL`: the model id the client lists (a Haiku one is enough; the test does
 *   not guess it);
 * - `OT_TEST_CLAUDE_MODE` (optional): the mode id of the session. With `onAsk: 'reject'` an ask is
 *   refused (architecture 5.8), so the adapter allows the MCP tools of the role with
 *   `allowedTools` and `permissions.allow` (`mcp__otheater__<tool>`); this test is the cheap check that the
 *   rule works against the real client (the `play` level of `tools/acceptance/real-acceptance.sh`
 *   runs it before the whole play). [N] Not confirmed by a real run yet.
 *
 * The attempt has the role `author`: it lists `submit_plan` (and the common tools) and the prompt
 * asks the Executor to call it once with a plan. The criterion is the `attempt.submitted` event in
 * the log of the attempt, with the output the model sent.
 *
 * [proposta] It runs with `security.unenforced: warn` (no sandbox before Phase 4), like
 * `acceptance.real.test.ts`. [N] Not run in this step: written to be run by the owner. Nothing
 * here reads or prints a credential, and the token of the session only travels to the client.
 */

const flags = realClientFlags();
const supported = process.platform !== 'win32';

const PROFILE_DIR = process.env.OT_TEST_CLAUDE_PROFILE_DIR;
const MODEL = process.env.OT_TEST_CLAUDE_MODEL;
const MODE = process.env.OT_TEST_CLAUDE_MODE;
const ready =
  flags.clients &&
  flags.prompts &&
  supported &&
  PROFILE_DIR !== undefined &&
  PROFILE_DIR !== '' &&
  MODEL !== undefined &&
  MODEL !== '';

const CONFIG = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
`);

const AUTHOR: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: ['otheater'],
  mcpTools: { otheater: ['read_blackboard', 'submit', 'submit_plan'] },
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

afterAll(disposeTestGitIsolation);

describe.skipIf(!ready)(
  'claude-agent-acp with the framework MCP server (OT_TEST_REAL_CLIENTS=1, OT_TEST_REAL_PROMPTS=1)',
  () => {
    it(
      'calls a framework tool and delivers a valid submit, recorded as attempt.submitted',
      async () => {
        const tmp = await makeTempDataDir();
        const real = defaultLauncher();
        if (real === undefined) throw new Error('this platform has no process launcher');
        const daemon = await startDaemon({
          dataDir: tmp.dir,
          config: CONFIG,
          overrides: { clock: new FakeClock(), vault: new InMemorySecretVault(), launcher: real },
          clients: productionClients(CONFIG),
          logger: createSilentLogger(),
          version: '0.0.0-test',
        });
        const { repo, dispose } = await makeRepo();
        try {
          const runner = daemon.execution?.runner;
          if (runner === undefined) throw new Error('the daemon has no execution');
          const profile: Profile = {
            client: 'claude-code',
            profile: 'real',
            id: 'claude-code/real',
            dir: PROFILE_DIR ?? '',
          };
          const outcome = await runner.run({
            playId: 'play-real-mcp',
            demandId: 'plan',
            attempt: 1,
            repo,
            base: 'main',
            profile,
            executor: { model: MODEL ?? '', ...(MODE === undefined ? {} : { mode: MODE }) },
            policy: AUTHOR,
            role: 'author',
            timeoutMs: 5 * 60_000,
            prompt: [
              'You play the author. Deliver your plan with the MCP tool submit_plan of the server',
              'otheater: call it once with plan set to a short plan as plain text and openQuestions set to an empty list.',
              'Do not use any other tool. When the tool accepts the plan, say done.',
            ].join(' '),
          });
          expect(outcome).toMatchObject({ state: 'completed' });
          const events = (await daemon.store.events.readFrom(0, 100_000)).filter(
            (event) => event.attemptId === outcome.attemptId,
          );
          const submitted = events.filter((event) => event.type === 'attempt.submitted');
          expect(submitted).toHaveLength(1);
          expect(submitted[0]?.payload).toMatchObject({ tool: 'submit_plan', role: 'author' });
        } finally {
          await dispose();
          await daemon.stop();
          await tmp.dispose();
        }
      },
      10 * 60_000,
    );
  },
);
