// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { assertFakeAgentBuilt, waitFor, withPlayDaemon, type PlayFakes } from './e2e-fixture.js';
import { itWithLauncher } from '../launcher-fixture.js';
import { blockedReasonOf } from './play-effects.js';

/**
 * A blocked Actor (prompt `actor.md`, "Blocked"; architecture 5.4). The real `phase6` round of
 * 2026-11-20 with the haiku showed the Actor finishing with `state: blocked` and the play
 * approving the demand anyway: the Critic then found an empty diff, three times, and the play
 * restarted the plan. The demand goes back to the script instead (`script_returns`).
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

function fakes(): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

describe('the reason of a blocked Actor', () => {
  it('reads the reason of a result whose state is blocked', () => {
    expect(blockedReasonOf({ result: { state: 'blocked', reason: 'no format' } })).toBe(
      'no format',
    );
  });

  it('falls back to the whole result when the reason is missing or empty', () => {
    expect(blockedReasonOf({ result: { state: 'blocked' } })).toBe('{"state":"blocked"}');
    expect(blockedReasonOf({ result: { state: 'blocked', reason: ' ' } })).toBe(
      '{"state":"blocked","reason":" "}',
    );
  });

  it('is undefined for any other result', () => {
    expect(blockedReasonOf({ result: { file: 'a.txt' } })).toBeUndefined();
    expect(blockedReasonOf({ result: { state: 'done' } })).toBeUndefined();
    expect(blockedReasonOf({ result: 'blocked' })).toBeUndefined();
    expect(blockedReasonOf({ result: ['blocked'] })).toBeUndefined();
    expect(blockedReasonOf(null)).toBeUndefined();
  });
});

describe('a blocked Actor, end to end with the fake agent', { timeout: 120_000 }, () => {
  itWithLauncher(
    'goes back to the script without the Critic, and the next script delivers',
    async () => {
      await withPlayDaemon(fakes(), {}, async (harness) => {
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, '#ot-play write alpha #actor-blocked:alpha@1');
        const play = await waitFor(
          'the play to exist',
          async () => (await harness.plays(scenarioId))[0],
        );
        await waitFor(
          'DONE',
          async () => (await harness.daemon.store.plays.get(play.id))?.state === 'DONE',
        );
        const path = await harness.pathOf(play.id);
        const back = path.findIndex(
          (state, i) => state === 'SCRIPTING' && path[i - 1] === 'EXECUTING',
        );
        // the first EXECUTING goes straight back to SCRIPTING: no integration, no Critic
        expect(back).toBeGreaterThan(0);
        expect(path.slice(0, back)).not.toContain('CRITIQUING');
        expect(path.slice(0, back)).not.toContain('INTEGRATING');
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
      });
    },
  );
});
