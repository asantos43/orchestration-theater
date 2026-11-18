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
import { permissionsOf, transcriptOf } from './escape-fixture.js';

/**
 * The framework MCP server (architecture 5.3) with a REAL Executor (N57). Nothing here runs by
 * default: a plain `pnpm test` skips the file, so no client is started and no quota is spent.
 *
 * Needs `OT_TEST_REAL_CLIENTS=1` and `OT_TEST_REAL_PROMPTS=1`, plus, per client (a client without
 * both is left out):
 * - `OT_TEST_CLAUDE_PROFILE_DIR`, `OT_TEST_CODEX_PROFILE_DIR`, `OT_TEST_OPENCODE_PROFILE_DIR`: a
 *   logged-in profile, pointed at and never copied or deleted (the pattern of
 *   `acceptance.real.test.ts`);
 * - `OT_TEST_CLAUDE_MODEL`, `OT_TEST_CODEX_MODEL`, `OT_TEST_OPENCODE_MODEL`: the model id the
 *   client lists (a cheap one is enough; the test does not guess it);
 * - `OT_TEST_CLAUDE_MODE` (optional): the mode id of the Claude session;
 * - `OT_TEST_MCP_SANDBOX` (optional): `runtime` (default) runs the client inside the sandbox, with
 *   the bridge of N115 (`sandbox.mcp_bridge: proxy`); `off` runs it without one (`sandbox.mode: off`;
 *   the default of `sandbox.mode` is `runtime`) and with `security.unenforced: warn`, as before Phase 4;
 * - `OT_TEST_SANDBOX_EXTRA_DOMAINS` (optional): hosts added to the sandbox list, comma-separated
 *   (OpenCode with an OpenAI model needs the OpenAI hosts; `PROVIDER_DOMAINS` lists only its own).
 *
 * With `OT_TEST_REAL_PLAY=1` (the `play` level, which runs this file before the play) only Claude
 * Code runs, like the play. The `mcp` level of `tools/acceptance/real-acceptance.sh` runs it for
 * every client that has a profile and a model.
 *
 * The attempt has the role `author`: it lists `submit_plan` (and the common tools) and the prompt
 * asks the Executor to call it once with a plan. The criterion is the `attempt.submitted` event in
 * the log of the attempt, with the output the model sent. With `onAsk: 'reject'` an ask is refused
 * (architecture 5.8), so each adapter has to allow the MCP tools of the role by itself (Claude:
 * `allowedTools`; Codex: its MCP approval; OpenCode: `OPENCODE_PERMISSION`). The tool calls and the
 * reply of the model are printed (`[mcp-real]`), so a failure says what the client saw.
 *
 * [V] Claude Code with the Haiku, `acceptEdits` and the sandbox: passed on 2026-11-17 (N115).
 * Codex and OpenCode: [N] until a run of the `mcp` level. Nothing here reads or prints a
 * credential, and the token of the session only travels to the client.
 */

const flags = realClientFlags();
const supported = process.platform !== 'win32';
const playOnly = process.env.OT_TEST_REAL_PLAY === '1';
const sandboxed = (process.env.OT_TEST_MCP_SANDBOX ?? 'runtime') !== 'off';

const ENV_OF: Readonly<Record<ClientId, { profile: string; model: string; mode?: string }>> = {
  'claude-code': {
    profile: 'OT_TEST_CLAUDE_PROFILE_DIR',
    model: 'OT_TEST_CLAUDE_MODEL',
    mode: 'OT_TEST_CLAUDE_MODE',
  },
  codex: { profile: 'OT_TEST_CODEX_PROFILE_DIR', model: 'OT_TEST_CODEX_MODEL' },
  opencode: { profile: 'OT_TEST_OPENCODE_PROFILE_DIR', model: 'OT_TEST_OPENCODE_MODEL' },
};

const EXTRA_DOMAINS = (process.env.OT_TEST_SANDBOX_EXTRA_DOMAINS ?? '')
  .split(',')
  .map((domain) => domain.trim())
  .filter((domain) => domain !== '');

const CONFIG = parseConfig(
  sandboxed
    ? `backup:\n  when: manual\nsandbox:\n  mode: runtime\n  extra_domains: ${JSON.stringify(EXTRA_DOMAINS)}\n`
    : 'backup:\n  when: manual\nsandbox:\n  mode: off\nsecurity:\n  unenforced: warn\n',
);

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

describe.each(CLIENT_IDS)(
  '%s with the framework MCP server (OT_TEST_REAL_CLIENTS=1, OT_TEST_REAL_PROMPTS=1)',
  (client) => {
    const env = ENV_OF[client];
    const profileDir = process.env[env.profile];
    const model = process.env[env.model];
    const mode = env.mode === undefined ? undefined : process.env[env.mode];
    const ready =
      flags.clients &&
      flags.prompts &&
      supported &&
      (!playOnly || client === 'claude-code') &&
      profileDir !== undefined &&
      profileDir !== '' &&
      model !== undefined &&
      model !== '';

    it.skipIf(!ready)(
      'calls a framework tool and delivers a valid submit, recorded as attempt.submitted',
      async () => {
        const tmp = await makeTempDataDir();
        const real = defaultLauncher();
        if (real === undefined) throw new Error('this platform has no process launcher');
        const daemon = await startDaemon({
          dataDir: tmp.dir,
          config: CONFIG,
          // The system clock: the deadline of the attempt (`timeoutMs`) sleeps on it, and a fake one never wakes.
          overrides: { vault: new InMemorySecretVault(), launcher: real },
          clients: productionClients(CONFIG),
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
            playId: 'play-real-mcp',
            demandId: 'plan',
            attempt: 1,
            repo,
            base: 'main',
            profile,
            executor: {
              model: model ?? '',
              ...(mode === undefined || mode === '' ? {} : { mode }),
            },
            policy: AUTHOR,
            role: 'author',
            timeoutMs: 5 * 60_000,
            prompt: [
              'You play the author. Deliver your plan with the MCP tool submit_plan of the server',
              'otheater: call it once with plan set to a short plan as plain text and openQuestions set to an empty list.',
              'Do not use any other tool. When the tool accepts the plan, say done.',
            ].join(' '),
          });
          const events = (await daemon.store.events.readFrom(0, 100_000)).filter(
            (event) => event.attemptId === outcome.attemptId,
          );
          // The report, for the owner to read when it fails. Not a criterion.
          const transcript = transcriptOf(events, outcome.attemptId);
          console.log(
            `[mcp-real] ${client}: sandbox=${sandboxed ? 'runtime' : 'off'} state=${outcome.state}${'cause' in outcome ? ` cause=${String(outcome.cause)}` : ''} tool-calls=${String(transcript.toolCalls.length)}\n${transcript.toolCalls.map((call) => `  ${call}`).join('\n')}`,
          );
          console.log(`[mcp-real] ${client}: reply:\n${transcript.reply.slice(0, 2000)}`);
          const asks = permissionsOf(events, outcome.attemptId).map(
            (ask) =>
              `  ${ask.tool ?? '?'}:${ask.kind ?? '?'}:${ask.answer}:${ask.rule}:${ask.reason}`,
          );
          console.log(`[mcp-real] ${client}: asks=${String(asks.length)}\n${asks.join('\n')}`);

          expect(outcome).toMatchObject({ state: 'completed' });
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
