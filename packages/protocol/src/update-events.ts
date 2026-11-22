// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * The `daemon.update` event (Phase 10, P7; architecture 5.21, "Atualização automática", N73). One
 * event per step of the search for a new version of OTheater: found, downloaded, verified,
 * rejected, skipped or failed. Every payload is a strict object. [proposta] The names, the phases,
 * the reasons and the fields below; the architecture only asks for "the version found, the download,
 * the check, the application and the return".
 *
 * The apply steps (`applying`, `applied`, `rolled_back`) join the phases in the next step (P8); the
 * schema version stays 1 because a phase is added, and nothing that reads the event today reads a
 * phase it does not know.
 */

/** Where the search is. */
export const UPDATE_PHASES = [
  /** A newer version is in a manifest whose signature checked. */
  'found',
  /** The executable of the platform came down to a partial file (not trusted yet). */
  'downloaded',
  /** Size and SHA-256 checked: the file is stored and the version is ready to apply. */
  'verified',
  /** The version was refused; `reason` says why. Nothing of it stays on disk. */
  'rejected',
  /** Nothing was done and nothing is wrong (`reason` says why: no key, no file for this platform). */
  'skipped',
  /** The search could not be made (`reason`: no network, an answer the origin should not give). */
  'failed',
] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

/** The modes of `updates.mode`; `off` never searches, so it is not a mode an event is written in. */
export const UPDATE_EVENT_MODES = ['auto', 'notify', 'check'] as const;

/** The channels of `updates.channel`. */
export const UPDATE_CHANNELS = ['stable', 'beta'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/**
 * Why a version was refused, skipped or not searched for. The codes are the ones of the
 * architecture (signature, SHA-256, size, version that is not newer, wrong channel, no network) and
 * the ones the same checks need.
 * - `signature`: the Ed25519 signature of the manifest did not check with the embedded key;
 * - `sha256`, `size`: the file is not the one the (signed) manifest describes;
 * - `version_not_newer`: the manifest is of an older version (a replayed manifest);
 * - `wrong_channel`: the manifest is of another channel than `updates.channel`;
 * - `bad_manifest`: the signature checked and the content is not a manifest of this format;
 * - `no_network`: the origin could not be reached (or took too long);
 * - `bad_response`: the origin answered what it should not (a status, a size, a redirect to plain
 *   HTTP, an unknown release);
 * - `no_public_key`: the build has no valid public key (the placeholder), so nothing can be checked;
 * - `no_asset`: the manifest has no executable for this platform;
 * - `below_min_version`: the installed version is older than `minVersion`, the direct update is not
 *   supported from it;
 * - `storage`: the file could not be written to (or read from) the staging folder.
 */
export const UPDATE_REASONS = [
  'signature',
  'sha256',
  'size',
  'version_not_newer',
  'wrong_channel',
  'bad_manifest',
  'no_network',
  'bad_response',
  'no_public_key',
  'no_asset',
  'below_min_version',
  'storage',
] as const;
export type UpdateReason = (typeof UPDATE_REASONS)[number];

const version = z.string().min(1).max(64);

/** `daemon.update`. */
export const DaemonUpdatePayloadSchema = z.strictObject({
  phase: z.enum(UPDATE_PHASES),
  /** The version the step is about; `null` when the search did not get as far as reading one. */
  version: version.nullable(),
  /** The version installed. */
  current: version,
  channel: z.enum(UPDATE_CHANNELS),
  /** `updates.mode`, as written. */
  mode: z.enum(UPDATE_EVENT_MODES),
  /**
   * The mode the daemon acted in. It differs from `mode` when the daemon cannot do what the mode
   * says: `auto` acts as `notify` until the step that applies versions exists, and an installation
   * that is not the daemon's own (a checkout, run by Node) acts as `check`.
   */
  effectiveMode: z.enum(UPDATE_EVENT_MODES),
  /** For `rejected`, `skipped` and `failed`; `null` for the other phases. */
  reason: z.enum(UPDATE_REASONS).nullable(),
});
export type DaemonUpdatePayload = z.infer<typeof DaemonUpdatePayloadSchema>;
