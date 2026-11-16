// SPDX-License-Identifier: MPL-2.0
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { NormalizedUpdateSchema, type Profile, type RolePolicy } from '@otheater/core';
import { realClientFlags } from '@otheater/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND } from './claude-code-adapter.js';
import { readConfigOptions } from './model-catalog.js';
import { normalizeClaudeUpdate } from './normalize-update.js';
import { acpOptions, SESSION_MODE } from './policy.js';
import { writeProfileSettings } from './prepare-profile.js';
import { PROBE_FILE } from './probes.js';

// Tests against the real `claude-agent-acp` (N57). They never run in `pnpm check`:
//
// - OT_TEST_REAL_CLIENTS=1: `initialize`, the config options and `session/new`, in an empty
//   temporary profile (no login, no prompt, nothing billed).
// - OT_TEST_REAL_PROMPTS=1 (and OT_TEST_CLAUDE_PROFILE_DIR, a profile the owner logged in on
//   purpose): turns that send a prompt.
//
// OT_TEST_CLAUDE_ACP_COMMAND overrides the executable of the ACP adapter. The file speaks ACP by
// hand (newline-delimited JSON-RPC on stdio) because an adapter package must not import the ACP
// transport of another one (`adapter-isolation`).

const flags = realClientFlags();
const profileDirForPrompts = process.env.OT_TEST_CLAUDE_PROFILE_DIR;

const policy: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

type Json = Record<string, unknown>;

interface Notification {
  readonly method: string;
  readonly params: Json;
}

class MiniAcp {
  readonly notifications: Notification[] = [];
  readonly permissionRequests: Json[] = [];
  /** The answer to `initialize`. */
  initialized: Json = {};
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, (message: Json) => void>();
  #id = 0;

  constructor(cmd: string, args: readonly string[], cwd: string, env: Record<string, string>) {
    this.#child = spawn(cmd, [...args], {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (this.#child.stdout === null) throw new Error('no stdout');
    createInterface({ input: this.#child.stdout }).on('line', (line) => {
      this.#onLine(line);
    });
  }

  #write(message: Json): void {
    this.#child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  #onLine(line: string): void {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      this.#pending.get(message.id)?.(message);
      return;
    }
    const params = (message.params ?? {}) as Json;
    if (message.method === 'session/request_permission') {
      // Layer 2: always the refusing option, never an allow.
      this.permissionRequests.push(params);
      const options = (params.options ?? []) as { optionId: string; kind: string }[];
      const refuse = options.find((option) => option.kind === 'reject_once');
      this.#write({
        id: message.id,
        result: {
          outcome:
            refuse === undefined
              ? { outcome: 'cancelled' }
              : { outcome: 'selected', optionId: refuse.optionId },
        },
      });
      return;
    }
    if (typeof message.method === 'string') {
      this.notifications.push({ method: message.method, params });
    }
  }

  request(method: string, params: Json, timeoutMs = 30_000): Promise<Json> {
    this.#id += 1;
    const id = this.#id;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${method} did not answer in ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        if ('error' in message) reject(new Error(JSON.stringify(message.error)));
        else resolve((message.result ?? {}) as Json);
      });
      this.#write({ id, method, params });
    });
  }

  /** Ends the whole process group: the adapter leaves its `claude` child alive on SIGTERM. */
  stop(): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function command(): { cmd: string; args: readonly string[] } {
  const override = process.env.OT_TEST_CLAUDE_ACP_COMMAND;
  return override === undefined || override === '' ? DEFAULT_COMMAND : { cmd: override, args: [] };
}

let scratch: string;
let client: MiniAcp | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'ot-claude-real-'));
});

afterEach(async () => {
  client?.stop();
  client = undefined;
  await rm(scratch, { recursive: true, force: true });
});

async function start(profileDir: string, cwd: string): Promise<MiniAcp> {
  const profile: Profile = {
    client: 'claude-code',
    profile: 'real',
    id: 'claude-code/real',
    dir: profileDir,
  };
  await writeProfileSettings(profile, policy);
  const { cmd, args } = command();
  // The environment is built here, not inherited: no account variable gets through, and HOME is
  // not the user's.
  const started = new MiniAcp(cmd, args, cwd, {
    PATH: process.env.PATH ?? '',
    HOME: scratch,
    CLAUDE_CONFIG_DIR: profileDir,
  });
  client = started;
  started.initialized = await started.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  return started;
}

function sessionNewParams(cwd: string): Json {
  return {
    cwd,
    mcpServers: [],
    _meta: { claudeCode: { options: acpOptions(policy, 'none') } },
  };
}

describe.skipIf(!flags.clients)('the real claude-agent-acp (no prompt)', () => {
  it('answers initialize with the capabilities this adapter declares', async () => {
    const acp = await start(join(scratch, 'profile'), scratch);
    expect(acp.initialized.agentCapabilities).toMatchObject({ loadSession: true });
  });

  it('announces the model and effort options in an empty profile, and the catalog reads them', async () => {
    const acp = await start(join(scratch, 'profile'), scratch);
    const created = await acp.request('session/new', sessionNewParams(scratch));
    const snapshot = readConfigOptions(created.configOptions);
    expect(snapshot?.models.length).toBeGreaterThan(0);
    expect(snapshot?.efforts.length).toBeGreaterThan(0);
  });

  it('accepts the mode default and does not list bypassPermissions after the policy', async () => {
    const acp = await start(join(scratch, 'profile'), scratch);
    const created = await acp.request('session/new', sessionNewParams(scratch));
    await acp.request('session/set_config_option', {
      sessionId: created.sessionId,
      configId: 'mode',
      value: SESSION_MODE,
    });
    expect(JSON.stringify(created.configOptions)).not.toContain('bypassPermissions');
  });
});

describe.skipIf(!flags.prompts || profileDirForPrompts === undefined)(
  'the real claude-agent-acp (sends prompts; needs a logged-in profile)',
  () => {
    it('answers a plain prompt and every update normalizes to a valid one', async () => {
      const acp = await start(profileDirForPrompts ?? '', scratch);
      const created = await acp.request('session/new', sessionNewParams(scratch));
      await acp.request('session/set_config_option', {
        sessionId: created.sessionId,
        configId: 'mode',
        value: SESSION_MODE,
      });
      const done = await acp.request(
        'session/prompt',
        {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'Reply with the word ok.' }],
        },
        120_000,
      );
      expect(done.stopReason).toBe('end_turn');
      const normalized = acp.notifications
        .filter((entry) => entry.method === 'session/update')
        .map((entry) => normalizeClaudeUpdate(entry.params.update));
      for (const update of normalized) {
        if (update !== null) expect(NormalizedUpdateSchema.safeParse(update).success).toBe(true);
      }
    });

    it('does not let `sh -c` create a file under the policy (probe claude-sh-c-reject)', async () => {
      const acp = await start(profileDirForPrompts ?? '', scratch);
      const created = await acp.request('session/new', sessionNewParams(scratch));
      await acp.request('session/set_config_option', {
        sessionId: created.sessionId,
        configId: 'mode',
        value: SESSION_MODE,
      });
      await acp.request(
        'session/prompt',
        {
          sessionId: created.sessionId,
          prompt: [
            {
              type: 'text',
              text: `Run exactly this command with your shell tool and tell me what it printed: sh -c "touch ${PROBE_FILE}"`,
            },
          ],
        },
        120_000,
      );
      await expect(access(join(scratch, PROBE_FILE))).rejects.toThrow();
    });
  },
);
