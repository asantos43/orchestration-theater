// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayFakes,
  type PlayHarness,
} from './e2e-fixture.js';
import { itWithLauncher } from '../launcher-fixture.js';
import { RefusalSchema, summarizeRefusal, wasDenied } from './refusal.js';

/**
 * An Actor that asks layer 2 for a permission and is denied (N181, decided by the owner on
 * 2026-11-20): when the attempt ends blocked or with no change, the daemon sends `ACTOR_REFUSED`
 * and the Director judges point 6 (`refusal_or_permission`), instead of the plan going back to
 * the script or the Critic finding an empty diff. The default policy answers `on_ask: reject`.
 * Since N182 the Actor edits inside its worktree with no request by default, so these runs turn
 * `edit_in_worktree` off: the fake Actor asks for exactly that edit and must reach layer 2.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const EDIT_ASKS = 'roles:\n  actor:\n    policy:\n      edit_in_worktree: ask';

function fakes(): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

/** The decisions of judgment point 6 of the play. */
async function pointSix(harness: PlayHarness, playId: string) {
  const rows = await harness.daemon.store.decisions.list({
    playId,
    kinds: ['judge.refusal_or_permission'],
  });
  return rows.map((row) => ({ state: row.state, input: row.input, answer: row.answer }));
}

async function attemptsOf(harness: PlayHarness, playId: string) {
  return (await harness.daemon.store.attempts.list()).filter(
    (attempt) => attempt.playId === playId && attempt.demandId === 'alpha',
  );
}

async function openPlay(harness: PlayHarness, need: string): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, `#ot-play ${need}`);
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  await waitFor('DONE', async () => {
    return (await harness.daemon.store.plays.get(play.id))?.state === 'DONE';
  });
  return play.id;
}

describe('the summary of a refusal', () => {
  const answer = (answerOf: string, tool: string, paths: string[], reason = 'on_ask_reject') => ({
    answer: answerOf,
    tool,
    paths,
    reason,
  });

  it('counts a rejection and a cancel, not an allow', () => {
    expect(wasDenied('reject')).toBe(true);
    expect(wasDenied('cancelled')).toBe(true);
    expect(wasDenied('allow')).toBe(false);
  });

  it('is undefined when layer 2 denied nothing', () => {
    expect(
      summarizeRefusal([answer('allow', 'Write', ['/w/a.txt'], 'rule')], {
        attempt: 1,
        ended: 'blocked',
        worktree: '/w',
        actorReason: undefined,
      }),
    ).toBeUndefined();
  });

  it('keeps the denied tools and files, relative to the worktree, without repeats, and cuts them', () => {
    const long = 'x'.repeat(500);
    const refusal = summarizeRefusal(
      [
        answer('reject', 'Write', ['/w/a.txt']),
        answer('reject', 'Write', ['/w/a.txt', '/elsewhere/b.txt']),
        answer('cancelled', 'Bash', [], 'native_shell'),
        answer('allow', 'Read', ['/w/ok.txt'], 'rule'),
        ...Array.from({ length: 12 }, (_, i) => answer('reject', `T${String(i)}`, [`/w/${long}`])),
      ],
      { attempt: 2, ended: 'no_change', worktree: '/w', actorReason: long },
    );
    expect(RefusalSchema.safeParse(refusal).success).toBe(true);
    expect(refusal).toMatchObject({ attempt: 2, ended: 'no_change', denied: 15 });
    expect(refusal?.tools.slice(0, 3)).toEqual(['Write', 'Bash', 'T0']);
    expect(refusal?.tools).toHaveLength(8);
    expect(refusal?.paths.slice(0, 2)).toEqual(['a.txt', '/elsewhere/b.txt']);
    expect(refusal?.paths.every((path) => path.length <= 200)).toBe(true);
    expect(refusal?.reasons).toEqual(['on_ask_reject', 'native_shell']);
    expect(refusal?.actorReason).toHaveLength(200);
  });
});

describe('a refused Actor, end to end with the fake agent', { timeout: 120_000 }, () => {
  itWithLauncher(
    'opens judgment point 6 before the Critic, the Director reformulates and the play delivers',
    async () => {
      await withPlayDaemon(fakes(), { extra: EDIT_ASKS }, async (harness) => {
        const playId = await openPlay(harness, 'write alpha #actor-refused:alpha@1');
        const rows = await pointSix(harness, playId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          state: 'decided',
          input: {
            demandId: 'alpha',
            refused: {
              attempt: 1,
              ended: 'blocked',
              denied: 1,
              paths: ['alpha.txt'],
              reasons: ['on_ask_reject'],
              actorReason: 'alpha: permission denied',
            },
          },
          answer: { action: 'reformulate' },
        });
        // `reformulate` is a new attempt, the second one delivers (the marker holds for the first)
        const attempts = await attemptsOf(harness, playId);
        expect(attempts).toHaveLength(2);
        // the judgment is a point of EXECUTING: the play never left it for the script, and the
        // Critic came only after the integration of the work that was finally delivered
        // (the path has one entry per event; the states come in runs)
        const visited = await harness.pathOf(playId);
        const path = visited.filter((state, i) => state !== visited[i - 1]);
        expect(path.filter((state) => state === 'EXECUTING')).toHaveLength(1);
        expect(path.filter((state) => state === 'SCRIPTING')).toHaveLength(1);
        expect(path.indexOf('CRITIQUING')).toBeGreaterThan(path.indexOf('INTEGRATING'));
        // the denial is in the log too, one `permission.answered` per request
        const events = await harness.daemon.store.events.readFrom(0, 5000);
        const denials = events.filter(
          (event) =>
            event.type === 'permission.answered' &&
            (event.payload as { answer?: string }).answer === 'reject',
        );
        expect(denials).toHaveLength(1);
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
      });
    },
  );

  itWithLauncher(
    'changes nothing when the denied permission does not stop the delivery',
    async () => {
      await withPlayDaemon(fakes(), { extra: EDIT_ASKS }, async (harness) => {
        const playId = await openPlay(harness, 'write alpha #actor-refused:alpha=anyway');
        expect(await pointSix(harness, playId)).toEqual([]);
        const attempts = await attemptsOf(harness, playId);
        expect(attempts).toHaveLength(1);
        // the Actor was denied, and the play did not care: the file was written and delivered
        const events = await harness.daemon.store.events.readFrom(0, 5000);
        expect(
          events.some(
            (event) =>
              event.type === 'permission.answered' &&
              (event.payload as { answer?: string }).answer === 'reject',
          ),
        ).toBe(true);
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
      });
    },
  );

  itWithLauncher(
    'with the default policy the edit inside the worktree is allowed, and nothing is refused (N182)',
    async () => {
      await withPlayDaemon(fakes(), {}, async (harness) => {
        const playId = await openPlay(harness, 'write alpha #actor-refused:alpha@1');
        expect(await pointSix(harness, playId)).toEqual([]);
        expect(await attemptsOf(harness, playId)).toHaveLength(1);
        const events = await harness.daemon.store.events.readFrom(0, 5000);
        const answers = events
          .filter((event) => event.type === 'permission.answered')
          .map((event) => event.payload as { answer?: string; reason?: string });
        expect(answers).toEqual([
          expect.objectContaining({ answer: 'allow', reason: 'edit_in_worktree' }),
        ]);
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
      });
    },
  );
});
