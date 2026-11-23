// SPDX-License-Identifier: MPL-2.0
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  UpdateManifestSchema,
  type ManifestAsset,
  type UpdateManifest,
} from '@otheater/daemon/updates/manifest';
import { sha256Hex } from '@otheater/daemon/updates/verify';
import { isTargetId, type TargetId } from './targets.js';

/**
 * `assemble-manifest` (Phase 10, P9): builds the `manifest.json` of a release from the files in a
 * folder. The shape is the one of `packages/daemon/src/updates/manifest.ts` (the schema is imported, not
 * copied), so a manifest made here is one the daemon and `install.sh` read. The bytes written are the
 * bytes the signature covers: there is no canonical form to recompute (docs/21, "Formato dos
 * artefatos e da assinatura").
 */

export type AssetKind = ManifestAsset['kind'];
export type ReleaseChannel = UpdateManifest['channel'];
export const RELEASE_CHANNELS = ['stable', 'beta'] as const satisfies readonly ReleaseChannel[];

/** One file of the release, before it is described in the manifest. */
export interface AssetFile {
  readonly platform: TargetId;
  readonly kind: AssetKind;
  /** Where the file is. Its base name is the name in the manifest. */
  readonly file: string;
}

export interface AssembleOptions {
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly assets: readonly AssetFile[];
  /** Platforms that must have an executable in the manifest (a release without one is refused). */
  readonly requiredPlatforms?: readonly TargetId[];
  /** The schema versions of the store and the telemetry base this release needs (P8 decides the backup). */
  readonly schemas?: { readonly store: number; readonly telemetry: number } | undefined;
  readonly minVersion?: string | undefined;
  /**
   * How many days the manifest is valid for (P8a, N288): `expires` is `now` plus that. Absent or
   * `null`: the manifest has no `expires` (it never expires). The release config says the default.
   */
  readonly validityDays?: number | null | undefined;
  /** Default: now. The clock of the tests. */
  readonly now?: Date | undefined;
}

export class ManifestAssemblyError extends Error {}

export interface AssembledManifest {
  readonly manifest: UpdateManifest;
  /** The exact bytes of `manifest.json`: what is signed. */
  readonly bytes: Buffer;
}

/** `otheater-<platform>[.exe]`: the executable of a platform as the release names it. */
export function executableAssetName(platform: TargetId): string {
  return platform === 'win32-x64' ? `otheater-${platform}.exe` : `otheater-${platform}`;
}

/** `THIRD_PARTY_NOTICES-<platform>.md`: the file `install.sh` looks for by name. */
export function noticesAssetName(platform: TargetId): string {
  return `THIRD_PARTY_NOTICES-${platform}.md`;
}

/** `OTheater-<semver>-win32-x64.msi` (the semver without build metadata, as installer/wix/build.ps1 names it). */
export function msiAssetName(version: string): string {
  return `OTheater-${version.split('+')[0] ?? version}-win32-x64.msi`;
}

/**
 * Finds the files of a release in `dir` by the names above: an executable and the notices of each
 * platform, and the `.msi` of `version`. A name that is not one of these is ignored (the folder also
 * holds the manifest, the signature and `install.sh`).
 */
export async function discoverAssets(dir: string, version: string): Promise<AssetFile[]> {
  const found: AssetFile[] = [];
  const names = await readdir(dir);
  for (const name of [...names].sort()) {
    const file = path.join(dir, name);
    const exe = /^otheater-(.+?)(?:\.exe)?$/.exec(name)?.[1];
    if (exe !== undefined && isTargetId(exe) && name === executableAssetName(exe)) {
      found.push({ platform: exe, kind: 'exe', file });
      continue;
    }
    const notices = /^THIRD_PARTY_NOTICES-(.+)\.md$/.exec(name)?.[1];
    if (notices !== undefined && isTargetId(notices)) {
      found.push({ platform: notices, kind: 'notices', file });
      continue;
    }
    if (name === msiAssetName(version)) found.push({ platform: 'win32-x64', kind: 'msi', file });
  }
  return found;
}

async function describeAsset(asset: AssetFile): Promise<ManifestAsset> {
  const name = path.basename(asset.file);
  let bytes: Buffer;
  try {
    bytes = await readFile(asset.file);
  } catch {
    throw new ManifestAssemblyError(
      `the file of ${asset.platform} ${asset.kind} is not there: ${name}`,
    );
  }
  return {
    platform: asset.platform,
    kind: asset.kind,
    name,
    size: bytes.length,
    sha256: sha256Hex(bytes),
  };
}

/** Builds the manifest and its bytes. Throws {@link ManifestAssemblyError} when the release is incomplete or wrong. */
export async function assembleManifest(options: AssembleOptions): Promise<AssembledManifest> {
  const required = options.requiredPlatforms ?? [];
  for (const platform of required) {
    if (!options.assets.some((asset) => asset.platform === platform && asset.kind === 'exe')) {
      throw new ManifestAssemblyError(`no executable for ${platform}: the release is incomplete`);
    }
  }
  const assets: ManifestAsset[] = [];
  for (const asset of options.assets) assets.push(await describeAsset(asset));
  const names = new Set(assets.map((asset) => asset.name));
  if (names.size !== assets.length)
    throw new ManifestAssemblyError('two assets have the same name');

  const now = options.now ?? new Date();
  const days = options.validityDays;
  if (days !== undefined && days !== null && (!Number.isInteger(days) || days < 1)) {
    throw new ManifestAssemblyError(
      'the validity of the manifest is a whole number of days (1 or more)',
    );
  }
  const candidate = {
    schema: 1,
    version: options.version,
    channel: options.channel,
    publishedAt: now.toISOString(),
    ...(days === undefined || days === null
      ? {}
      : { expires: new Date(now.getTime() + days * 86_400_000).toISOString() }),
    assets,
    ...(options.schemas === undefined ? {} : { schemas: options.schemas }),
    ...(options.minVersion === undefined ? {} : { minVersion: options.minVersion }),
  };
  const parsed = UpdateManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? '' : `${first.path.join('.')}: ${first.message}`;
    throw new ManifestAssemblyError(`the manifest is not valid (${where})`);
  }
  const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  return { manifest: parsed.data, bytes };
}

/** Assembles the manifest of the files in `dir` and writes it to `out`. */
export async function assembleFromDirectory(options: {
  readonly dir: string;
  readonly out: string;
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly requiredPlatforms?: readonly TargetId[];
  readonly schemas?: AssembleOptions['schemas'];
  readonly minVersion?: string | undefined;
  readonly validityDays?: number | null | undefined;
  readonly now?: Date | undefined;
}): Promise<AssembledManifest> {
  if (!(await stat(options.dir).catch(() => undefined))?.isDirectory()) {
    throw new ManifestAssemblyError(`not a folder: ${options.dir}`);
  }
  const assets = await discoverAssets(options.dir, options.version);
  const assembled = await assembleManifest({ ...options, assets });
  await writeFile(options.out, assembled.bytes);
  return assembled;
}
