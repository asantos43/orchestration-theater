// SPDX-License-Identifier: MPL-2.0

/**
 * The platforms the single executable is built for (Phase 10, P1; architecture 10). Each one is built
 * on a runner of its own (`.github/workflows/dist-sea.yml`): the Node binary that is injected and the
 * native addons that travel inside it have to be the ones of the platform.
 */
export const TARGET_IDS = ['linux-x64', 'win32-x64', 'darwin-arm64'] as const;
export type TargetId = (typeof TARGET_IDS)[number];

export interface TargetInfo {
  readonly id: TargetId;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The file name of the executable. */
  readonly executable: string;
  /** `better-sqlite3` ships one prebuilt addon per platform in `prebuilds/<name>.node`. */
  readonly sqlitePrebuild: string;
  /** The `@napi-rs/keyring-<platform>` package that holds the addon of the platform, and its file. */
  readonly keyringPackage: string;
  readonly keyringFile: string;
}

const TARGETS: Readonly<Record<TargetId, TargetInfo>> = {
  'linux-x64': {
    id: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    executable: 'otheater',
    sqlitePrebuild: 'linux-x64',
    keyringPackage: '@napi-rs/keyring-linux-x64-gnu',
    keyringFile: 'keyring.linux-x64-gnu.node',
  },
  'win32-x64': {
    id: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    executable: 'otheater.exe',
    sqlitePrebuild: 'win32-x64',
    keyringPackage: '@napi-rs/keyring-win32-x64-msvc',
    keyringFile: 'keyring.win32-x64-msvc.node',
  },
  'darwin-arm64': {
    id: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    executable: 'otheater',
    sqlitePrebuild: 'darwin-arm64',
    keyringPackage: '@napi-rs/keyring-darwin-arm64',
    keyringFile: 'keyring.darwin-arm64.node',
  },
};

export function isTargetId(value: unknown): value is TargetId {
  return typeof value === 'string' && (TARGET_IDS as readonly string[]).includes(value);
}

export function targetInfo(id: TargetId): TargetInfo {
  return TARGETS[id];
}

/** The target of the machine that runs the build, when it is one of the supported ones. */
export function hostTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): TargetId | undefined {
  return TARGET_IDS.find((id) => TARGETS[id].platform === platform && TARGETS[id].arch === arch);
}
