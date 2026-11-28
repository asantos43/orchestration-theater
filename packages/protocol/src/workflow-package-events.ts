// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the workflow packages (N298, D5/N314; plan of Phase 11b, P9).
 * Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; strict objects.
 * [proposta] The names of the fields and of the reasons. The signature states mirror
 * `PACKAGE_SIGNATURE_STATES` of the daemon (the protocol does not import it).
 */

const PackageIdSchema = z.string().min(1);
const SignatureStateSchema = z.enum(['verified', 'invalid', 'unverified', 'absent', 'skipped']);

/** Where a package came from: a local file or folder, or a git repository pinned to a commit. */
export const WorkflowPackageOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('git'),
    url: z.string().min(1),
    /** What the Producer wrote after `#`: a branch, a tag or a commit. */
    ref: z.string().min(1),
    /** The commit the ref resolved to at the install; the package never follows the ref again. */
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  }),
]);

export type WorkflowPackageOrigin = z.infer<typeof WorkflowPackageOriginSchema>;

/**
 * `workflow.package.installed`: a package was installed (or updated: `previousVersion` is the
 * version it replaced). `workflows` lists `id@version` of what it saved in the library.
 * `signature` is what the check said and `confirmedUnsigned` tells that the Producer approved a
 * package that was not verified (`workflows.packages.unsigned: confirm`).
 */
export const WorkflowPackageInstalledPayloadSchema = z.strictObject({
  packageId: PackageIdSchema,
  version: z.string().min(1),
  previousVersion: z.string().min(1).nullable(),
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  origin: WorkflowPackageOriginSchema,
  workflows: z.array(z.string().min(1)),
  signature: SignatureStateSchema,
  /** The fingerprint of the key that signed it (`SHA256:...`), when the signature checked. */
  signer: z.string().min(1).nullable(),
  confirmedUnsigned: z.boolean(),
  /** The permissions the update added to the ones the Producer had approved, as `kind:name`. */
  newPermissions: z.array(z.string().min(1)),
});

/** `workflow.package.removed`: a package and the workflow versions it brought were removed. */
export const WorkflowPackageRemovedPayloadSchema = z.strictObject({
  packageId: PackageIdSchema,
  version: z.string().min(1),
  workflows: z.array(z.string().min(1)),
});

/**
 * `workflow.package.signature_failed`: an install was refused because of the signature (the
 * policy of `workflows.packages.signature` and `.unsigned`). `reason`:
 * - `invalid`: the signature is malformed, was made for another namespace, or does not match the
 *   content (the key is trusted but the check failed);
 * - `not_signed`: no signature, and the mode (`require`, or `unsigned: reject`) does not accept it;
 * - `not_verified`: a signature that could not be checked (the key is not in `trusted_keys`, or
 *   there is no usable `ssh-keygen`), and the mode does not accept it.
 * `detail` is a short text for the Producer.
 */
export const WorkflowPackageSignatureFailedPayloadSchema = z.strictObject({
  packageId: PackageIdSchema,
  version: z.string().min(1),
  origin: WorkflowPackageOriginSchema,
  mode: z.enum(['verify_if_present', 'require']),
  unsigned: z.enum(['confirm', 'reject']),
  reason: z.enum(['invalid', 'not_signed', 'not_verified']),
  detail: z.string().min(1),
});
