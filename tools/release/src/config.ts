// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { isTargetId, TARGET_IDS, type TargetId } from './targets.js';

/**
 * `release.config.json` [proposta]: what the release build reads. It is a file and not code because the
 * workflow and a person at a terminal must agree on it.
 *
 * - `targets`: the platforms built by default (`otheater-release build` without `--target`).
 * - `versionOverride`: a version that replaces the one of `packages/daemon/package.json` in the
 *   executable (`--version`, the user agent). `null` keeps the package version. The release (P9) sets it
 *   from the tag; a build for a test sets it to tell the executables apart.
 * - `notices` (P10): what the build leaves next to the executable as `THIRD_PARTY_NOTICES-<platform>.md`.
 *   `per_platform` (default) generates the file of the platform from its production graph and the
 *   bundle (`tools/verify`); `root_only` copies the `THIRD_PARTY_NOTICES.md` of the repository root (the
 *   Linux one, N72) under the same name, so what consumes the file does not care which mode ran.
 * - `manifestValidityDays` (P8a, N288) [proposta]: how long the signed manifest is valid, in days from
 *   `assemble`; the manifest carries it as `expires` and the daemon and `install.sh` refuse a manifest
 *   after it. Default 365. `null` writes no `expires` (the manifest never expires). The command
 *   line (`assemble --valid-days <n|none>`) overrides it.
 * - `signing` (P11, N247) [proposta]: the code signing of the release, both OFF by default (no account
 *   and no certificate exist; docs/22). The build itself never signs: `.github/workflows/release.yml`
 *   reads these keys (the repository variables `OT_SIGNING_WINDOWS` and `OT_SIGNING_MACOS`, when set,
 *   win over the file) and runs the signing steps only when a key is on.
 *   - `signing.windows`: `off` or `signtool` (signs the .exe and the .msi with a certificate from secrets).
 *   - `signing.macos`: `off` or `codesign` (signs with a Developer ID certificate and notarizes). The
 *     ad hoc signature the build always applies to the arm64 executable (P1) is not this: it is no
 *     certificate and no identity.
 */
export interface ReleaseConfig {
  readonly targets: readonly TargetId[];
  readonly versionOverride: string | null;
  readonly notices: NoticesMode;
  readonly manifestValidityDays: number | null;
  readonly signing: SigningConfig;
}

export const WINDOWS_SIGNING_MODES = ['off', 'signtool'] as const;
export type WindowsSigningMode = (typeof WINDOWS_SIGNING_MODES)[number];
export const MACOS_SIGNING_MODES = ['off', 'codesign'] as const;
export type MacosSigningMode = (typeof MACOS_SIGNING_MODES)[number];

export interface SigningConfig {
  readonly windows: WindowsSigningMode;
  readonly macos: MacosSigningMode;
}

/** The longest validity `manifestValidityDays` takes (ten years). */
export const MAX_MANIFEST_VALIDITY_DAYS = 3650;

export const NOTICES_MODES = ['per_platform', 'root_only'] as const;
export type NoticesMode = (typeof NOTICES_MODES)[number];

export const DEFAULT_RELEASE_CONFIG: ReleaseConfig = {
  targets: ['linux-x64', 'win32-x64', 'darwin-arm64'],
  versionOverride: null,
  notices: 'per_platform',
  manifestValidityDays: 365,
  signing: { windows: 'off', macos: 'off' },
};

/** A version that is safe to bake into the bundle and to print: dotted numbers, an optional tag. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class ReleaseConfigError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a parsed `release.config.json`. A missing key takes its default; a wrong one is an error. */
export function parseReleaseConfig(raw: unknown): ReleaseConfig {
  if (!isRecord(raw)) throw new ReleaseConfigError('release.config.json must be an object');
  const unknown = Object.keys(raw).filter(
    (key) =>
      key !== 'targets' &&
      key !== 'versionOverride' &&
      key !== 'notices' &&
      key !== 'manifestValidityDays' &&
      key !== 'signing',
  );
  if (unknown.length > 0) {
    throw new ReleaseConfigError(`release.config.json has unknown keys: ${unknown.join(', ')}`);
  }
  let targets: readonly TargetId[] = DEFAULT_RELEASE_CONFIG.targets;
  if (raw.targets !== undefined) {
    if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
      throw new ReleaseConfigError('"targets" must be a non-empty list');
    }
    const list = raw.targets as unknown[];
    const bad = list.filter((value) => !isTargetId(value));
    if (bad.length > 0) {
      throw new ReleaseConfigError(
        `"targets" has unknown platforms (${bad.map(String).join(', ')}); known: ${TARGET_IDS.join(', ')}`,
      );
    }
    targets = [...new Set(list as TargetId[])];
  }
  let versionOverride: string | null = DEFAULT_RELEASE_CONFIG.versionOverride;
  if (raw.versionOverride !== undefined && raw.versionOverride !== null) {
    if (typeof raw.versionOverride !== 'string' || !VERSION_PATTERN.test(raw.versionOverride)) {
      throw new ReleaseConfigError('"versionOverride" must be null or a version like 1.2.3');
    }
    versionOverride = raw.versionOverride;
  }
  let notices: NoticesMode = DEFAULT_RELEASE_CONFIG.notices;
  if (raw.notices !== undefined) {
    const mode = raw.notices;
    if (typeof mode !== 'string' || !(NOTICES_MODES as readonly string[]).includes(mode)) {
      throw new ReleaseConfigError(`"notices" must be one of: ${NOTICES_MODES.join(', ')}`);
    }
    notices = mode as NoticesMode;
  }
  let manifestValidityDays: number | null = DEFAULT_RELEASE_CONFIG.manifestValidityDays;
  if (raw.manifestValidityDays !== undefined) {
    const days = raw.manifestValidityDays;
    if (days === null) {
      manifestValidityDays = null;
    } else if (
      typeof days !== 'number' ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > MAX_MANIFEST_VALIDITY_DAYS
    ) {
      throw new ReleaseConfigError(
        `"manifestValidityDays" must be null or a whole number of days from 1 to ${String(MAX_MANIFEST_VALIDITY_DAYS)}`,
      );
    } else {
      manifestValidityDays = days;
    }
  }
  return {
    targets,
    versionOverride,
    notices,
    manifestValidityDays,
    signing: parseSigning(raw.signing),
  };
}

/** `signing`: a missing key takes `off`; an unknown key or mode is an error, never a silent `off`. */
function parseSigning(raw: unknown): SigningConfig {
  if (raw === undefined) return DEFAULT_RELEASE_CONFIG.signing;
  if (!isRecord(raw)) throw new ReleaseConfigError('"signing" must be an object');
  const unknown = Object.keys(raw).filter((key) => key !== 'windows' && key !== 'macos');
  if (unknown.length > 0) {
    throw new ReleaseConfigError(`"signing" has unknown keys: ${unknown.join(', ')}`);
  }
  let windows: WindowsSigningMode = DEFAULT_RELEASE_CONFIG.signing.windows;
  if (raw.windows !== undefined) {
    const mode = raw.windows;
    if (typeof mode !== 'string' || !(WINDOWS_SIGNING_MODES as readonly string[]).includes(mode)) {
      throw new ReleaseConfigError(
        `"signing.windows" must be one of: ${WINDOWS_SIGNING_MODES.join(', ')}`,
      );
    }
    windows = mode as WindowsSigningMode;
  }
  let macos: MacosSigningMode = DEFAULT_RELEASE_CONFIG.signing.macos;
  if (raw.macos !== undefined) {
    const mode = raw.macos;
    if (typeof mode !== 'string' || !(MACOS_SIGNING_MODES as readonly string[]).includes(mode)) {
      throw new ReleaseConfigError(
        `"signing.macos" must be one of: ${MACOS_SIGNING_MODES.join(', ')}`,
      );
    }
    macos = mode as MacosSigningMode;
  }
  return { windows, macos };
}

export function loadReleaseConfig(file: string): ReleaseConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new ReleaseConfigError(`Cannot read ${file}: ${(cause as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ReleaseConfigError(`${file} is not JSON: ${(cause as Error).message}`);
  }
  return parseReleaseConfig(raw);
}
