// SPDX-License-Identifier: MPL-2.0
import { defineConfig } from 'vitest/config';

// Tests import workspace packages by name. Pointing them at the sources lets `vitest run` work on
// a fresh checkout, without a previous `tsc -b` (the build output is only for `exports`).
const alias = {
  '@otheater/core/testing': `${import.meta.dirname}/packages/core/src/testing/index.ts`,
  '@otheater/core': `${import.meta.dirname}/packages/core/src/index.ts`,
  '@otheater/sdk': `${import.meta.dirname}/packages/sdk/src/index.ts`,
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'packages',
          include: ['packages/**/src/**/*.test.ts', 'tools/**/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'spikes/**'],
        },
      },
    ],
  },
});
