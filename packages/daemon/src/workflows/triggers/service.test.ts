// SPDX-License-Identifier: MPL-2.0
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeTempFolders } from '../packages/packages.test-support.js';
import { DEFAULT_WORKFLOW_TRIGGERS_SETTINGS } from './config.js';
import { workflowTriggersFile } from './seen.js';
import { type TriggerRig, triggerRig } from './triggers.test-support.js';

afterEach(removeTempFolders);

const ISSUE_OPENED = { type: 'code_host.issue_opened' } as const;

/** A binding with the trigger, then a second of the clock so what comes next is newer. */
async function bound(
  r: TriggerRig,
  triggers: Parameters<TriggerRig['bind']>[0],
  extra?: Parameters<TriggerRig['bind']>[1],
): Promise<Awaited<ReturnType<TriggerRig['bind']>>> {
  const binding = await r.bind(triggers, extra);
  await r.clock.advance(1_000);
  return binding;
}

describe('the triggers of the code host (acceptance, fake clock)', () => {
  it('a new issue fires the binding once, across passes and across a restart', async () => {
    const r = await triggerRig();
    const binding = await bound(r, [ISSUE_OPENED], { params: { mode: 'quick' } });
    r.tracker.seedIssue({ title: 'bug' });
    await r.pass();
    expect(r.runtime.started).toHaveLength(1);
    expect(r.runtime.started[0]).toMatchObject({
      scenarioId: 's1',
      inputs: { mode: 'quick', issue: 1 },
    });
    expect(r.runtime.started[0]?.runId.startsWith(`trg-${binding.id}-`)).toBe(true);
    const fired = await r.eventsOf('workflow.trigger.fired');
    expect(fired).toEqual([
      expect.objectContaining({
        bindingId: binding.id,
        triggerType: 'code_host.issue_opened',
        key: 'issue_opened:1',
        number: 1,
        replaced: [],
      }),
    ]);

    await r.pass();
    await r.restart().pass();
    expect(r.runtime.started).toHaveLength(1);
    expect(await r.eventsOf('workflow.trigger.fired')).toHaveLength(1);
  });

  it('a run that exists answers for the item even if the mark in the ledger was lost', async () => {
    const r = await triggerRig();
    await bound(r, [ISSUE_OPENED]);
    r.tracker.seedIssue({ title: 'bug' });
    await r.pass();
    const runId = r.runtime.started[0]?.runId ?? '';
    await r.runtime.finish(runId);
    await rm(workflowTriggersFile(r.dataDir));
    await r.restart().pass();
    expect(r.runtime.started).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });

  it('does not answer an issue that was opened before the binding', async () => {
    const r = await triggerRig();
    r.tracker.seedIssue({ title: 'old' });
    await r.clock.advance(1_000);
    await bound(r, [ISSUE_OPENED]);
    await r.pass();
    expect(r.runtime.started).toEqual([]);
  });

  it('skips an author that is not in the list, for good, and says so once', async () => {
    const r = await triggerRig();
    const binding = await bound(r, [ISSUE_OPENED]);
    r.tracker.seedIssue({ title: 'spam', author: 'stranger' });
    r.tracker.seedIssue({ title: 'mine', author: 'Fake-User' });
    await r.pass();
    await r.pass();
    expect(r.runtime.started.map((run) => run.inputs?.issue)).toEqual([2]);
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([
      expect.objectContaining({
        bindingId: binding.id,
        key: 'issue_opened:1',
        reason: 'author',
        retry: false,
      }),
    ]);
  });

  it('authors: any lets everyone in; collaborators asks the host and trusts the list too', async () => {
    const r = await triggerRig({ authors: 'any' });
    await bound(r, [ISSUE_OPENED], { concurrency: 5 });
    r.tracker.seedIssue({ title: 'a', author: 'stranger' });
    await r.pass();
    expect(r.runtime.started).toHaveLength(1);

    r.settings = { ...r.settings, authors: 'collaborators' };
    r.collaborators.logins.add('partner');
    r.tracker.seedIssue({ title: 'b', author: 'partner' });
    r.tracker.seedIssue({ title: 'c', author: 'outsider' });
    r.tracker.seedIssue({ title: 'd', author: 'fake-user' });
    await r.pass();
    expect(r.runtime.started.map((run) => run.inputs?.issue)).toEqual([1, 2, 4]);
    expect(r.collaborators.calls).toBe(2);
  });

  it('filters by the labels of the trigger and fires issue_labeled for the label asked', async () => {
    const r = await triggerRig();
    await bound(r, [{ type: 'code_host.issue_opened', filter: { labels: ['ready'] } }], {
      concurrency: 5,
    });
    r.tracker.seedIssue({ title: 'a', labels: ['ready', 'bug'] });
    r.tracker.seedIssue({ title: 'b', labels: ['bug'] });
    await r.pass();
    expect(r.runtime.started.map((run) => run.inputs?.issue)).toEqual([1]);

    const labeled = await triggerRig();
    await bound(labeled, [{ type: 'code_host.issue_labeled', filter: { label: 'ship' } }]);
    labeled.tracker.seedIssue({ title: 'a', labels: ['bug'] });
    labeled.tracker.seedIssue({ title: 'b', labels: ['ship'] });
    await labeled.pass();
    expect(labeled.runtime.started.map((run) => run.inputs?.issue)).toEqual([2]);
    expect(await labeled.eventsOf('workflow.trigger.fired')).toEqual([
      expect.objectContaining({ key: 'issue_labeled:2:ship' }),
    ]);
  });

  it('pr_opened fires once with the number of the pull request', async () => {
    const r = await triggerRig();
    await bound(r, [{ type: 'code_host.pr_opened' }], { concurrency: 5 });
    const now = r.clock.now();
    r.pullRequests.pulls.push({
      number: 7,
      author: 'fake-user',
      labels: [],
      headSha: 'abc',
      createdAt: now,
      updatedAt: now,
    });
    await r.pass();
    await r.pass();
    expect(r.runtime.started).toHaveLength(1);
    expect(r.runtime.started[0]?.inputs).toEqual({ pr: 7 });
  });

  it('ci_failed fires for a head that failed, once per head, and not for one that passed', async () => {
    const r = await triggerRig();
    await bound(r, [{ type: 'code_host.ci_failed' }], { concurrency: 5 });
    const now = r.clock.now();
    r.pullRequests.pulls.push({
      number: 7,
      author: 'fake-user',
      labels: [],
      headSha: 'abc',
      createdAt: now,
      updatedAt: now,
    });
    r.ci.byNumber.set(7, { headSha: 'abc', conclusion: 'success' });
    await r.pass();
    expect(r.runtime.started).toEqual([]);

    r.ci.byNumber.set(7, { headSha: 'abc', conclusion: 'failure' });
    await r.pass();
    expect(r.runtime.started).toHaveLength(1);
    const calls = r.ci.calls;
    await r.pass();
    expect(r.runtime.started).toHaveLength(1);
    expect(r.ci.calls).toBe(calls);

    // A new push that fails again is a new failure.
    const first = r.pullRequests.pulls[0];
    if (first !== undefined) r.pullRequests.pulls[0] = { ...first, headSha: 'def' };
    r.ci.byNumber.set(7, { headSha: 'def', conclusion: 'failure' });
    await r.pass();
    expect(r.runtime.started).toHaveLength(2);
    expect(await r.eventsOf('workflow.trigger.fired')).toEqual([
      expect.objectContaining({ key: 'ci_failed:7:abc' }),
      expect.objectContaining({ key: 'ci_failed:7:def' }),
    ]);
  });
});

describe('a binding that is busy follows on_busy', () => {
  async function twoIssues(onBusy: 'queue' | 'skip' | 'replace'): Promise<TriggerRig> {
    const r = await triggerRig();
    await bound(r, [ISSUE_OPENED], { concurrency: 1, onBusy });
    r.tracker.seedIssue({ title: 'one' });
    r.tracker.seedIssue({ title: 'two' });
    await r.pass();
    return r;
  }

  it('queue: the second issue waits and goes when the run ends', async () => {
    const r = await twoIssues('queue');
    expect(r.runtime.started.map((run) => run.inputs?.issue)).toEqual([1]);
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([
      expect.objectContaining({ key: 'issue_opened:2', reason: 'busy', retry: true }),
    ]);
    await r.pass();
    expect(await r.eventsOf('workflow.trigger.skipped')).toHaveLength(1);

    await r.runtime.finish(r.runtime.started[0]?.runId ?? '');
    await r.pass();
    expect(r.runtime.started.map((run) => run.inputs?.issue)).toEqual([1, 2]);
  });

  it('skip: the second issue is dropped for good', async () => {
    const r = await twoIssues('skip');
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([
      expect.objectContaining({ key: 'issue_opened:2', reason: 'busy', retry: false }),
    ]);
    await r.runtime.finish(r.runtime.started[0]?.runId ?? '');
    await r.pass();
    expect(r.runtime.started.map((run) => run.inputs?.issue)).toEqual([1]);
  });

  it('replace: the run in flight is cancelled and the second issue takes its place', async () => {
    const r = await twoIssues('replace');
    expect(r.runtime.started.map((run) => run.inputs?.issue)).toEqual([1, 2]);
    expect(r.runtime.cancelled).toEqual([
      { runId: r.runtime.started[0]?.runId, reason: 'replaced' },
    ]);
    expect(await r.eventsOf('workflow.trigger.fired')).toEqual([
      expect.objectContaining({ key: 'issue_opened:1', replaced: [] }),
      expect.objectContaining({
        key: 'issue_opened:2',
        replaced: [r.runtime.started[0]?.runId],
      }),
    ]);
  });
});

describe('a binding that cannot take a run now', () => {
  it('a paused binding is not looked at, and fires what it found after it is resumed', async () => {
    const r = await triggerRig();
    const binding = await bound(r, [ISSUE_OPENED]);
    await r.bindings.pause(binding.id);
    r.tracker.seedIssue({ title: 'one' });
    await r.pass();
    expect(r.tracker.callCount('listIssues')).toBe(0);
    expect(r.runtime.started).toEqual([]);

    await r.bindings.resume(binding.id);
    await r.pass();
    expect(r.runtime.started).toHaveLength(1);
  });

  it('an exhausted budget is not looked at either', async () => {
    const r = await triggerRig();
    const binding = await bound(r, [ISSUE_OPENED], { budgetUsd: 1 });
    await r.bindings.recordSpend(binding.id, 2);
    r.tracker.seedIssue({ title: 'one' });
    await r.pass();
    expect(r.tracker.callCount('listIssues')).toBe(0);
    expect(r.runtime.started).toEqual([]);
  });

  it('a trigger the daemon does not know is said once and ignored', async () => {
    const r = await triggerRig();
    const binding = await bound(r, [{ type: 'code_host.nope' }]);
    await r.pass();
    await r.pass();
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([
      expect.objectContaining({
        bindingId: binding.id,
        triggerType: 'code_host.nope',
        reason: 'invalid',
        retry: false,
      }),
    ]);
  });
});

describe('a poll that fails follows poll.on_error', () => {
  it('backoff: the source waits, the failure is an event, and the next look goes on', async () => {
    const r = await triggerRig();
    const binding = await bound(r, [ISSUE_OPENED]);
    r.tracker.seedIssue({ title: 'one' });
    r.tracker.failNext('listIssues', new Error('the host said no'));
    await r.pass();
    expect(await r.eventsOf('workflow.poll.failed')).toEqual([
      {
        bindingId: binding.id,
        scenarioId: 's1',
        workflowId: 'play',
        triggerType: 'code_host.issue_opened',
        error: 'the host said no',
        failures: 1,
        action: 'backoff',
        retryInMs: 600_000,
      },
    ]);

    await r.pass();
    expect(r.tracker.callCount('listIssues')).toBe(1);
    expect(r.runtime.started).toEqual([]);

    await r.clock.advance(600_000);
    await r.pass();
    expect(r.tracker.callCount('listIssues')).toBe(2);
    expect(r.runtime.started).toHaveLength(1);
  });

  it('backoff doubles at each failure up to backoff_max', async () => {
    const r = await triggerRig();
    await bound(r, [ISSUE_OPENED]);
    for (let n = 0; n < 5; n += 1) {
      r.tracker.failNext('listIssues', new Error('down'));
      await r.pass();
      await r.clock.advance(3_600_000);
    }
    const waits = (await r.eventsOf('workflow.poll.failed')).map((event) => event.retryInMs);
    expect(waits).toEqual([600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
  });

  it('pause_binding: the binding is paused and the Producer resumes it', async () => {
    const r = await triggerRig({
      poll: { ...DEFAULT_WORKFLOW_TRIGGERS_SETTINGS.poll, on_error: 'pause_binding' },
    });
    const binding = await bound(r, [ISSUE_OPENED]);
    r.tracker.seedIssue({ title: 'one' });
    r.tracker.failNext('listIssues', new Error('bad token'));
    await r.pass();
    expect((await r.bindings.get(binding.id))?.state).toBe('paused');
    expect(await r.eventsOf('workflow.poll.failed')).toEqual([
      expect.objectContaining({ action: 'pause_binding', retryInMs: null, failures: 1 }),
    ]);

    await r.pass();
    expect(r.tracker.callCount('listIssues')).toBe(1);

    await r.bindings.resume(binding.id);
    await r.clock.advance(3_600_000);
    await r.pass();
    expect(r.runtime.started).toHaveLength(1);
  });

  it('an issue tracker the daemon does not have is a failed look, not a crash', async () => {
    const r = await triggerRig();
    await bound(r, [ISSUE_OPENED]);
    r.without.add('tracker');
    r.restart();
    await r.pass();
    expect(await r.eventsOf('workflow.poll.failed')).toEqual([
      expect.objectContaining({ error: expect.stringContaining('no issue tracker') as string }),
    ]);
  });

  it('poll.mode: off looks at nothing', async () => {
    const r = await triggerRig();
    await bound(r, [ISSUE_OPENED]);
    r.tracker.seedIssue({ title: 'one' });
    r.settings = { ...r.settings, poll: { ...r.settings.poll, mode: 'off' } };
    await r.pass();
    expect(r.tracker.callCount('listIssues')).toBe(0);
    expect(r.runtime.started).toEqual([]);
  });
});

describe('the internal triggers (events of the log)', () => {
  const PING = [{ type: 'event', filter: { name: 'demo.ping' } }] as const;

  it('fires on the event by name, once, for the scenario of the binding', async () => {
    const r = await triggerRig();
    await r.appendEvent('demo.ping');
    await bound(r, PING, { concurrency: 5 });
    await r.pass();
    // The history before the first look is not answered.
    expect(r.runtime.started).toEqual([]);

    await r.appendEvent('demo.ping', 's2');
    await r.appendEvent('demo.other');
    const ping = await r.appendEvent('demo.ping');
    await r.pass();
    await r.restart().pass();
    expect(r.runtime.started).toHaveLength(1);
    expect(await r.eventsOf('workflow.trigger.fired')).toEqual([
      expect.objectContaining({
        triggerType: 'event',
        key: `event:${String(ping.id)}`,
        number: null,
      }),
    ]);
  });

  it('never fires on the events of the triggers themselves', async () => {
    const r = await triggerRig();
    await bound(r, [{ type: 'event', filter: { name: 'workflow.trigger.fired' } }], {
      concurrency: 5,
    });
    await r.pass();
    await r.appendEvent('workflow.trigger.fired');
    await r.pass();
    expect(r.runtime.started).toEqual([]);
  });

  it('a busy binding that queues keeps the event and starts it when the run ends', async () => {
    const r = await triggerRig();
    await bound(r, PING, { concurrency: 1, onBusy: 'queue' });
    await r.pass();
    const first = await r.appendEvent('demo.ping');
    const second = await r.appendEvent('demo.ping');
    await r.pass();
    expect(r.runtime.started).toHaveLength(1);
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([
      expect.objectContaining({ key: `event:${String(second.id)}`, reason: 'busy', retry: true }),
    ]);
    await r.pass();
    expect(r.runtime.started).toHaveLength(1);

    await r.runtime.finish(r.runtime.started[0]?.runId ?? '');
    await r.restart().pass();
    expect(r.runtime.started).toHaveLength(2);
    const keys = (await r.eventsOf('workflow.trigger.fired')).map((event) => event.key);
    expect(keys).toEqual([`event:${String(first.id)}`, `event:${String(second.id)}`]);
  });
});

describe('the events of the plugins as triggers (D6)', () => {
  const FINISHED = [{ type: 'event', filter: { name: 'plugin.acme.finished' } }] as const;

  async function armed(
    declared: readonly string[] | undefined,
    overrides: Parameters<typeof triggerRig>[0] = {},
  ): Promise<TriggerRig> {
    const r = await triggerRig(overrides);
    if (declared !== undefined) r.plugins.activate('s1', 'acme', declared);
    await bound(r, FINISHED, { concurrency: 5 });
    await r.pass();
    return r;
  }

  it('fires when the plugin is active, declares the event and the binding asks for it', async () => {
    const r = await armed(['finished']);
    await r.appendEvent('plugin.acme.finished');
    await r.pass();
    expect(r.runtime.started).toHaveLength(1);
  });

  it('does not fire an event the manifest does not declare as a trigger', async () => {
    const r = await armed(['something-else']);
    await r.appendEvent('plugin.acme.finished');
    await r.appendEvent('plugin.acme.finished');
    await r.pass();
    expect(r.runtime.started).toEqual([]);
    // Once per look, not once per event.
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([
      expect.objectContaining({ reason: 'undeclared', retry: false, triggerType: 'event' }),
    ]);
  });

  it('does not fire when the manifest has no triggers at all', async () => {
    const r = await armed([]);
    await r.appendEvent('plugin.acme.finished');
    await r.pass();
    expect(r.runtime.started).toEqual([]);
  });

  it('does not fire for a plugin that is not active in the scenario', async () => {
    const r = await armed(undefined);
    r.plugins.activate('s2', 'acme', ['finished']);
    await r.appendEvent('plugin.acme.finished');
    await r.pass();
    expect(r.runtime.started).toEqual([]);
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([
      expect.objectContaining({ reason: 'plugin_inactive' }),
    ]);
  });

  it('plugin_events: off never fires on a plugin event', async () => {
    const r = await armed(['finished'], { plugin_events: 'off' });
    await r.appendEvent('plugin.acme.finished');
    await r.pass();
    expect(r.runtime.started).toEqual([]);
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([
      expect.objectContaining({ reason: 'plugin_events_off' }),
    ]);
  });

  it('does not fire when the binding does not ask for the event by its name', async () => {
    const r = await triggerRig();
    r.plugins.activate('s1', 'acme', ['finished']);
    await bound(r, [{ type: 'event', filter: { name: 'plugin.acme.other' } }]);
    await r.pass();
    await r.appendEvent('plugin.acme.finished');
    await r.pass();
    expect(r.runtime.started).toEqual([]);
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([]);
  });

  it('ignores the event of a plugin sent for another scenario', async () => {
    const r = await armed(['finished']);
    await r.appendEvent('plugin.acme.finished', 's2');
    await r.pass();
    expect(r.runtime.started).toEqual([]);
  });
});

describe('the loop on the clock', () => {
  it('looks now, then once per interval, and stops with no timer left', async () => {
    const r = await triggerRig({ event_poll: null });
    await bound(r, [ISSUE_OPENED], { concurrency: 5 });
    r.tracker.seedIssue({ title: 'one' });
    r.triggers.start();
    await vi.waitFor(() => {
      expect(r.runtime.started).toHaveLength(1);
    });

    r.tracker.seedIssue({ title: 'two' });
    await r.clock.advance(299_999);
    expect(r.runtime.started).toHaveLength(1);
    await r.clock.advance(1);
    await vi.waitFor(() => {
      expect(r.runtime.started).toHaveLength(2);
    });

    await r.triggers.stop();
    expect(r.clock.pendingSleeps).toBe(0);
  });
});
