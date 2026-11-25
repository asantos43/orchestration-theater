// SPDX-License-Identifier: MPL-2.0
import type { OtLauncher } from '../profiles/shims.js';
import type { ServiceCommand } from './types.js';

/** The id of the service: reverse-DNS on macOS (launchd label), a plain name elsewhere. [proposta] */
export function serviceIdOf(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'com.otheater.daemon' : 'otheater-daemon';
}

/**
 * THE one place that says what the service (and the daemon child of `ot tui`) runs: the launcher of
 * `ot` that `otLauncherOf()` of `cli.ts` builds from `resolveSelfCommand()` (Phase 10, P1). In a
 * checkout, Node and the entry of `ot`; in the single executable, the executable alone (no entry,
 * no `--ot-internal` mode: the daemon is the `ot` CLI). `undefined` when `ot` cannot be known.
 */
export function resolveServiceCommand(
  launcher: OtLauncher | undefined,
): ServiceCommand | undefined {
  if (launcher === undefined) return undefined;
  return { command: launcher.node, args: launcher.entry === undefined ? [] : [launcher.entry] };
}

/**
 * `<self> daemon --data-dir <dir> --non-interactive`: the data folder is explicit, because a service
 * has no `OT_DATA_DIR`; and nothing is asked, because nobody is there to answer (on Windows the
 * logon task runs under `conhost --headless`, whose stdin is a TTY, so the daemon used to wait for a
 * master password forever and never open its API).
 */
export function daemonCommandOf(self: ServiceCommand, dataDir: string): ServiceCommand {
  return {
    command: self.command,
    args: [...self.args, 'daemon', '--data-dir', dataDir, '--non-interactive'],
  };
}
