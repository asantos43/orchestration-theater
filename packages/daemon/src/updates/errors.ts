// SPDX-License-Identifier: MPL-2.0
import type { UpdatePhase, UpdateReason } from '@otheater/protocol';

/**
 * Why a search for a new version stopped before the version was stored (Phase 10, P7). The
 * {@link phaseOf} of a reason says what the event is:
 * - `rejected`: the version came from the origin and cannot be trusted (it is discarded, and the
 *   Producer is told in the global chat);
 * - `failed`: the origin could not be read (nothing is wrong with a version);
 * - `skipped`: nothing to do and nothing wrong;
 * - `rolled_back` (P8): the version was applied and did not hold, or could not be put in place,
 *   and the previous one is back. `backup_failed` is `failed`: nothing was moved, and the version
 *   stays ready for the next try.
 * [proposta] The split below; the architecture lists the reasons, not the phase of each.
 */
export function phaseOf(
  reason: UpdateReason,
): Extract<UpdatePhase, 'rejected' | 'failed' | 'skipped' | 'rolled_back'> {
  switch (reason) {
    case 'signature':
    case 'sha256':
    case 'size':
    case 'version_not_newer':
    case 'wrong_channel':
    case 'bad_manifest':
      return 'rejected';
    case 'no_network':
    case 'bad_response':
    case 'storage':
    case 'backup_failed':
      return 'failed';
    case 'not_started':
    case 'health':
    case 'unstable':
    case 'swap_failed':
    case 'interrupted':
    case 'hash_changed':
      return 'rolled_back';
    case 'no_public_key':
    case 'no_asset':
    case 'below_min_version':
      return 'skipped';
  }
}

/** A search that ends here. `detail` is for the log only (never a path of a secret or a token). */
export class UpdateStop extends Error {
  readonly reason: UpdateReason;
  readonly version: string | null;

  constructor(reason: UpdateReason, detail: string, version: string | null = null) {
    super(detail);
    this.name = 'UpdateStop';
    this.reason = reason;
    this.version = version;
  }

  get phase(): ReturnType<typeof phaseOf> {
    return phaseOf(this.reason);
  }
}
