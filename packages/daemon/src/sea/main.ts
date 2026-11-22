// SPDX-License-Identifier: MPL-2.0
import { pathToFileURL } from 'node:url';
import { SEA_INTERNAL_PREFIX } from '@otheater/client/node';
import { entry } from '../cli.js';
import { runShimMain } from '../mcp/stdio-shim.js';
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

/** Exit code when `run-adapter` has no script or the script does not load. [proposta] */
export const EXIT_ADAPTER_FAILED = 4;

/** The faces that need what the daemon package may not import (the TUI) or that arrive later. */
export interface SeaHandlers {
  /** `tui`: runs the terminal interface; `argv` is what follows the mode. */
  readonly tui: (argv: readonly string[]) => Promise<void>;
  /** The `ot` CLI. Default: the one of `cli.ts`. */
  readonly cli?: (() => Promise<void>) | undefined;
  /** `mcp-shim`. Default: the one of `mcp/stdio-shim.ts`. */
  readonly mcpShim?: (() => Promise<void>) | undefined;
  /** `verify-release` (P7) and `apply-update` (P8); absent means "not available". */
  readonly verifyRelease?: ((argv: readonly string[]) => Promise<void>) | undefined;
  readonly applyUpdate?: ((argv: readonly string[]) => Promise<void>) | undefined;
  /**
   * `run-adapter`: loads the entry script of an ACP adapter; `argv` is what follows the mode, the
   * script first. Default: {@link runAdapterEntry}.
   */
  readonly runAdapter?: ((argv: readonly string[]) => Promise<void>) | undefined;
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
 * `run-adapter` (P13): the entry script of an ACP adapter is an ES module (with top-level `await`)
 * that reads `process.argv` and the environment as if started by `node <script> ...args`, so
 * `argv[1]` becomes the script and what follows stays as the adapter's arguments. It resolves when
 * the module has been evaluated; the adapter then keeps the process alive on its own stdio.
 * Whether the single executable's Node can `import()` a module from disk is [N] until a SEA build
 * runs it (`tools/release` smoke).
 */
export async function runAdapterEntry(argv: readonly string[]): Promise<void> {
  const [script, ...args] = argv;
  if (script === undefined || script === '') throw new Error('run-adapter needs the entry script');
  process.argv = [process.argv[0] ?? process.execPath, script, ...args];
  await import(pathToFileURL(script).href);
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
    case 'run-adapter':
      try {
        await (handlers.runAdapter ?? runAdapterEntry)(parsed.rest);
      } catch (error) {
        stderr.write(
          `otheater: run-adapter failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = EXIT_ADAPTER_FAILED;
      }
      return;
    case 'verify-release':
    case 'apply-update': {
      const run = parsed.mode === 'verify-release' ? handlers.verifyRelease : handlers.applyUpdate;
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
