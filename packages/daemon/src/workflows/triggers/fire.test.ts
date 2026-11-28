// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { removeTempFolders } from '../packages/packages.test-support.js';
import { TriggerFirer, type TriggerItem } from './fire.js';
import { SeenLedger, workflowTriggersFile } from './seen.js';
import { type TriggerRig, triggerRig } from './triggers.test-support.js';

afterEach(removeTempFolders);

interface Rig {
  readonly r: TriggerRig;
  readonly firer: TriggerFirer;
  readonly ledger: SeenLedger;
  readonly item: (key: string, n?: number) => Promise<TriggerItem>;
}

/** A firer over the rig, with a binding of `s1` (concurrency 1, queue) and its own ledger. */
async function firing(extra?: Parameters<TriggerRig['bind']>[1]): Promise<Rig> {
  const r = await triggerRig();
  const binding = await r.bind([{ type: 'code_host.issue_opened' }], extra);
  await r.clock.advance(1_000);
  const ledger = new SeenLedger(workflowTriggersFile(r.dataDir));
  const firer = new TriggerFirer({
    clock: r.clock,
    events: r.store.events,
    logger: { error: (_fields, message) => r.errors.push(message) },
    plays: r.store.plays,
    bindings: r.bindings,
    library: r.library,
    runtime: r.runtime,
    ledger,
  });
  return {
    r,
    firer,
    ledger,
    item: async (key, n = 1) => ({
      binding: (await r.bindings.get(binding.id)) ?? binding,
      triggerType: 'code_host.issue_opened',
      key,
      number: n,
      inputName: 'issue',
    }),
  };
}

describe('TriggerFirer', () => {
  it('starts the run with the number as the input, marks the item and writes the event', async () => {
    const { r, firer, ledger, item } = await firing({ params: { mode: 'quick' } });
    const outcome = await firer.fire(await item('issue_opened:5', 5));
    expect(outcome.status).toBe('fired');
    expect(r.runtime.started[0]?.inputs).toEqual({ mode: 'quick', issue: 5 });
    const binding = (await item('x')).binding;
    expect(await ledger.has(binding.id, 'issue_opened:5')).toBe(true);
    expect(await r.eventsOf('workflow.trigger.fired')).toHaveLength(1);
  });

  it('a paused binding defers the item and says so once, with retry', async () => {
    const { r, firer, ledger, item } = await firing();
    const first = await item('issue_opened:1');
    await r.bindings.pause(first.binding.id);
    expect(await firer.fire(first)).toEqual({ status: 'deferred', reason: 'paused' });
    expect(await firer.fire(first)).toEqual({ status: 'deferred', reason: 'paused' });
    expect(r.runtime.started).toEqual([]);
    expect(await ledger.has(first.binding.id, 'issue_opened:1')).toBe(false);
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([
      expect.objectContaining({ reason: 'paused', retry: true, key: 'issue_opened:1' }),
    ]);

    await r.bindings.resume(first.binding.id);
    expect((await firer.fire(await item('issue_opened:1'))).status).toBe('fired');
  });

  it('an exhausted budget defers the item', async () => {
    const { r, firer, item } = await firing({ budgetUsd: 1 });
    const first = await item('issue_opened:1');
    await r.bindings.recordSpend(first.binding.id, 2);
    const outcome = await firer.fire(await item('issue_opened:1'));
    expect(outcome.status).toBe('deferred');
    expect(r.runtime.started).toEqual([]);
    expect((await r.eventsOf('workflow.trigger.skipped')).map((e) => e.reason)).toEqual(['budget']);
  });

  it('a binding whose version range matches nothing defers the item as no_workflow', async () => {
    const { r, firer, item } = await firing();
    const first = await item('issue_opened:1');
    await r.bindings.update(first.binding.id, { versionRange: '9.x' });
    expect(await firer.fire(await item('issue_opened:1'))).toEqual({
      status: 'deferred',
      reason: 'no_workflow',
    });
  });

  it('a run the runtime refuses is dropped for good, with the reason', async () => {
    const { r, firer, ledger, item } = await firing();
    r.runtime.refuseWith = 'the input is wrong';
    const first = await item('issue_opened:1');
    expect(await firer.fire(first)).toEqual({ status: 'dropped', reason: 'refused' });
    expect(await ledger.has(first.binding.id, 'issue_opened:1')).toBe(true);
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([
      expect.objectContaining({
        reason: 'refused',
        retry: false,
        detail: expect.stringContaining('the input is wrong') as string,
      }),
    ]);
  });

  it('a binding that was stopped meanwhile fires nothing and says nothing', async () => {
    const { r, firer, item } = await firing();
    const first = await item('issue_opened:1');
    await r.bindings.stop(first.binding.id);
    expect(await firer.fire(first)).toEqual({ status: 'dropped', reason: 'binding_gone' });
    expect(r.runtime.started).toEqual([]);
    expect(await r.eventsOf('workflow.trigger.skipped')).toEqual([]);
  });

  it('the same item twice is one run: the second start is a Conflict read as already fired', async () => {
    const { r, firer, ledger, item } = await firing();
    const first = await item('issue_opened:1');
    expect((await firer.fire(first)).status).toBe('fired');
    // The mark is lost (a crash between the start and the write of the ledger).
    const fresh = new SeenLedger(workflowTriggersFile(r.dataDir) + '.other');
    const again = new TriggerFirer({
      clock: r.clock,
      events: r.store.events,
      logger: { error: () => undefined },
      plays: r.store.plays,
      bindings: r.bindings,
      library: r.library,
      runtime: r.runtime,
      ledger: fresh,
    });
    await r.runtime.finish(r.runtime.started[0]?.runId ?? '');
    expect(await again.fire(first)).toEqual({ status: 'dropped', reason: 'already_fired' });
    expect(await fresh.has(first.binding.id, 'issue_opened:1')).toBe(true);
    expect(await ledger.has(first.binding.id, 'issue_opened:1')).toBe(true);
    expect(r.runtime.started).toHaveLength(1);
  });
});
