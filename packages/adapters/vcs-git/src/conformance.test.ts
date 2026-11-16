// SPDX-License-Identifier: MPL-2.0
import { describeVcsConformance } from '@otheater/sdk';
import { GitVcs } from './index.js';

describeVcsConformance('GitVcs', () => ({ vcs: new GitVcs({ timeoutMs: 20_000 }) }));
