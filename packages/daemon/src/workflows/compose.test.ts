// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { FakeClock, FakeCodeHost, FakeIssueTracker, InMemoryStore } from '@otheater/core/testing';
import { PLAY_WORKFLOW } from '@otheater/workflows';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, type DaemonConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import type { PluginAggregator } from '../plugins/aggregate.js';
import { composeWorkflows, installBuiltinPlay, type ComposedWorkflows } from './compose.js';
import { removeTempFolders, tempFolder } from './packages/packages.test-support.js';
import { FakeAsk } from './runtime.test-support.js';
import { FakePlugins } from './triggers/triggers.test-support.js';

/**
 * Phase 11b, P10b: what `composeWorkflows` adds over the parts. The rule `require_approval` is the
 * same for the library and the runtime and is read live; the built-in `play` is installed once; the
 * chat is told when a budget runs out; a migration that cannot be asked is told as a notice; and
 * activating a version under `migrate_at_safe_point` asks the migration of the open runs (N295).
 */

afterEach(removeTempFolders);

const stoppers: ComposedWorkflows[] = [];
afterEach(async () => {
  await Promise.all(
    stoppers.splice(0).map(async (composed) => {
      await composed.triggers.stop();
      await composed.runtime.stop();
    }),
  );
});

const SCENARIO = 's1';

/** The `workflows` block of a configuration file; an empty body is the defaults. */
function workflowsYaml(body: string): string {
  return body === '' ? 'workflows: {}\n' : `workflows:\n${body}`;
}

interface Rig {
  readonly store: InMemoryStore;
  readonly clock: FakeClock;
  readonly asks: FakeAsk;
  readonly composed: ComposedWorkflows;
  readonly budgetWarnings: unknown[];
  /** Swaps the configuration the engine reads (as a reload does). */
  readonly reload: (yaml: string) => void;
}

async function makeRig(yaml = ''): Promise<Rig> {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const asks = new FakeAsk();
  let config: DaemonConfig = parseConfig(workflowsYaml(yaml));
  const budgetWarnings: unknown[] = [];
  const composed = composeWorkflows({
    config: () => config.workflows,
    store,
    clock,
    logger: createSilentLogger(),
    dataDir: await tempFolder('otcompose-'),
    aggregator: {} as PluginAggregator,
    plugins: new FakePlugins(),
    ask: asks.ask,
    codeHost: new FakeCodeHost({ clock }),
    issueTracker: new FakeIssueTracker({ clock }),
    onBudgetExhausted: (warning) => budgetWarnings.push(warning),
  });
  stoppers.push(composed);
  await store.scenarios.create({
    id: SCENARIO,
    kind: 'project',
    flowId: 'play',
    name: SCENARIO,
    folder: 'work/s1',
    baseBranch: 'main',
  });
  return {
    store,
    clock,
    asks,
    composed,
    budgetWarnings,
    reload: (next) => {
      config = parseConfig(workflowsYaml(next));
    },
  };
}

/** A workflow that comments with no approval before it: only a loose `require_approval` accepts it. */
const BARE_COMMENT = {
  id: 'bare-comment',
  version: '1.0.0',
  engine: '>=1 <2',
  inputs: { issue: { type: 'number' } },
  nodes: { post: { step: 'comment', params: { target: 'issue', body: 'Thanks' } } },
  edges: ['post -> done'],
};

/** A workflow that labels with no approval before it (`label` is a public write too). */
const BARE_LABEL = {
  id: 'bare-label',
  version: '1.0.0',
  engine: '>=1 <2',
  inputs: { issue: { type: 'number' } },
  nodes: { tag: { step: 'label', params: { target: 'issue', add: ['triaged'] } } },
  edges: ['tag -> done'],
};

async function installRefusal(rig: Rig, document: unknown): Promise<string | undefined> {
  try {
    await rig.composed.library.install(document, { source: 'user' });
    return undefined;
  } catch (error) {
    if (error instanceof InvalidInput) return error.message;
    throw error;
  }
}

async function startRefused(rig: Rig, document: { id: string }): Promise<boolean> {
  const started = await rig.composed.runtime.start({
    runId: `run-${document.id}-${String(Math.random()).slice(2, 8)}`,
    scenarioId: SCENARIO,
    definition: document,
    inputs: { issue: 1 },
  });
  return !started.ok;
}

describe('workflows.security.require_approval is one rule for the library and the runtime', () => {
  it('the strictest (the default, all public writes) refuses a bare comment in both', async () => {
    const rig = await makeRig();
    expect(rig.composed.validateOptions().requireApproval).toEqual(['push', 'comment', 'label']);
    expect(await installRefusal(rig, BARE_COMMENT)).toMatch(/not valid/);
    expect(await startRefused(rig, BARE_COMMENT)).toBe(true);
  });

  it('none (the loosest) accepts it in both', async () => {
    const rig = await makeRig('  security:\n    require_approval: none\n');
    expect(rig.composed.validateOptions().requireApproval).toEqual([]);
    expect(await installRefusal(rig, BARE_COMMENT)).toBeUndefined();
    const started = await rig.composed.runtime.start({
      runId: 'run-loose',
      scenarioId: SCENARIO,
      definition: BARE_COMMENT,
      inputs: { issue: 1 },
    });
    expect(started.ok).toBe(true);
  });

  it('a shorter list asks only for what it names, in both', async () => {
    const rig = await makeRig('  security:\n    require_approval: [push]\n');
    expect(await installRefusal(rig, BARE_COMMENT)).toBeUndefined();
    expect(await installRefusal(rig, BARE_LABEL)).toBeUndefined();
    expect(await startRefused(rig, BARE_COMMENT)).toBe(false);
  });

  it('a list that names the write refuses it in both', async () => {
    const rig = await makeRig('  security:\n    require_approval: [comment]\n');
    expect(await installRefusal(rig, BARE_COMMENT)).toMatch(/not valid/);
    expect(await startRefused(rig, BARE_COMMENT)).toBe(true);
    // `label` is not in the list, so a bare label is accepted.
    expect(await installRefusal(rig, BARE_LABEL)).toBeUndefined();
  });

  it('is read live: a reload changes the rule with no new composition', async () => {
    const rig = await makeRig();
    expect(await installRefusal(rig, BARE_COMMENT)).toMatch(/not valid/);
    expect(await startRefused(rig, BARE_COMMENT)).toBe(true);
    rig.reload('  security:\n    require_approval: none\n');
    expect(await installRefusal(rig, BARE_COMMENT)).toBeUndefined();
    expect(await startRefused(rig, BARE_COMMENT)).toBe(false);
    rig.reload('');
    expect(await startRefused(rig, BARE_COMMENT)).toBe(true);
  });
});

describe('installBuiltinPlay', () => {
  it('installs the play once, as builtin, and active when there was none', async () => {
    const rig = await makeRig();
    const { library } = rig.composed;
    expect(await installBuiltinPlay(library)).toBe(true);
    const record = await library.active(PLAY_WORKFLOW.id);
    expect(record).toMatchObject({
      workflowId: PLAY_WORKFLOW.id,
      version: PLAY_WORKFLOW.version,
      source: 'builtin',
    });
    expect(await installBuiltinPlay(library)).toBe(false);
    expect(await library.list({ workflowId: PLAY_WORKFLOW.id })).toHaveLength(1);
  });

  it('leaves alone what the Producer chose: a version already saved is not touched', async () => {
    const rig = await makeRig();
    const { library } = rig.composed;
    await installBuiltinPlay(library);
    await library.deactivate(PLAY_WORKFLOW.id, PLAY_WORKFLOW.version);
    expect(await library.active(PLAY_WORKFLOW.id)).toBeUndefined();
    expect(await installBuiltinPlay(library)).toBe(false);
    // Still deactivated: a restart does not turn it back on.
    expect(await library.active(PLAY_WORKFLOW.id)).toBeUndefined();
  });
});

describe('the budget of a binding', () => {
  it('tells the chat, writes the record and calls the callback', async () => {
    const rig = await makeRig();
    const { library, bindings } = rig.composed;
    await installBuiltinPlay(library);
    const binding = await bindings.create({
      scenarioId: SCENARIO,
      workflowId: PLAY_WORKFLOW.id,
      budgetUsd: 5,
    });
    await bindings.recordSpend(binding.id, 5);
    await vi.waitFor(() => {
      expect(rig.budgetWarnings).toHaveLength(1);
    });
    const all = await rig.store.events.readFrom(0, 10_000);
    const record = all.filter((event) => event.type === 'workflow.budget_exhausted');
    expect(record).toHaveLength(1);
    const chat = all.filter(
      (event) =>
        event.type === 'scenario.system_message' &&
        (event.payload as { kind?: string }).kind === 'workflow_budget',
    );
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({
      scenarioId: SCENARIO,
      payload: {
        scenarioId: SCENARIO,
        kind: 'workflow_budget',
        bindingId: binding.id,
        workflowId: PLAY_WORKFLOW.id,
        action: 'pause',
        budgetUsd: 5,
        spentUsd: 5,
        period: 'day',
      },
    });
  });

  it('with on_exhausted: stop the notice says stop', async () => {
    const rig = await makeRig('  budget:\n    on_exhausted: stop\n');
    const { library, bindings } = rig.composed;
    await installBuiltinPlay(library);
    const binding = await bindings.create({
      scenarioId: SCENARIO,
      workflowId: PLAY_WORKFLOW.id,
      budgetUsd: 2,
    });
    await bindings.recordSpend(binding.id, 3);
    await vi.waitFor(() => {
      expect(rig.budgetWarnings).toHaveLength(1);
    });
    const all = await rig.store.events.readFrom(0, 10_000);
    const chat = all.find((event) => event.type === 'scenario.system_message');
    expect(chat?.payload).toMatchObject({ kind: 'workflow_budget', action: 'stop' });
  });
});

/** `ticket` 1.0.0 and 2.0.0: an announce, an approval, and the end. 2.0.0 says where the nodes go. */
function ticket(version: string, migrateFrom?: Record<string, Record<string, string>>) {
  return {
    id: 'ticket',
    version,
    engine: '>=1 <2',
    ...(migrateFrom === undefined ? {} : { migrate_from: migrateFrom }),
    nodes: {
      announce: { step: 'notify', params: { message: 'ticket opened' } },
      review: { step: 'approval', params: { prompt: 'Continue?' } },
    },
    edges: ['announce -> review', 'review -> done when output.approved', 'review -> cancelled'],
  };
}

async function openRun(rig: Rig): Promise<void> {
  await rig.composed.library.install(ticket('1.0.0'), { source: 'user' });
  const record = await rig.composed.library.active('ticket');
  const started = await rig.composed.runtime.start({
    runId: 'run-1',
    scenarioId: SCENARIO,
    definition: record?.definition,
  });
  expect(started.ok).toBe(true);
  await vi.waitFor(() => {
    expect(rig.asks.opened.length).toBeGreaterThan(0);
  });
}

async function migrationOf(rig: Rig): Promise<unknown> {
  const play = await rig.store.plays.get('run-1');
  return (play?.snapshot as { runtime: { migration: unknown } }).runtime.migration;
}

describe('activating a version with a run in progress (N295)', () => {
  it('pin (the default): the run stays where it is', async () => {
    const rig = await makeRig();
    await openRun(rig);
    await rig.composed.library.install(
      ticket('2.0.0', { '1.0.0': { announce: 'announce', review: 'review' } }),
      {
        source: 'user',
        activate: true,
      },
    );
    expect((await rig.composed.library.active('ticket'))?.version).toBe('2.0.0');
    expect(await migrationOf(rig)).toBeNull();
  });

  it('migrate_at_safe_point: activating asks the migration of the open run', async () => {
    const rig = await makeRig('  running_on_change: migrate_at_safe_point\n');
    await openRun(rig);
    await rig.composed.library.install(
      ticket('2.0.0', { '1.0.0': { announce: 'announce', review: 'review' } }),
      {
        source: 'user',
        activate: true,
      },
    );
    expect(await migrationOf(rig)).toEqual({ toVersion: '2.0.0', trigger: 'activation' });
  });

  it('a reload of running_on_change is read live', async () => {
    const rig = await makeRig();
    await openRun(rig);
    rig.reload('  running_on_change: migrate_at_safe_point\n');
    await rig.composed.library.install(
      ticket('2.0.0', { '1.0.0': { announce: 'announce', review: 'review' } }),
      {
        source: 'user',
        activate: true,
      },
    );
    expect(await migrationOf(rig)).toEqual({ toVersion: '2.0.0', trigger: 'activation' });
  });
});

describe('a migration that cannot be asked', () => {
  it('keeps the version active and tells it as a daemon.notice', async () => {
    const rig = await makeRig('  running_on_change: migrate_at_safe_point\n');
    await rig.composed.library.install(ticket('1.0.0'), { source: 'user' });
    vi.spyOn(rig.composed.runtime, 'onActivated').mockRejectedValue(new Error('disk full'));
    const record = await rig.composed.library.install(ticket('2.0.0'), {
      source: 'user',
      activate: true,
    });
    expect(record.version).toBe('2.0.0');
    expect((await rig.composed.library.active('ticket'))?.version).toBe('2.0.0');
    const all = await rig.store.events.readFrom(0, 10_000);
    const notices = all.filter((event) => event.type === 'daemon.notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({ kind: 'workflow_migration_failed' });
    expect(JSON.stringify(notices[0]?.payload)).toContain('ticket@2.0.0');
  });
});
