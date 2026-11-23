// SPDX-License-Identifier: MPL-2.0
import { defineConfig } from 'vitest/config';
import { alias } from './vitest.config.ts';

// The chaos suite (Phase 11, P1; docs/23): the tests named `*.chaos.test.ts`, which start the daemon
// as a process, kill it and start it again. They are not part of `pnpm test` (see the `exclude` of
// vitest.config.ts) and run by `pnpm test:chaos` and by the workflow chaos.yml. They need
// `pnpm build` first (the child daemon is the compiled one), and run one file at a time: each one
// starts processes of its own and counts the ones that are alive.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'chaos',
          include: ['packages/**/src/**/*.chaos.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'spikes/**'],
          testTimeout: 240_000,
          hookTimeout: 240_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
