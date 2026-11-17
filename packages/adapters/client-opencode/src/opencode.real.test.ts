// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ROLE_POLICY_FIELDS,
  type AgentSession,
  type Profile,
  type RolePolicy,
} from '@otheater/core';
import {
  describeClientAdapterConformance,
  describeSessionsReport,
  probeSessionsPerProcess,
  realClientFlags,
  realSessionsPerProcess,
  type ClientAdapterHarness,
} from '@otheater/sdk';
import { describe, expect, it } from 'vitest';
import {
  opencodeAdapterVersion,
  OpenCodeAdapter,
  type OpenCodeAdapterOptions,
} from './opencode-adapter.js';
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
  mcpTools: {},
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

async function rig(extra: Partial<OpenCodeAdapterOptions> = {}): Promise<Rig> {
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
    sandbox: { fields: ROLE_POLICY_FIELDS },
    profileDir: () => dir,
    permissionProbe: { via, scratchRoot: root },
    ...extra,
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

describe.skipIf(!flags.clients)('OpenCode (real): sessions in one process', () => {
  // K = OT_TEST_SESSIONS_PER_PROCESS (default 4). Only `session/new` and the config options, in an
  // empty profile: no prompt. `per_profile` is the multi-session model (N56), so the adapter must
  // start ONE `opencode acp` for the K sessions. The line it logs is the measurement the owner
  // reads to decide `pool.sessions_per_process` for this client.
  it('takes K sessions in one process (session/new only)', async () => {
    const k = realSessionsPerProcess();
    const r = await rig({ processModel: 'per_profile', sessionsPerProcess: k });
    const opened: AgentSession[] = [];
    const failures: string[] = [];
    try {
      for (let index = 0; index < k; index += 1) {
        try {
          opened.push(await r.adapter.openSession(r.profile, policy, r.cwd, r.via));
        } catch (error) {
          failures.push(`session ${String(index + 1)}: ${(error as Error).message.slice(0, 200)}`);
        }
      }
      console.info(
        `[sessions-per-process] client=opencode requested=${String(k)} accepted=${String(opened.length)} ` +
          `processes=${String(r.launcher.aliveGroups())}` +
          (failures.length === 0 ? '' : ` failures=${JSON.stringify(failures)}`),
      );
      expect(failures).toEqual([]);
      expect(new Set(opened.map((session) => session.sessionId)).size).toBe(k);
      expect(r.launcher.aliveGroups()).toBe(1);
    } finally {
      await Promise.all(opened.map((session) => session.close().catch(() => undefined)));
      await r.dispose();
    }
  }, 180_000);
});

describe.skipIf(!flags.clients)('OpenCode (real): agentInfo', () => {
  // N63: only records what `opencode acp` says about itself in `initialize`, in an empty scratch
  // folder (every home of the client points into it; nothing of the owner's is read).
  it('records the agentInfo of initialize (N63)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'otheater-opencode-info-'));
    try {
      const report = await probeSessionsPerProcess({
        cmd: 'opencode',
        args: ['acp'],
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: root,
          XDG_DATA_HOME: join(root, 'data'),
          XDG_CONFIG_HOME: join(root, 'config'),
          OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        },
        sessions: 0,
      });
      console.info(describeSessionsReport('opencode', report));
      expect(report.processAlive).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
