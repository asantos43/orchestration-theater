// SPDX-License-Identifier: MPL-2.0
import { UPDATE_CHANNELS } from '@otheater/protocol';
import semver from 'semver';
import { z } from 'zod';
import { UpdateStop } from './errors.js';

/**
 * The manifest of a release (Phase 10, P7; docs/21, "Formato dos artefatos e da assinatura"):
 * `manifest.json`, whose exact bytes the Ed25519 signature `manifest.json.sig` covers. The SHA-256
 * of every executable is inside, so one signature covers everything. [proposta] The shape of
 * `schemas` (the version of the store and of the telemetry base that the release needs; the next
 * step uses it to decide on the backup before a migration; absent: the backup is made). Fields the
 * daemon does not know are ignored, so a later release can add one; a field it needs but cannot
 * read makes the manifest bad.
 *
 * A manifest is read only after its signature checked ({@link parseManifest} is called by the
 * checker in that order); this schema is the second line, for a manifest that is signed and wrong.
 */

/** The most an executable may weigh (a signed manifest that asks for more is refused). */
export const MAX_ASSET_BYTES = 1024 ** 3;
/** The most the manifest and its signature may weigh. */
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_SIGNATURE_BYTES = 4 * 1024;

/**
 * `exe` is the executable an update swaps in, `msi` the Windows installer, `notices` the third-party
 * notices of a platform (`THIRD_PARTY_NOTICES-<platform>.md`, which `install.sh` reads from the signed
 * manifest; P9 lists them, so the schema has to accept the kind).
 */
export const UPDATE_ASSET_KINDS = ['exe', 'msi', 'notices'] as const;

/** A file name of an asset: one segment, never a path. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const SemverSchema = z
  .string()
  .max(64)
  .refine((text) => semver.valid(text) === text, { message: 'expected a semantic version' });

export const ManifestAssetSchema = z.object({
  platform: z.string().min(1).max(32),
  kind: z.enum(UPDATE_ASSET_KINDS),
  name: z.string().regex(ASSET_NAME),
  size: z.int().min(1).max(MAX_ASSET_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ManifestAsset = z.infer<typeof ManifestAssetSchema>;

export const UpdateManifestSchema = z.object({
  schema: z.literal(1),
  version: SemverSchema,
  channel: z.enum(UPDATE_CHANNELS),
  publishedAt: z.iso.datetime({ offset: true }),
  assets: z.array(ManifestAssetSchema).min(1).max(32),
  schemas: z.object({ store: z.int().min(0), telemetry: z.int().min(0) }).optional(),
  minVersion: SemverSchema.optional(),
});
export type UpdateManifest = z.infer<typeof UpdateManifestSchema>;

/** Reads the bytes of a manifest whose signature already checked; `bad_manifest` when they are not one. */
export function parseManifest(bytes: Uint8Array): UpdateManifest {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new UpdateStop('bad_manifest', 'the manifest is not JSON');
  }
  const parsed = UpdateManifestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? '' : `${first.path.join('.')}: ${first.message}`;
    throw new UpdateStop('bad_manifest', `the manifest is not valid (${where})`);
  }
  return parsed.data;
}

/** The executable of `platform` in the manifest (the `.msi` is for the installer, not for an update). */
export function assetFor(manifest: UpdateManifest, platform: string): ManifestAsset | undefined {
  return manifest.assets.find((asset) => asset.platform === platform && asset.kind === 'exe');
}
