// SPDX-License-Identifier: MPL-2.0
import { defineConfig } from 'vitest/config';

// Tests import workspace packages by name. Pointing them at the sources lets `vitest run` work on
// a fresh checkout, without a previous `tsc -b` (the build output is only for `exports`).
const alias = {
  '@otheater/core/testing': `${import.meta.dirname}/packages/core/src/testing/index.ts`,
  '@otheater/core': `${import.meta.dirname}/packages/core/src/index.ts`,
  '@otheater/sdk': `${import.meta.dirname}/packages/sdk/src/index.ts`,
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
  '@otheater/adapter-local-llama-cpp': `${import.meta.dirname}/packages/adapters/local-llama-cpp/src/index.ts`,
  '@otheater/adapter-browser-playwright': `${import.meta.dirname}/packages/adapters/browser-playwright/src/index.ts`,
  '@otheater/adapter-sandbox-srt': `${import.meta.dirname}/packages/adapters/sandbox-srt/src/index.ts`,
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
