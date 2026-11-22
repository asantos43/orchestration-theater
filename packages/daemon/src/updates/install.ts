// SPDX-License-Identifier: MPL-2.0
import * as sea from 'node:sea';
import type { UPDATE_INSTALL_KINDS } from '@otheater/protocol';

/**
 * `own`: the daemon is the executable of OTheater itself (a Node single executable), which an
 * update can replace; `checkout`: Node runs the sources of a clone, which an update must not touch,
 * so the daemon only says a new version exists (docs/21 P7, N248). No npm and no winget in v1.
 * [proposta] Being a single executable is enough here; that the file is in the folder of the
 * installer (`.msi` or `install.sh`) is a condition the step that applies a version checks, because
 * it is the one that knows the install folder (P4 and P5).
 */
export type UpdateInstallKind = (typeof UPDATE_INSTALL_KINDS)[number];

export function detectInstallKind(): UpdateInstallKind {
  try {
    return sea.isSea() ? 'own' : 'checkout';
  } catch {
    return 'checkout';
  }
}

/** The platform id of the executables of a release: `linux-x64`, `win32-x64` or `darwin-arm64`. */
export function updatePlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}
