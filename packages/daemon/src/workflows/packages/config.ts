// SPDX-License-Identifier: MPL-2.0
/**
 * The keys `workflows.packages.*` (docs/24 section 9 and 12, N298, D5; plan of Phase 11b, P9). The
 * first four are the ones of the plan; the others are [proposta] and are marked so.
 *
 * - `sources`: where a package may come from, a list of `file` (a folder or a file on this
 *   machine) and `git` (a repository, pinned to a commit). Default both.
 * - `signature`: `verify_if_present` (default) checks a signature when the package has one and lets
 *   the package without one follow `unsigned`; `require` refuses what is not verified; `off` does
 *   not look at signatures at all.
 * - `trusted_keys`: the public keys (`ssh-ed25519 AAAA...`, one per entry) whose signatures count
 *   as verified. Empty by default: no signature is verified until the Producer trusts a key.
 * - `unsigned`: what a package that is not verified (no signature, or one that could not be
 *   checked) does: `confirm` (default) asks the Producer, `reject` refuses it.
 * - `activate` [proposta]: which version new runs are born in after an install: `when_none`
 *   (default) activates a workflow only when it has no active version, `always` activates what the
 *   package brought, `never` only saves it.
 * - `fetch_timeout` [proposta]: how long a `git clone` may take (default `2m`).
 * - `verify_timeout` [proposta]: how long `ssh-keygen -Y verify` may take (default `15s`).
 * - `max_workflows` [proposta]: how many workflows one package may bring (default 50).
 * - `ssh_keygen` [proposta]: `auto` (default) finds `ssh-keygen` in `PATH`; or the path of it.
 */
export const WORKFLOW_PACKAGE_SOURCES = ['file', 'git'] as const;
export type WorkflowPackageSource = (typeof WORKFLOW_PACKAGE_SOURCES)[number];

export const WORKFLOW_PACKAGE_SIGNATURE_MODES = ['verify_if_present', 'require', 'off'] as const;
export type WorkflowPackageSignatureMode = (typeof WORKFLOW_PACKAGE_SIGNATURE_MODES)[number];

export const WORKFLOW_PACKAGE_UNSIGNED_MODES = ['confirm', 'reject'] as const;
export type WorkflowPackageUnsignedMode = (typeof WORKFLOW_PACKAGE_UNSIGNED_MODES)[number];

export const WORKFLOW_PACKAGE_ACTIVATE_MODES = ['when_none', 'always', 'never'] as const;
export type WorkflowPackageActivateMode = (typeof WORKFLOW_PACKAGE_ACTIVATE_MODES)[number];

/** The value of `workflows.packages.ssh_keygen` that looks for `ssh-keygen` in `PATH`. */
export const WORKFLOW_PACKAGE_SSH_KEYGEN_AUTO = 'auto';

/**
 * An entry of `trusted_keys`: the line of a public key as `authorized_keys` writes it, `<type>
 * <base64>` and an optional comment. The comment is kept out of what is trusted (only the type and
 * the key count).
 */
export const SSH_PUBLIC_KEY_PATTERN =
  /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]{16,}={0,3}(?: [^\r\n]*)?$/;

/** `workflows.packages` as the installer reads it (the names are the ones of the file; times in ms). */
export interface WorkflowPackagesSettings {
  readonly sources: readonly WorkflowPackageSource[];
  readonly signature: WorkflowPackageSignatureMode;
  readonly trusted_keys: readonly string[];
  readonly unsigned: WorkflowPackageUnsignedMode;
  readonly activate: WorkflowPackageActivateMode;
  readonly fetch_timeout: number;
  readonly verify_timeout: number;
  readonly max_workflows: number;
  readonly ssh_keygen: string;
}

/** The defaults of `workflows.packages`, for an installer built without a configuration. */
export const DEFAULT_WORKFLOW_PACKAGES_SETTINGS: WorkflowPackagesSettings = {
  sources: ['file', 'git'],
  signature: 'verify_if_present',
  trusted_keys: [],
  unsigned: 'confirm',
  activate: 'when_none',
  fetch_timeout: 120_000,
  verify_timeout: 15_000,
  max_workflows: 50,
  ssh_keygen: WORKFLOW_PACKAGE_SSH_KEYGEN_AUTO,
};

/** The part of the resolved `workflows` block this module reads (structural: no import of `config.ts`). */
export interface WorkflowsConfigPackagesView {
  readonly packages: WorkflowPackagesSettings;
}

/** `workflows.packages` of the resolved configuration. */
export function workflowPackagesSettings(
  config: WorkflowsConfigPackagesView,
): WorkflowPackagesSettings {
  return config.packages;
}
