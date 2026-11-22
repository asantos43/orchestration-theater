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
 */
export interface ReleaseConfig {
  readonly targets: readonly TargetId[];
  readonly versionOverride: string | null;
  readonly notices: NoticesMode;
}

export const NOTICES_MODES = ['per_platform', 'root_only'] as const;
export type NoticesMode = (typeof NOTICES_MODES)[number];

export const DEFAULT_RELEASE_CONFIG: ReleaseConfig = {
  targets: ['linux-x64', 'win32-x64', 'darwin-arm64'],
  versionOverride: null,
  notices: 'per_platform',
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
    (key) => key !== 'targets' && key !== 'versionOverride' && key !== 'notices',
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
  return { targets, versionOverride, notices };
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
