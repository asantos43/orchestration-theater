// SPDX-License-Identifier: MPL-2.0
import type { OtLauncher } from '../profiles/shims.js';
import type { ServiceCommand } from './types.js';

/** The id of the service: reverse-DNS on macOS (launchd label), a plain name elsewhere. [proposta] */
export function serviceIdOf(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'com.otheater.daemon' : 'otheater-daemon';
}

/**
 * THE one place that says what the service (and the daemon child of `ot tui`) runs. Before the
 * single executable (Phase 10, P1) it is the checkout: Node and the entry of `ot`, the same pair
 * `otLauncherOf()` of `cli.ts` hands to the commands by profile. P1 replaces the body of this
 * function by `resolveSelfCommand()` (the executable plus its mode, or Node plus the script), and
 * nothing else of the service changes. `undefined` when the entry of `ot` cannot be known.
 */
export function resolveServiceCommand(
  launcher: OtLauncher | undefined,
): ServiceCommand | undefined {
  if (launcher === undefined) return undefined;
  return { command: launcher.node, args: [launcher.entry] };
}

/** `<self> daemon --data-dir <dir>`: the data folder is explicit, because a service has no `OT_DATA_DIR`. */
export function daemonCommandOf(self: ServiceCommand, dataDir: string): ServiceCommand {
  return { command: self.command, args: [...self.args, 'daemon', '--data-dir', dataDir] };
}
