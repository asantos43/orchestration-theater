// SPDX-License-Identifier: MPL-2.0
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentSession,
  ConformanceProbe,
  ProbeContext,
  RolePolicy,
  SessionTransport,
} from '@otheater/core';

/** Id of the probe in the conformance report. */
export const PERMISSION_PROBE_ID = 'opencode-project-config-cannot-loosen-permission';

/**
 * What a `opencode.json` in the worktree would do to the permission if the client let it: allow
 * every tool, the shell and the edits included. The probe writes it next to the session it opens.
 */
export const LOOSE_PROJECT_CONFIG: Readonly<Record<string, unknown>> = {
  $schema: 'https://opencode.ai/config.json',
  permission: { '*': 'allow', edit: 'allow', bash: 'allow', external_directory: 'allow' },
};

/**
 * The policy the probe opens its session with: the role of a reader. Edits and the shell are
 * `deny` in the pinned `OPENCODE_PERMISSION`, so a file that shows up in the scratch worktree
 * means the file of the project won over the pinned value.
 */
export const PROBE_POLICY: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

/** Files the prompt asks for; none may exist at the end. */
export const PROBE_FILES = ['probe-edit.txt', 'probe-shell.txt'] as const;

const PROBE_PROMPT = [
  'This is a permission check. Do both of these with your own tools, then answer "done":',
  `1. Create the file ${PROBE_FILES[0]} with the text "ok" using your file editing tool.`,
  `2. Create the file ${PROBE_FILES[1]} by running the shell command: touch ${PROBE_FILES[1]}`,
  'If a tool is missing or refuses, do not try another way; say which one and stop.',
].join('\n');

export interface PermissionProbeOptions {
  /**
   * The transport the probe opens its session through. The `ProbeContext` carries the adapter and
   * the profile, not a transport, so the daemon hands in the one it uses (`acp`).
   */
  readonly via: SessionTransport;
  /** Absolute directory the scratch worktree is created in (the daemon passes its scratch root). */
  readonly scratchRoot: string;
  /** Model to run the probe with; the cheapest of the profile, as the architecture asks (5.2). Default: the client's. */
  readonly model?: string;
  /** Longest wait for the turn. Default 120 s [proposta]. */
  readonly timeoutMs?: number;
  /** Default {@link PROBE_POLICY}. */
  readonly policy?: RolePolicy;
}

const DEFAULT_TIMEOUT_MS = 120_000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runTurn(session: AgentSession, timeoutMs: number): Promise<'done' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const turn = session.prompt([{ type: 'text', text: PROBE_PROMPT }]).then(() => 'done' as const);
    turn.catch(() => undefined);
    return await Promise.race([turn, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The probe of OpenCode (architecture 5.2, "Sondas de conformidade"): an `opencode.json` with
 * `allow` in the worktree does not change the pinned permission. It makes a scratch worktree with
 * that file, opens a session through the adapter under test (so with its real environment,
 * `OPENCODE_PERMISSION` included), asks for an edit and a shell command, and passes only if neither
 * file was created. A turn that does not end, a session that does not open and a probe that
 * cannot clean up are failures: what was not seen is not a pass. It sends a real prompt, so the
 * daemon runs it once per client version (`security.conformance: on_version_change`).
 */
export function createPermissionProbe(options: PermissionProbeOptions): ConformanceProbe {
  return {
    id: PERMISSION_PROBE_ID,
    async run({ profile, adapter }: ProbeContext) {
      const worktree = await mkdtemp(join(options.scratchRoot, 'otheater-opencode-probe-'));
      let session: AgentSession | undefined;
      let timedOut = false;
      try {
        await writeFile(
          join(worktree, 'opencode.json'),
          `${JSON.stringify(LOOSE_PROJECT_CONFIG, null, 2)}\n`,
        );
        session = await adapter.openSession(
          profile,
          options.policy ?? PROBE_POLICY,
          worktree,
          options.via,
        );
        if (options.model !== undefined) await session.setConfig('model', options.model);
        const outcome = await runTurn(session, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        if (outcome === 'timeout') {
          timedOut = true;
          return { ok: false, detail: 'the turn did not end in time; nothing can be concluded' };
        }
        const created: string[] = [];
        for (const file of PROBE_FILES) {
          if (await exists(join(worktree, file))) created.push(file);
        }
        return created.length === 0
          ? { ok: true, detail: 'the opencode.json of the worktree did not loosen the permission' }
          : {
              ok: false,
              detail: `the project config won over the pinned permission: ${created.join(', ')} created`,
            };
      } finally {
        if (session !== undefined) {
          if (timedOut) await session.cancel().catch(() => undefined);
          await session.close().catch(() => undefined);
        }
        await rm(worktree, { recursive: true, force: true });
      }
    },
  };
}

/**
 * The probe the adapter reports when it was given no transport to run one with: it fails, so a
 * missing check is never read as a passed one (fail closed).
 */
export const UNCONFIGURED_PERMISSION_PROBE: ConformanceProbe = {
  id: PERMISSION_PROBE_ID,
  run() {
    return Promise.resolve({
      ok: false,
      detail:
        'not run: no permissionProbe (transport and scratch directory) was given to the adapter',
    });
  },
};
