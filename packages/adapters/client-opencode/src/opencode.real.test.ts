// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLE_POLICY_FIELDS, type Profile, type RolePolicy } from '@otheater/core';
import {
  describeClientAdapterConformance,
  realClientFlags,
  type ClientAdapterHarness,
} from '@otheater/sdk';
import { describe, expect, it } from 'vitest';
import { opencodeAdapterVersion, OpenCodeAdapter } from './opencode-adapter.js';
import { createPermissionProbe, PERMISSION_PROBE_ID } from './permission-probe.js';
import { AcpTestTransport } from './testing/acp-test-transport.js';
import { NodeProcessLauncher } from './testing/node-process-launcher.js';

// Tests against the REAL OpenCode, off by default (N57):
//  - OT_TEST_REAL_CLIENTS=1 runs what only starts `opencode` (version of the ACP surface, session
//    open and close, the model catalog);
//  - OT_TEST_REAL_PROMPTS=1 also lets prompts go out, which spend the quota of the account the
//    profile is logged in with.
// `opencode` must be on PATH. By default the profile is an EMPTY temporary folder (the client is
// not logged in there, so only what needs no model works). To run the prompt tests, point
// OT_TEST_OPENCODE_PROFILE_DIR at a profile directory that is already logged in (made by
// `prepareProfile` and a login done by the owner); it is used as is and never deleted.
// [proposta] Nothing here reads or prints a credential.

const flags = realClientFlags();
const policy: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

interface Rig {
  readonly adapter: OpenCodeAdapter;
  readonly launcher: NodeProcessLauncher;
  readonly via: AcpTestTransport;
  readonly profile: Profile;
  readonly cwd: string;
  readonly root: string;
  readonly dispose: () => Promise<void>;
}

async function rig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'otheater-opencode-real-'));
  const provided = process.env.OT_TEST_OPENCODE_PROFILE_DIR;
  const dir = provided === undefined || provided === '' ? join(root, 'profile') : provided;
  const cwd = join(root, 'work');
  await mkdir(cwd, { recursive: true });
  const launcher = new NodeProcessLauncher();
  const via = new AcpTestTransport();
  const profile: Profile = { client: 'opencode', profile: 'real', id: 'opencode/real', dir };
  const adapter = new OpenCodeAdapter({
    launcher,
    // Only what the client needs to be found and to run; the profile isolates its homes.
    baseEnv: { PATH: process.env.PATH ?? '' },
    adapterVersion: opencodeAdapterVersion(),
    processModel: 'per_session',
    sandbox: { fields: ROLE_POLICY_FIELDS },
    profileDir: () => dir,
    permissionProbe: { via, scratchRoot: root },
  });
  return {
    adapter,
    launcher,
    via,
    profile,
    cwd,
    root,
    dispose: async () => {
      await launcher.killAll();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describeClientAdapterConformance(
  'OpenCodeAdapter + the real opencode acp',
  async () => {
    const r = await rig();
    const harness: ClientAdapterHarness = {
      adapter: r.adapter,
      via: r.via,
      profile: r.profile,
      policy,
      cwd: r.cwd,
      prompts: {
        echo: (text) => [
          { type: 'text', text: `Reply with exactly this text and nothing else: ${text}` },
        ],
        hang: [
          {
            type: 'text',
            text: 'Count slowly from 1 to 100000, one number per line, and do not stop.',
          },
        ],
      },
      processesAlive: () => r.launcher.aliveGroups(),
      dispose: r.dispose,
    };
    return harness;
  },
  { real: true },
);

describe.skipIf(!flags.clients)('OpenCode (real): catalog', () => {
  it('lists the models with `opencode models --verbose`, in the profile directory', async () => {
    const r = await rig();
    try {
      const models = await r.adapter.models.list(r.profile);
      // Not logged in, the list may be short or empty: what must hold is that it parsed.
      expect(Array.isArray(models)).toBe(true);
      for (const model of models) {
        expect(model.id).not.toBe('');
      }
    } finally {
      await r.dispose();
    }
  }, 60_000);
});

describe.skipIf(!flags.clients || !flags.prompts)('OpenCode (real): own probe', () => {
  it('an opencode.json with allow in the worktree does not change the pinned permission', async () => {
    const r = await rig();
    try {
      const probe = createPermissionProbe({ via: r.via, scratchRoot: r.root, timeoutMs: 180_000 });
      expect(probe.id).toBe(PERMISSION_PROBE_ID);
      const result = await probe.run({ profile: r.profile, adapter: r.adapter });
      expect(result.detail).toBeDefined();
      expect(result.ok).toBe(true);
    } finally {
      await r.dispose();
    }
  }, 240_000);
});
