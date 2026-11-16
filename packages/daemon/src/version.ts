// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const PackageSchema = z.object({ version: z.string().min(1) });

/**
 * Version of this package, read from its `package.json` (one level above `src/` and `dist/`, so it
 * works from both). Read once per call; callers keep the value.
 */
export function packageVersion(): string {
  const file = fileURLToPath(new URL('../package.json', import.meta.url));
  return PackageSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).version;
}
