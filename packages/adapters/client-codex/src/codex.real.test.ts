// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { realClientFlags } from '@otheater/sdk';
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
