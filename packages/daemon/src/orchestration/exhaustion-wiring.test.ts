// SPDX-License-Identifier: MPL-2.0
import type { Profile } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import type { BudgetChoice } from '../budget/service.js';
import { createLateExhaustion } from '../execution/exhaustion.js';
import { createSilentLogger } from '../logger.js';
import { createDaemonExhaustion, type DaemonExhaustionDeps } from './exhaustion-wiring.js';

/** The rules of an exhaustion read from the role and the budget at the moment it happens (P19). */

const PROFILE: Profile = { client: 'fake', profile: 'one', id: 'fake/one', dir: '/p/one' };

async function deps(
  parts: {
    inFlight?: 'handoff' | 'finish' | 'stop';
    choice?: BudgetChoice['choice'];
    whenExhausted?: 'wait' | 'next';
  } = {},
): Promise<DaemonExhaustionDeps> {
  const store = new InMemoryStore({ clock: new FakeClock() });
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play.default',
    name: 'exhaustion',
    folder: '/work/exhaustion',
    baseBranch: 'main',
  });
  await store.plays.create({
    id: 'p1',
    scenarioId: 's1',
    need: 'x',
    flowId: 'play.default',
    flowVersion: 1,
    state: 'EXECUTING',
    counters: {},
  });
  return {
    store,
    selection: {
      selectorInputs: () =>
        Promise.resolve({
          roles:
            parts.whenExhausted === undefined
              ? {}
              : { actor: { whenExhausted: parts.whenExhausted } },
        } as never),
    },
    budget: {
      settingsOf: () => ({ onExceeded: 'skip', inFlight: parts.inFlight ?? 'handoff' }),
      resolveExceeded: () =>
        parts.choice === undefined
          ? undefined
          : Promise.resolve({ choice: parts.choice, via: 'config' } as BudgetChoice),
    },
    logger: createSilentLogger(),
  };
}

describe('the exhaustion port of the daemon', () => {
  it('reads when_exhausted of the role, in_flight of the profile and the answer about the cap', async () => {
    const port = createDaemonExhaustion(
      await deps({ inFlight: 'finish', choice: 'wait', whenExhausted: 'wait' }),
    );
    expect(await port.rulesOf({ playId: 'p1', role: 'actor', profile: PROFILE })).toEqual({
      inFlight: 'finish',
      waitForCap: true,
      whenExhausted: 'wait',
    });
  });

  it('says no to the cap when it is not spent or the answer is skip, and leaves out what it does not know', async () => {
    const none = createDaemonExhaustion(await deps());
    expect(await none.rulesOf({ playId: 'p1', role: 'actor', profile: PROFILE })).toEqual({
      inFlight: 'handoff',
      waitForCap: false,
    });
    const skip = createDaemonExhaustion(await deps({ choice: 'skip' }));
    expect(await skip.rulesOf({ playId: 'p1', role: undefined, profile: PROFILE })).toEqual({
      inFlight: 'handoff',
      waitForCap: false,
    });
  });

  it('does not swallow a failure: the runner is the one that says it', async () => {
    const base = await deps();
    const port = createDaemonExhaustion({
      ...base,
      selection: { selectorInputs: () => Promise.reject(new Error('no config')) },
    });
    await expect(port.rulesOf({ playId: 'p1', role: 'actor', profile: PROFILE })).rejects.toThrow(
      'no config',
    );
  });
});

describe('the late port of the exhaustion rules', () => {
  it('knows nothing until it is bound, and nothing again once it is unbound', async () => {
    const late = createLateExhaustion();
    const request = { playId: 'p1', role: 'actor', profile: PROFILE };
    expect(await late.port.rulesOf(request)).toEqual({});
    late.bind({ rulesOf: () => Promise.resolve({ whenExhausted: 'wait' }) });
    expect(await late.port.rulesOf(request)).toEqual({ whenExhausted: 'wait' });
    late.bind(undefined);
    expect(await late.port.rulesOf(request)).toEqual({});
  });
});
