// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import {
  FakeClock,
  FakeIssueTracker,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import { PLAY_WORKFLOW } from '@otheater/workflows';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from './config.js';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { makeTempDataDir } from './test-helpers.js';
import { WorkflowBindings } from './workflows/bindings.js';
import { DEFAULT_WORKFLOWS_SETTINGS } from './workflows/config.js';
import { WorkflowLibrary } from './workflows/library.js';
import type { PullRequestSummary } from './workflows/triggers/types.js';

/**
 * Phase 11b, P10a: the workflow engine in the composition of the daemon. The triggers start when
 * the daemon starts and stop when it stops, and `workflows.triggers.poll.mode: off` makes the loop
 * of the code host look at nothing. Only fakes: the clock, the issue tracker and the readers of
 * pull requests and collaborators answer from memory, and no step of a workflow runs (no item is
 * waiting on the host, so no binding fires).
 */

const MANUAL = 'backup:\n  when: manual\n';
const POLL_OFF = `${MANUAL}workflows:\n  triggers:\n    poll:\n      mode: off\n`;
/** The default of `workflows.triggers.poll.interval` (5m). */
const INTERVAL_MS = 5 * 60_000;

class CountingPullRequests {
  calls = 0;
  listOpen(): Promise<readonly PullRequestSummary[]> {
    this.calls += 1;
    return Promise.resolve([]);
  }
}

class CountingCollaborators {
  calls = 0;
  isCollaborator(): Promise<boolean> {
    this.calls += 1;
    return Promise.resolve(true);
  }
}

interface Rig {
  readonly daemon: DaemonHandle;
  readonly clock: FakeClock;
  readonly tracker: FakeIssueTracker;
  readonly pullRequests: CountingPullRequests;
  readonly collaborators: CountingCollaborators;
  dispose(): Promise<void>;
}

/** A daemon with a binding of the `play` that waits for a new issue and for a new pull request. */
async function start(config: string): Promise<Rig> {
  const tmp = await makeTempDataDir();
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const library = new WorkflowLibrary({ store, settings: () => DEFAULT_WORKFLOWS_SETTINGS });
  await library.install(PLAY_WORKFLOW, { source: 'builtin' });
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play',
    name: 's1',
    folder: join('work', 's1'),
    baseBranch: 'main',
  });
  const bindings = new WorkflowBindings({
    store,
    library,
    clock,
    settings: () => DEFAULT_WORKFLOWS_SETTINGS,
    logger: createSilentLogger(),
    onBudgetExhausted: () => undefined,
  });
  await bindings.create({
    scenarioId: 's1',
    workflowId: 'play',
    triggers: [{ type: 'code_host.issue_opened' }, { type: 'code_host.pr_opened' }],
  });
  const tracker = new FakeIssueTracker({ clock });
  const pullRequests = new CountingPullRequests();
  const collaborators = new CountingCollaborators();
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    config: parseConfig(config),
    overrides: {
      clock,
      store,
      vault: new InMemorySecretVault(),
      launcher: new FakeProcessLauncher(),
      transport: new FakeSessionTransport(),
      issueTracker: tracker,
      pullRequests,
      collaborators,
    },
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  return {
    daemon,
    clock,
    tracker,
    pullRequests,
    collaborators,
    dispose: async () => {
      await daemon.stop();
      await tmp.dispose();
    },
  };
}

describe('the daemon starts and stops the triggers of the workflows (P10a)', () => {
  it('looks at the host when it starts and at every interval, and stops looking when it stops', async () => {
    const t = await start(MANUAL);
    try {
      await vi.waitFor(() => {
        expect(t.tracker.callCount('listIssues')).toBe(1);
        expect(t.pullRequests.calls).toBe(1);
      });
      await t.clock.advance(INTERVAL_MS);
      await vi.waitFor(() => {
        expect(t.tracker.callCount('listIssues')).toBe(2);
        expect(t.pullRequests.calls).toBe(2);
      });
      expect(t.clock.pendingSleeps).toBeGreaterThan(0);

      await t.daemon.stop();
      const issues = t.tracker.callCount('listIssues');
      const pulls = t.pullRequests.calls;
      await t.clock.advance(INTERVAL_MS * 3);
      expect(t.tracker.callCount('listIssues')).toBe(issues);
      expect(t.pullRequests.calls).toBe(pulls);
      expect(t.clock.pendingSleeps).toBe(0);
    } finally {
      await t.dispose();
    }
  });

  it('poll.mode: off keeps the loop of the code host from calling the tracker, the pull requests and the collaborators', async () => {
    const t = await start(POLL_OFF);
    try {
      // The loop is going (it sleeps on the clock), and it looks at nothing.
      await vi.waitFor(() => {
        expect(t.clock.pendingSleeps).toBeGreaterThan(0);
      });
      await t.clock.advance(INTERVAL_MS * 3);
      await t.clock.advance(INTERVAL_MS);
      expect(t.tracker.callCount('listIssues')).toBe(0);
      expect(t.pullRequests.calls).toBe(0);
      expect(t.collaborators.calls).toBe(0);
    } finally {
      await t.dispose();
    }
  });
});
