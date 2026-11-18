// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';

/**
 * Ids of the session config options of `codex-acp` 2.6.0, as `session/new` listed them in Phase 0
 * (`spikes/acp-codex`, item 2) [V]. The adapter also offers `collaboration_mode` and `fast-mode`;
 * nothing here touches them.
 */
export const CODEX_CONFIG_IDS = {
  mode: 'mode',
  model: 'model',
  effort: 'reasoning_effort',
} as const;

/** The mode `codex-acp` creates a session in, when nothing else is asked (Phase 0, item 2) [V]. */
export const CODEX_DEFAULT_MODE = 'agent';

/**
 * Modes the daemon never asks for and never lets through (architecture 5.2, `bypass`, v0.45):
 * `agent` ("Auto review") sends the escalation to an automatic reviewer and no
 * `session/request_permission` reaches the client, and `agent-full-access` has no sandbox and
 * never asks. Both stay in the client's catalog and cannot be removed from it by any setting
 * that was tried (Phase 0, item 8) [V], so the veto is on this side. It cannot be configured away.
 */
export const VETOED_MODES: readonly string[] = ['agent', 'agent-full-access'];

/** The mode of Codex with no sandbox of its own (`danger-full-access`) and no approval. See {@link fullAccessPolicy}. */
export const FULL_ACCESS_MODE = 'agent-full-access';

/**
 * `clients.codex.inner_sandbox` (N129): what Codex does with its own sandbox when layer 3 wraps it.
 * `keep` (default, what the adapter always did): Codex opens in `workspace-write` and its sandbox
 * does not start inside the confinement, so its native shell fails. `full_access_when_wrapped`: with
 * layer 3 on, Codex opens with no sandbox of its own and layer 3 is the only `os` layer. `nested`:
 * layer 3 lets this client make user namespaces (the daemon does that, `allowNestedUserNamespaces`
 * of the sandbox request) and Codex keeps its sandbox; the write denies of layer 3 get weaker.
 */
export const INNER_SANDBOX_MODES = ['keep', 'full_access_when_wrapped', 'nested'] as const;
export type InnerSandboxMode = (typeof INNER_SANDBOX_MODES)[number];

/** Modes with a known sandbox, and the name of that sandbox in `codex exec --sandbox` and `config.toml`. */
export const SANDBOX_OF: Readonly<Record<string, 'read-only' | 'workspace-write'>> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
};

/**
 * What `config.toml` (`sandbox_mode`) and `codex exec --sandbox` call the sandbox of a session in
 * `mode`; `undefined` for a mode the adapter does not know. Besides {@link SANDBOX_OF}, it knows the
 * full-access mode, which only {@link fullAccessPolicy} lets a session be in.
 */
export function sandboxOfMode(
  mode: string,
): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
  return mode === FULL_ACCESS_MODE ? 'danger-full-access' : SANDBOX_OF[mode];
}

export const DEFAULT_INITIAL_MODE = 'workspace-write';
export const DEFAULT_ALLOWED_MODES: readonly string[] = ['read-only', 'workspace-write'];

const MODE_ID = /^[a-z0-9][a-z0-9:_-]*$/;

/** What the adapter lets a session be in. */
export interface ModePolicy {
  /** The mode every session is created in and pinned to. */
  readonly initial: string;
  /** Every mode `set_config_option` may select; always contains `initial`, never a vetoed mode. */
  readonly allowed: readonly string[];
  /**
   * Modes of {@link VETOED_MODES} this policy does NOT veto. Absent: all of them are vetoed. Only
   * {@link fullAccessPolicy} sets it, so the veto cannot be lifted by a configuration list.
   */
  readonly lifted?: readonly string[];
}

/** The modes this policy refuses besides everything off its allow-list. */
export function vetoedModes(policy: ModePolicy): readonly string[] {
  return VETOED_MODES.filter((mode) => !(policy.lifted ?? []).includes(mode));
}

/**
 * N129, `inner_sandbox: full_access_when_wrapped` with layer 3 on: a session whose initial mode is
 * `workspace-write` starts in {@link FULL_ACCESS_MODE} instead, and that one mode of the veto is
 * lifted (`agent` stays vetoed). [proposta] A policy whose initial mode is `read-only` is left as
 * it is: the owner asked for a session that cannot write, and layer 3 does not replace that. The
 * ACP mode with no sandbox of Codex is `agent-full-access` ("Full access", Phase 0) [V]; that it
 * leaves exactly the OS confinement of layer 3 in place is [N] until a real round.
 */
export function fullAccessPolicy(policy: ModePolicy): ModePolicy {
  if (policy.initial !== 'workspace-write') return policy;
  return {
    initial: FULL_ACCESS_MODE,
    allowed: [...new Set([...policy.allowed, FULL_ACCESS_MODE])],
    lifted: [FULL_ACCESS_MODE],
  };
}

/** Checks the two options, rejects with `InvalidInput` when they break the veto or each other. */
export function modePolicyOf(initial: string, allowed: readonly string[]): ModePolicy {
  for (const mode of [initial, ...allowed]) {
    if (!MODE_ID.test(mode))
      throw new InvalidInput(`codex: ${JSON.stringify(mode)} is not a mode id`);
    if (VETOED_MODES.includes(mode)) {
      throw new InvalidInput(
        `codex: the mode ${mode} is vetoed and cannot be allowed by configuration`,
      );
    }
  }
  if (!allowed.includes(initial)) {
    throw new InvalidInput(`codex: the initial mode ${initial} is not among the allowed modes`);
  }
  if (SANDBOX_OF[initial] === undefined) {
    throw new InvalidInput(
      `codex: the initial mode ${initial} has no known sandbox (use ${Object.keys(SANDBOX_OF).join(' or ')})`,
    );
  }
  return { initial, allowed: [...new Set(allowed)] };
}

/**
 * The veto: why a session may not be in `mode` (`null` when it may). An allow-list, not a
 * deny-list: besides the two vetoed modes the client adds a mode per permission profile it knows
 * (`permission-profile:<id>`) [S], and none of those was measured. The base turns the reason into
 * a `PermissionDenied` (`ClientAdapter.modeVeto`).
 */
export function modeRefusal(policy: ModePolicy, mode: string): string | null {
  if (vetoedModes(policy).includes(mode)) {
    return `it is vetoed (it never asks the client for permission); allowed: ${policy.allowed.join(', ')}`;
  }
  if (!policy.allowed.includes(mode)) {
    return `it is not allowed; allowed: ${policy.allowed.join(', ')}`;
  }
  return null;
}
