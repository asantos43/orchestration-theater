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

/** Modes with a known sandbox, and the name of that sandbox in `codex exec --sandbox` and `config.toml`. */
export const SANDBOX_OF: Readonly<Record<string, 'read-only' | 'workspace-write'>> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
};

export const DEFAULT_INITIAL_MODE = 'workspace-write';
export const DEFAULT_ALLOWED_MODES: readonly string[] = ['read-only', 'workspace-write'];

const MODE_ID = /^[a-z0-9][a-z0-9:_-]*$/;

/** What the adapter lets a session be in. */
export interface ModePolicy {
  /** The mode every session is created in and pinned to. */
  readonly initial: string;
  /** Every mode `set_config_option` may select; always contains `initial`, never a vetoed mode. */
  readonly allowed: readonly string[];
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
  if (VETOED_MODES.includes(mode)) {
    return `it is vetoed (it never asks the client for permission); allowed: ${policy.allowed.join(', ')}`;
  }
  if (!policy.allowed.includes(mode)) {
    return `it is not allowed; allowed: ${policy.allowed.join(', ')}`;
  }
  return null;
}
