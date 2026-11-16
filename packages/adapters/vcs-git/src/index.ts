// SPDX-License-Identifier: MPL-2.0
export { GitVcsConfigSchema, type GitVcsConfig, type GitVcsConfigInput } from './config.js';
export {
  DEFAULT_GIT_IDENTITY,
  DEFAULT_GIT_TIMEOUT_MS,
  isolatedGitConfig,
  isolatedGitEnv,
  type GitIdentity,
} from './git.js';
export { GIT_VCS_ADAPTER, GitVcs, type GitVcsOptions } from './vcs.js';
export {
  WORKTREE_INCLUDE_FILE,
  type WorktreeIncludeResult,
  type WorktreeIncludeSkip,
} from './worktree-include.js';
