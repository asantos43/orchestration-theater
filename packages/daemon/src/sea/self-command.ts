// SPDX-License-Identifier: MPL-2.0
import { realpathSync } from 'node:fs';
import { SEA_INTERNAL_PREFIX, isSeaProcess } from '@otheater/client/node';
import { STDIO_SHIM_PATH } from '../mcp/stdio-shim.js';

/**
 * The internal modes of the single executable (Phase 10, P1) [proposta]. The mode is the first
 * argument, `--ot-internal=<mode>`, so nothing the person types can collide with it; no mode is the
 * `ot` CLI.
 * - `tui`: the terminal interface (`@otheater/tui`'s `runTuiMain`);
 * - `mcp-shim`: the stdio shim of the framework MCP server;
 * - `verify-release`: checks a release manifest against the key built into the executable (P7);
 * - `apply-update`: the updater (P8).
 */
export const SEA_MODES = ['tui', 'mcp-shim', 'verify-release', 'apply-update'] as const;
export type SeaMode = (typeof SEA_MODES)[number];

export function isSeaMode(value: string): value is SeaMode {
  return (SEA_MODES as readonly string[]).includes(value);
}

/** What to run to start another copy of this program: a command and the arguments before the user's. */
export interface SelfCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface SelfCommandDeps {
  /** Default: {@link isSeaProcess}. */
  readonly sea?: boolean | undefined;
  /** Default: `process.execPath`. */
  readonly execPath?: string | undefined;
  /** The script that is running (`process.argv[1]`); default: the real one. Checkout only. */
  readonly invoked?: string | undefined;
  /** Where the shim script is in a checkout. Default: `dist/mcp/stdio-shim.js`. */
  readonly shimScript?: string | undefined;
  readonly realpath?: ((path: string) => string) | undefined;
}

/** The argument that selects `mode`. */
export function seaModeArgument(mode: SeaMode): string {
  return `${SEA_INTERNAL_PREFIX}${mode}`;
}

/**
 * The one place that decides how this program starts itself again, in the two worlds [proposta]:
 * - checkout (`node dist/cli.js`): the Node that runs this plus the script of the mode: the entry
 *   script that is running for no mode (the `ot` CLI), the shim script for `mcp-shim`. No script is
 *   known for the other modes, which exist only in the executable, so they give `undefined`;
 * - single executable: the executable itself plus `--ot-internal=<mode>` (no argument for the CLI).
 * `undefined` also means "the entry script is not known" (a test, an embedder): the caller then does
 * without whatever needed the relaunch.
 */
export function resolveSelfCommand(
  mode?: SeaMode,
  deps: SelfCommandDeps = {},
): SelfCommand | undefined {
  const command = deps.execPath ?? process.execPath;
  if (deps.sea ?? isSeaProcess()) {
    return { command, args: mode === undefined ? [] : [seaModeArgument(mode)] };
  }
  const realpath = deps.realpath ?? realpathSync;
  if (mode === undefined) {
    const invoked = 'invoked' in deps ? deps.invoked : process.argv[1];
    if (invoked === undefined) return undefined;
    try {
      return { command, args: [realpath(invoked)] };
    } catch {
      return undefined;
    }
  }
  if (mode === 'mcp-shim') return { command, args: [deps.shimScript ?? STDIO_SHIM_PATH] };
  return undefined;
}
