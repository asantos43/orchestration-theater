// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeSessionsReport,
  probeSessionsPerProcess,
  realClientFlags,
  realSessionsPerProcess,
} from '@otheater/sdk';
import { CodexAdapter, DEFAULT_CODEX_COMMAND } from './codex-adapter.js';

// Written against `codex-acp`, NEVER run by the pipeline or by the author of this step (N57: no
// real client runs without the owner's go-ahead). It is off unless `OT_TEST_REAL_CLIENTS=1`; the
// tests that spend a model turn also need `OT_TEST_REAL_PROMPTS=1`. The credentials are the ones
// of a profile the owner prepared outside the repository: the path comes from the environment and
// nothing here reads, copies or prints them.

const flags = realClientFlags();
const profileDir = process.env.OT_TEST_CODEX_HOME;

describe.skipIf(!flags.clients || profileDir === undefined)('the real codex-acp', () => {
  it('has a command that resolves to the default one', () => {
    expect(DEFAULT_CODEX_COMMAND.cmd).toBe('codex-acp');
  });

  it('prepares a profile without touching the credentials, in a scratch copy', async () => {
    const { writeProfileConfig } = await import('./profile.js');
    const dir = await mkdtemp(join(tmpdir(), 'ot-codex-real-'));
    try {
      await writeProfileConfig(dir, {
        credentialsStore: 'file',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      });
      expect(dir).not.toBe(profileDir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!flags.prompts)(
    'answers a prompt, in the pinned mode, through the guarded transport',
    () => {
      // The ACP transport that spawns the process arrives with the daemon wiring (P8); until then
      // this test only documents the intent and builds the adapter it will drive.
      const adapter = new CodexAdapter({
        launcher: undefined as never,
        baseEnv: {},
        adapterVersion: process.env.OT_TEST_CODEX_ACP_VERSION ?? 'unknown',
      });
      expect(adapter.id).toBe('codex');
    },
  );
});

describe.skipIf(!flags.clients)('the real codex-acp: sessions in one process', () => {
  // K = OT_TEST_SESSIONS_PER_PROCESS (default 4). Only `session/new` and the config options, in an
  // empty scratch CODEX_HOME (no login, nothing billed). Whether `codex-acp` answers `session/new`
  // without a login is [N]; if it does not, the report says so in `failures`. The line it logs is
  // the measurement the owner reads to decide `pool.sessions_per_process` for this client.
  // OT_TEST_CODEX_ACP_COMMAND overrides the executable.
  it('takes K sessions in one process (session/new only)', async () => {
    const { writeProfileConfig } = await import('./profile.js');
    const scratch = await mkdtemp(join(tmpdir(), 'ot-codex-real-k-'));
    try {
      const dir = join(scratch, 'codex-home');
      await writeProfileConfig(dir, {
        credentialsStore: 'file',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      });
      const override = process.env.OT_TEST_CODEX_ACP_COMMAND;
      const command =
        override === undefined || override === ''
          ? DEFAULT_CODEX_COMMAND
          : { cmd: override, args: [] as readonly string[] };
      const report = await probeSessionsPerProcess({
        cmd: command.cmd,
        args: command.args,
        cwd: scratch,
        env: { PATH: process.env.PATH ?? '', HOME: scratch, CODEX_HOME: dir },
        sessions: realSessionsPerProcess(),
      });
      console.info(describeSessionsReport('codex', report));
      expect(report.accepted).toBe(report.requested);
      expect(report.distinctSessionIds).toBe(report.requested);
      expect(report.processAlive).toBe(true);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
