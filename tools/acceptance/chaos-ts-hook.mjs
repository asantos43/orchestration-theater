// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions -- a plain script: the hook arguments of Node have no types here */
// Resolve hook of the chaos roteiro (Phase 11, P11): the harness sources of `packages/daemon/src/chaos`
// import each other as `./x.js`, the way the compiler wants; here the `.ts` files are what exists
// (they are not in `dist`), so a relative `.js` that is not a file is taken for the `.ts` beside it.
// Node strips the types itself (Node 24). Nothing else is changed.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line @typescript-eslint/require-await -- the hook may be async; here it only forwards
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith('.') &&
    specifier.endsWith('.js') &&
    context.parentURL !== undefined &&
    context.parentURL.endsWith('.ts')
  ) {
    const asTs = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (
      !existsSync(fileURLToPath(new URL(specifier, context.parentURL))) &&
      existsSync(fileURLToPath(asTs))
    ) {
      return nextResolve(asTs.href, context);
    }
  }
  return nextResolve(specifier, context);
}
