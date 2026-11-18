// SPDX-License-Identifier: MPL-2.0
import type { Profile, RolePolicy } from '@otheater/core';
import { InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, realClientFlags } from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { CLIENT_IDS, parseConfig, type ClientId } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeRepo } from './attempt-fixture.js';

/**
 * Each REAL client inside the sandbox of the daemon (layer 3, architecture 5.8; N57). Nothing here
 * runs by default: a plain `pnpm test` skips the file, so no client is started and no quota is
 * spent.
 *
 * It answers the question the fake agent cannot: does the client still work when it can write only
 * in its worktree and profile, read no secret path and reach only its provider's domains? Needs
 * `OT_TEST_REAL_CLIENTS=1` and `OT_TEST_REAL_PROMPTS=1`, and per client (the pattern of
 * `acceptance.real.test.ts`; a client without them is left out):
 * - `OT_TEST_CLAUDE_PROFILE_DIR`, `OT_TEST_CODEX_PROFILE_DIR`, `OT_TEST_OPENCODE_PROFILE_DIR`: a
 *   logged-in profile, pointed at and never copied or deleted;
 * - `OT_TEST_CLAUDE_MODEL`, `OT_TEST_CODEX_MODEL`, `OT_TEST_OPENCODE_MODEL`: the model id of the
 *   catalog of the client;
 * - `OT_TEST_SANDBOX_EXTRA_DOMAINS` (optional): comma-separated domains for `sandbox.extra_domains`
 *   (OpenCode talks to the provider of its model, which the daemon does not know).
 *
 * The config has no `security.unenforced: warn`: the session starts only if layer 3 covers
 * `writeScope` and `network`. The criterion is that the session answers one trivial prompt and
 * the attempt completes. [N] Not run in this step (the tests run nothing real): written to be run
 * by the owner. What it settles is open: whether `claude-agent-acp`, `codex-acp` and
 * `opencode acp` start and answer inside the sandbox, and whether they still reach the loopback
 * MCP server of the daemon (the sandbox sets `NO_PROXY` to the loopback and gives the process its
 * own loopback, so they probably cannot [S]).
 */

const flags = realClientFlags();
const supported = process.platform !== 'win32';

const ENV_OF: Readonly<Record<ClientId, { profile: string; model: string }>> = {
  'claude-code': { profile: 'OT_TEST_CLAUDE_PROFILE_DIR', model: 'OT_TEST_CLAUDE_MODEL' },
  codex: { profile: 'OT_TEST_CODEX_PROFILE_DIR', model: 'OT_TEST_CODEX_MODEL' },
  opencode: { profile: 'OT_TEST_OPENCODE_PROFILE_DIR', model: 'OT_TEST_OPENCODE_MODEL' },
};

const EXTRA_DOMAINS = (process.env.OT_TEST_SANDBOX_EXTRA_DOMAINS ?? '')
  .split(',')
  .map((domain) => domain.trim())
  .filter((domain) => domain !== '');

const POLICY: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

afterAll(disposeTestGitIsolation);

describe.each(CLIENT_IDS)(
  '%s inside the sandbox (OT_TEST_REAL_CLIENTS=1, OT_TEST_REAL_PROMPTS=1)',
  (client) => {
    const profileDir = process.env[ENV_OF[client].profile];
    const model = process.env[ENV_OF[client].model];
    const ready =
      flags.clients &&
      flags.prompts &&
      supported &&
      profileDir !== undefined &&
      profileDir !== '' &&
      model !== undefined &&
      model !== '';

    it.skipIf(!ready)(
      'starts confined, answers a prompt and completes the attempt',
      async () => {
        const config = parseConfig(
          `backup:\n  when: manual\nsandbox:\n  mode: runtime\n  extra_domains: ${JSON.stringify(EXTRA_DOMAINS)}\n`,
        );
        const tmp = await makeTempDataDir();
        const real = defaultLauncher();
        if (real === undefined) throw new Error('this platform has no process launcher');
        const daemon = await startDaemon({
          dataDir: tmp.dir,
          config,
          // The system clock: the deadline of the attempt (`timeoutMs`) sleeps on it, and a fake one never wakes.
          overrides: { vault: new InMemorySecretVault(), launcher: real },
          clients: productionClients(config),
          logger: createSilentLogger(),
          version: '0.0.0-test',
        });
        const { repo, dispose } = await makeRepo();
        try {
          const runner = daemon.execution?.runner;
          if (runner === undefined) throw new Error('the daemon has no execution');
          const profile: Profile = {
            client,
            profile: 'real',
            id: `${client}/real`,
            dir: profileDir ?? '',
          };
          const outcome = await runner.run({
            playId: 'play-real-sandbox',
            demandId: 'hello',
            attempt: 1,
            repo,
            base: 'main',
            profile,
            executor: { model: model ?? '' },
            policy: POLICY,
            timeoutMs: 5 * 60_000,
            prompt: 'Reply with the single word ready. Do not use any tool.',
          });
          expect(outcome).toMatchObject({ state: 'completed' });
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
