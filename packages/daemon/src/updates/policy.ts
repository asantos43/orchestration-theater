// SPDX-License-Identifier: MPL-2.0
import type { UPDATE_CHANNELS, UPDATE_MANIFEST_EXPIRY_MODES } from '@otheater/protocol';
import semver from 'semver';
import { UpdateStop } from './errors.js';
import type { UpdateManifest } from './manifest.js';

/**
 * What the daemon requires of a manifest whose signature already checked and that it is about to
 * act on (Phase 11, P8a). The same three questions are asked in three places: when the search finds
 * a release, when a version stored by an earlier run is offered again (`UpdateChecker.#restore`),
 * and when the apply step uses the stored version (`ApplyCoordinator.#verifyStaged`). A stored
 * version sat on disk with a signature of the past, so each place asks against the configuration
 * and the clock of now (the channel may have changed, the installed version may be older than the
 * `minVersion`, the manifest may have expired).
 */

export interface ManifestPolicy {
  /** `updates.channel` now. */
  readonly channel: (typeof UPDATE_CHANNELS)[number];
  /** The installed version (valid semver). */
  readonly current: string;
  /** `updates.manifest_expiry`. */
  readonly expiry: (typeof UPDATE_MANIFEST_EXPIRY_MODES)[number];
  /** The time now, in ms since the epoch. */
  readonly now: number;
}

/** A manifest of another channel is refused (`wrong_channel`). */
export function checkChannel(
  manifest: UpdateManifest,
  policy: Pick<ManifestPolicy, 'channel'>,
): void {
  if (manifest.channel !== policy.channel) {
    throw new UpdateStop(
      'wrong_channel',
      `the manifest is of channel ${manifest.channel}, the configuration asks for ${policy.channel}`,
      manifest.version,
    );
  }
}

/** A release that needs a newer installed version than this one is skipped (`below_min_version`). */
export function checkMinVersion(
  manifest: UpdateManifest,
  policy: Pick<ManifestPolicy, 'current'>,
): void {
  if (manifest.minVersion !== undefined && semver.lt(policy.current, manifest.minVersion)) {
    throw new UpdateStop(
      'below_min_version',
      `${manifest.version} needs at least ${manifest.minVersion}`,
      manifest.version,
    );
  }
}

/**
 * `updates.manifest_expiry`: `off` ignores `expires`; otherwise an expired manifest is refused
 * (`bad_manifest`), and one with no `expires` is accepted under `enforce` and refused under
 * `require`. Returns `true` when the manifest has no `expires` and was accepted, so the caller can
 * say so (the notice `update_no_expiry`).
 */
export function checkExpiry(
  manifest: UpdateManifest,
  policy: Pick<ManifestPolicy, 'expiry' | 'now'>,
): { readonly noExpiry: boolean } {
  if (policy.expiry === 'off') return { noExpiry: false };
  if (manifest.expires === undefined) {
    if (policy.expiry === 'require') {
      throw new UpdateStop(
        'bad_manifest',
        'the manifest has no expires and updates.manifest_expiry is require',
        manifest.version,
      );
    }
    return { noExpiry: true };
  }
  const expires = Date.parse(manifest.expires);
  // A date that cannot be read counts as expired: the check fails closed.
  if (Number.isNaN(expires) || policy.now > expires) {
    throw new UpdateStop(
      'bad_manifest',
      `the manifest expired at ${manifest.expires}`,
      manifest.version,
    );
  }
  return { noExpiry: false };
}

/** The three checks of a manifest that is about to be acted on, in this order: channel, minimum version, expiry. */
export function checkManifestPolicy(
  manifest: UpdateManifest,
  policy: ManifestPolicy,
): { readonly noExpiry: boolean } {
  checkChannel(manifest, policy);
  checkMinVersion(manifest, policy);
  return checkExpiry(manifest, policy);
}
