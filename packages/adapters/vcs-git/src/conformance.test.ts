// SPDX-License-Identifier: MPL-2.0
import { describeVcsConformance } from '@otheater/sdk';
import { afterAll } from 'vitest';
import { disposeSharedGitIsolations, GitVcs } from './index.js';

// The runner may kill its workers without an `exit`: remove the isolation folder of the adapter.
afterAll(disposeSharedGitIsolations);

describeVcsConformance('GitVcs', () => ({ vcs: new GitVcs({ timeoutMs: 20_000 }) }));
