// SPDX-License-Identifier: MPL-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          include: ['packages/**/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'spikes/**'],
        },
      },
    ],
  },
});
