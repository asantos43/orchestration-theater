// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const PackageSchema = z.object({ version: z.string().min(1) });

/**
 * The version the build of the single executable wrote (Phase 10, P1; the `define` of esbuild, from
 * `package.json`, or from `versionOverride` in `release.config.json` for a test build). It does not
 * exist in the checkout, where the version is read from the file.
 */
declare const __OT_BUILD_VERSION__: string | undefined;

/**
 * Version of this package. In the executable, the constant of the build (there is no `package.json`
 * on disk to read); otherwise read from the `package.json` one level above `src/` and `dist/`, so it
 * works from both. Read once per call; callers keep the value.
 */
export function packageVersion(): string {
  if (typeof __OT_BUILD_VERSION__ === 'string') return __OT_BUILD_VERSION__;
  const file = fileURLToPath(new URL('../package.json', import.meta.url));
  return PackageSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).version;
}
