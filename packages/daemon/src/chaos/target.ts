// SPDX-License-Identifier: MPL-2.0
// Part of the chaos harness (Phase 11, P12): test only, excluded from the build of the package.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What the chaos suite runs over (Phase 11, P12; docs/23, D6/N283). [proposta] The choice is a
 * variable with modes, not a constant:
 * - `OT_CHAOS_TARGET=source` (default): the daemon of the build output (`packages/daemon/dist`),
 *   started by `node` with the program of a fixture that injects the fakes in process (the clock, the
 *   vault, the code host, the fake agent, the hold gate). Every `*.chaos.test.ts` but the SEA file runs.
 * - `OT_CHAOS_TARGET=sea`: the single executable of Phase 10, compiled, with `OT_CHAOS_SEA` naming it.
 *   Only `sea.chaos.test.ts` runs: the executable takes only its product configuration, so nothing can
 *   be injected into it, and the other files skip themselves ({@link chaosTarget} is how they know).
 */
export type ChaosTarget =
  { readonly kind: 'source' } | { readonly kind: 'sea'; readonly executable: string };

/** The modes of `OT_CHAOS_TARGET`. */
export const CHAOS_TARGET_MODES: readonly ChaosTarget['kind'][] = ['source', 'sea'];

/**
 * The target of this run. A malformed value throws: a typo must not run the other mode in silence,
 * and `sea` with no executable (or one that is not a file) has nothing to run.
 */
export function chaosTarget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChaosTarget {
  const mode = env.OT_CHAOS_TARGET;
  if (mode === undefined || mode === '' || mode === 'source') return { kind: 'source' };
  if (mode !== 'sea') {
    throw new Error(
      `OT_CHAOS_TARGET=${mode}: use ${CHAOS_TARGET_MODES.join(' or ')} (default source)`,
    );
  }
  const given = env.OT_CHAOS_SEA;
  if (given === undefined || given === '') {
    throw new Error('OT_CHAOS_TARGET=sea needs OT_CHAOS_SEA=<path of the compiled executable>');
  }
  const executable = resolve(given);
  let isFile = false;
  try {
    isFile = statSync(executable).isFile();
  } catch {
    // Not there: the message below names the variable.
  }
  if (!isFile) throw new Error(`OT_CHAOS_SEA=${given}: not a file (build it with tools/release)`);
  return { kind: 'sea', executable };
}

/** Whether the run is over the executable. Never throws: a malformed variable counts as `source` here. */
export function overSea(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.OT_CHAOS_TARGET === 'sea';
}
