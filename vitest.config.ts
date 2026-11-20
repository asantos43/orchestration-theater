// SPDX-License-Identifier: MPL-2.0
import { defineConfig } from 'vitest/config';

// Tests import workspace packages by name. Pointing them at the sources lets `vitest run` work on
// a fresh checkout, without a previous `tsc -b` (the build output is only for `exports`).
const alias = {
  '@otheater/core/testing': `${import.meta.dirname}/packages/core/src/testing/index.ts`,
  '@otheater/core': `${import.meta.dirname}/packages/core/src/index.ts`,
  '@otheater/sdk': `${import.meta.dirname}/packages/sdk/src/index.ts`,
  '@otheater/client/node': `${import.meta.dirname}/packages/client/src/node/index.ts`,
  '@otheater/client': `${import.meta.dirname}/packages/client/src/index.ts`,
  '@otheater/protocol': `${import.meta.dirname}/packages/protocol/src/index.ts`,
  '@otheater/adapter-store-sqlite': `${import.meta.dirname}/packages/adapters/store-sqlite/src/index.ts`,
  '@otheater/adapter-vault-file': `${import.meta.dirname}/packages/adapters/vault-file/src/index.ts`,
  '@otheater/adapter-vault-keyring': `${import.meta.dirname}/packages/adapters/vault-keyring/src/index.ts`,
  '@otheater/adapter-clock-system': `${import.meta.dirname}/packages/adapters/clock-system/src/index.ts`,
  '@otheater/adapter-prompts-files': `${import.meta.dirname}/packages/adapters/prompts-files/src/index.ts`,
  '@otheater/adapter-vcs-git': `${import.meta.dirname}/packages/adapters/vcs-git/src/index.ts`,
  '@otheater/adapter-codehost-github': `${import.meta.dirname}/packages/adapters/codehost-github/src/index.ts`,
  '@otheater/adapter-platform-posix': `${import.meta.dirname}/packages/adapters/platform-posix/src/index.ts`,
  '@otheater/adapter-session-acp': `${import.meta.dirname}/packages/adapters/session-acp/src/index.ts`,
  '@otheater/adapter-client-claude-code': `${import.meta.dirname}/packages/adapters/client-claude-code/src/index.ts`,
  '@otheater/adapter-client-codex': `${import.meta.dirname}/packages/adapters/client-codex/src/index.ts`,
  '@otheater/adapter-client-opencode': `${import.meta.dirname}/packages/adapters/client-opencode/src/index.ts`,
  '@otheater/adapter-local-ollama': `${import.meta.dirname}/packages/adapters/local-ollama/src/index.ts`,
  '@otheater/adapter-usage-ccusage': `${import.meta.dirname}/packages/adapters/usage-ccusage/src/index.ts`,
  '@otheater/adapter-local-llama-cpp': `${import.meta.dirname}/packages/adapters/local-llama-cpp/src/index.ts`,
  '@otheater/adapter-browser-playwright': `${import.meta.dirname}/packages/adapters/browser-playwright/src/index.ts`,
  '@otheater/adapter-sandbox-srt': `${import.meta.dirname}/packages/adapters/sandbox-srt/src/index.ts`,
};

// Per-test and per-hook deadlines. The Windows runner of the CI is several times slower than Linux
// for processes and git (and the files run in parallel), so the vitest defaults (5 s and 10 s)
// fail tests there that are only slow. `OT_TEST_TIMEOUT_MS` sets both, on any platform.
const fromEnv = Number(process.env.OT_TEST_TIMEOUT_MS);
const override = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : undefined;
const windows = process.platform === 'win32';
const testTimeout = override ?? (windows ? 30_000 : 5_000);
const hookTimeout = override ?? (windows ? 60_000 : 10_000);

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'packages',
          include: ['packages/**/src/**/*.test.ts', 'tools/**/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'spikes/**'],
          testTimeout,
          hookTimeout,
        },
      },
    ],
  },
});
