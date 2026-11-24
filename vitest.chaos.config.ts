// SPDX-License-Identifier: MPL-2.0
import { defineConfig } from 'vitest/config';
import { alias } from './vitest.config.ts';

// The chaos suite (Phase 11, P1; docs/23): the tests named `*.chaos.test.ts`, which start the daemon
// as a process, kill it and start it again. They are not part of `pnpm test` (see the `exclude` of
// vitest.config.ts) and run by `pnpm test:chaos` and by the workflow chaos.yml. They need
// `pnpm build` first (the child daemon is the compiled one), and run one file at a time: each one
// starts processes of its own and counts the ones that are alive.
//
// What it runs over (Phase 11, P12; docs/23, D6): `OT_CHAOS_TARGET=source` (default) runs every file
// over the daemon of the build output; `OT_CHAOS_TARGET=sea` (with `OT_CHAOS_SEA=<executable>`) runs
// only `sea.chaos.test.ts`, over the compiled single executable of Phase 10. The other files start a
// fixture that injects fakes into the daemon in process, which a compiled executable cannot take.
const overSea = process.env.OT_CHAOS_TARGET === 'sea';

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'chaos',
          include: overSea
            ? ['packages/daemon/src/chaos/sea.chaos.test.ts']
            : ['packages/**/src/**/*.chaos.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'spikes/**'],
          testTimeout: 240_000,
          hookTimeout: 240_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
