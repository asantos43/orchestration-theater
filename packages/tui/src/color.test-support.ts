// SPDX-License-Identifier: MPL-2.0
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** The levels of colour of chalk: none, 16, 256 and truecolor. */
export type ChalkLevel = 0 | 1 | 2 | 3;

interface ChalkLike {
  level: ChalkLevel;
}

/**
 * The chalk Ink paints with (the tests under `vitest` run with no colour, as a pipe does). It is
 * found from Ink's own folder so that it is the same instance and not another copy.
 */
async function inkChalk(): Promise<ChalkLike> {
  const fromInk = createRequire(createRequire(import.meta.url).resolve('ink'));
  const module = (await import(pathToFileURL(fromInk.resolve('chalk')).href)) as {
    default: ChalkLike;
  };
  return module.default;
}

/**
 * Sets the colour level of Ink for a test and returns the function that gives the previous one
 * back (call it in `afterEach`/`afterAll`).
 */
export async function useChalkLevel(level: ChalkLevel): Promise<() => void> {
  const chalk = await inkChalk();
  const before = chalk.level;
  chalk.level = level;
  return () => {
    chalk.level = before;
  };
}
