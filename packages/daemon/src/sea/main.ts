// SPDX-License-Identifier: MPL-2.0
import { SEA_INTERNAL_PREFIX } from '@otheater/client/node';
import { entry } from '../cli.js';
import { runShimMain } from '../mcp/stdio-shim.js';
import { runApplyUpdate } from '../updates/apply/main.js';
import { isSeaMode, type SeaMode } from './self-command.js';

/**
 * The entry of the single executable (Phase 10, P1; architecture 10). One program with several
 * faces, chosen by the first argument (`--ot-internal=<mode>`, see {@link SeaMode}); with none, it
 * is the `ot` CLI. It is a function and not a script because the bundle is one CommonJS file, which
 * has no top-level `await`; `tools/release` generates the file that calls {@link runSeaMain}.
 */

/** Exit code of a mode this build does not have. [proposta] */
export const EXIT_NOT_AVAILABLE = 3;
/** Exit code of an `--ot-internal=` value that is not a mode. */
export const EXIT_UNKNOWN_MODE = 2;

/** The faces that need what the daemon package may not import (the TUI) or that arrive later. */
export interface SeaHandlers {
  /** `tui`: runs the terminal interface; `argv` is what follows the mode. */
  readonly tui: (argv: readonly string[]) => Promise<void>;
  /** The `ot` CLI. Default: the one of `cli.ts`. */
  readonly cli?: (() => Promise<void>) | undefined;
  /** `mcp-shim`. Default: the one of `mcp/stdio-shim.ts`. */
  readonly mcpShim?: (() => Promise<void>) | undefined;
  /** `verify-release` (P7); absent means "not available". `apply-update` (P8) defaults to the applier. */
  readonly verifyRelease?: ((argv: readonly string[]) => Promise<void>) | undefined;
  readonly applyUpdate?: ((argv: readonly string[]) => Promise<void>) | undefined;
  /** Where the messages go. Default: `process.stderr`. */
  readonly stderr?: { write(text: string): unknown } | undefined;
}

export type ParsedInternal =
  | { readonly kind: 'cli' }
  | { readonly kind: 'mode'; readonly mode: SeaMode; readonly rest: readonly string[] }
  | { readonly kind: 'unknown'; readonly value: string };

/** Reads the mode from the arguments after the executable's name: only the first one counts. */
export function parseInternalMode(argv: readonly string[]): ParsedInternal {
  const first = argv[0];
  if (!first?.startsWith(SEA_INTERNAL_PREFIX)) return { kind: 'cli' };
  const value = first.slice(SEA_INTERNAL_PREFIX.length);
  return isSeaMode(value)
    ? { kind: 'mode', mode: value, rest: argv.slice(1) }
    : { kind: 'unknown', value };
}

/**
 * Runs the face the arguments ask for. `argv` is `process.argv.slice(2)`. The `cli` face reads
 * `process.argv` itself, like the script does, and sets its own exit code.
 */
export async function runSeaMain(argv: readonly string[], handlers: SeaHandlers): Promise<void> {
  const stderr = handlers.stderr ?? process.stderr;
  const parsed = parseInternalMode(argv);
  if (parsed.kind === 'cli') {
    await (handlers.cli ?? entry)();
    return;
  }
  if (parsed.kind === 'unknown') {
    stderr.write(`otheater: unknown internal mode "${parsed.value}"\n`);
    process.exitCode = EXIT_UNKNOWN_MODE;
    return;
  }
  switch (parsed.mode) {
    case 'tui':
      await handlers.tui(parsed.rest);
      return;
    case 'mcp-shim':
      await (handlers.mcpShim ?? runShimMain)();
      return;
    case 'verify-release':
    case 'apply-update': {
      const run =
        parsed.mode === 'verify-release'
          ? handlers.verifyRelease
          : (handlers.applyUpdate ?? runApplyUpdate);
      if (run === undefined) {
        stderr.write(
          `otheater: the internal mode "${parsed.mode}" is not available in this build\n`,
        );
        process.exitCode = EXIT_NOT_AVAILABLE;
        return;
      }
      await run(parsed.rest);
    }
  }
}
