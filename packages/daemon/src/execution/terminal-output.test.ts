// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, RolePolicy } from '@otheater/core';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { buildTrajectory } from '@otheater/protocol';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { itWithLauncher } from '../launcher-fixture.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir, TEST_PROFILE } from '../test-helpers.js';
import { makeRepo } from './attempt-fixture.js';

/**
 * The terminal of the Actor (P11 of Phase 8, N200 item 3): the fake agent plays the `terminal`
 * script over the real ACP stdio transport, and the `terminal.output` events are read off the log.
 * The client is the compiled `dist/cli.js`, so `pnpm build` comes first. Nothing real runs.
 */
const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

const POLICY: RolePolicy = {
  nativeTools: ['read', 'search', 'edit', 'write'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

const KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

beforeAll(() => {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
});
afterAll(disposeTestGitIsolation);

/** Runs one attempt whose prompt is `script` under `events` (the yaml of the `events` block). */
async function runTerminal(
  eventsYaml: string,
  script: string,
): Promise<{ events: readonly EventEnvelope[]; attemptId: string; playId: string }> {
  const config = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
${eventsYaml}
`);
  const tmp = await makeTempDataDir();
  const real = defaultLauncher();
  if (real === undefined) throw new Error('this platform has no process launcher');
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    config,
    overrides: { clock: new FakeClock(), vault: new InMemorySecretVault(), launcher: real },
    clients: (parts) => [
      ...productionClients(config)(parts),
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
    const result = await runner.run({
      playId: 'play-term',
      demandId: 'term',
      attempt: 1,
      repo,
      base: 'main',
      profile: TEST_PROFILE,
      executor: { model: 'fake-model' },
      policy: POLICY,
      prompt: `${script}\nrun`,
    });
    expect(result).toMatchObject({ state: 'completed', stopReason: 'end_turn' });
    const all = await daemon.store.events.readFrom(0, 100_000);
    return {
      events: all.filter((event) => event.attemptId === result.attemptId),
      attemptId: result.attemptId,
      playId: 'play-term',
    };
  } finally {
    await dispose();
    await daemon.stop();
    await tmp.dispose();
  }
}

const outputs = (events: readonly EventEnvelope[]): EventEnvelope[] =>
  events.filter((event) => event.type === 'terminal.output');
const textOf = (events: readonly EventEnvelope[]): string =>
  outputs(events)
    .map((event) => (event.payload as { text: string }).text)
    .join('');

describe('terminal.output over the real ACP stdio transport', () => {
  itWithLauncher(
    'writes the output masked, ties it to the tool call and ends it with the exit',
    async () => {
      const script = JSON.stringify({
        command: 'make',
        chunks: ['building\n', `export TOKEN=${KEY.slice(0, 10)}`, `${KEY.slice(10)}\n`, 'done\n'],
        exitCode: 2,
      });
      const { events, playId } = await runTerminal('', `#script:terminal ${script}`);
      const found = outputs(events);
      expect(found.length).toBeGreaterThan(0);
      const text = textOf(events);
      expect(text).toContain('building\n');
      expect(text).toContain('done\n');
      expect(text).toContain('[REDACTED]');
      expect(text).not.toContain('abcdefghij');
      expect(JSON.stringify(events)).not.toContain(KEY.slice(3, 20));
      const last = found[found.length - 1]?.payload as Record<string, unknown>;
      expect(last).toMatchObject({ exitCode: 2, signal: null });
      for (const event of found) {
        expect(event.playId).toBe(playId);
        expect(event.payload).toMatchObject({ playId, demandId: 'term' });
      }
      // the terminal output is not a session.update
      expect(
        events.some(
          (event) =>
            event.type === 'session.update' &&
            JSON.stringify(event.payload).includes('terminal_output'),
        ),
      ).toBe(false);
      // and the trajectory shows it
      const trajectory = buildTrajectory(playId, events);
      const entries = trajectory.attempts.flatMap((a) => a.turns.flatMap((t) => t.entries));
      const terminal = entries.filter((entry) => entry.kind === 'terminal');
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ kind: 'terminal' });
      expect((terminal[0] as { text: string }).text).toContain('building');
    },
    60_000,
  );

  itWithLauncher(
    'truncated cuts the output at events.terminal_output_max and marks it',
    async () => {
      const script = JSON.stringify({ chunks: [`${'x'.repeat(99)}\n`], repeat: 100 });
      const { events, playId } = await runTerminal(
        'events:\n  terminal_output: truncated\n  terminal_output_max: 2KB',
        `#script:terminal ${script}`,
      );
      expect(Buffer.byteLength(textOf(events))).toBeLessThanOrEqual(2048);
      const found = outputs(events).map((event) => event.payload as Record<string, unknown>);
      const closing = found[found.length - 1];
      expect(closing).toMatchObject({ truncated: true, exitCode: 0 });
      // 100 lines of 100 bytes were sent: what was kept plus what was left out is all of it
      expect(Buffer.byteLength(textOf(events)) + (closing?.omittedBytes as number)).toBe(10_000);
      const trajectory = buildTrajectory(playId, events);
      const entry = trajectory.attempts[0]?.turns[0]?.entries.find((e) => e.kind === 'terminal');
      expect(entry).toMatchObject({ kind: 'terminal', truncated: true });
    },
    60_000,
  );

  itWithLauncher(
    'on keeps all of it, and off writes none',
    async () => {
      const script = JSON.stringify({ chunks: [`${'y'.repeat(99)}\n`], repeat: 100 });
      const on = await runTerminal(
        'events:\n  terminal_output: on\n  terminal_output_max: 1KB',
        `#script:terminal ${script}`,
      );
      expect(Buffer.byteLength(textOf(on.events))).toBe(10_000);
      expect(
        outputs(on.events).some((event) => (event.payload as { truncated?: boolean }).truncated),
      ).toBe(false);
      const off = await runTerminal(
        'events:\n  terminal_output: off',
        `#script:terminal ${script}`,
      );
      expect(outputs(off.events)).toHaveLength(0);
    },
    90_000,
  );
});
