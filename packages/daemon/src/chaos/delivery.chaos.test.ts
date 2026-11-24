// SPDX-License-Identifier: MPL-2.0
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  type BranchTarget,
  integrationBranch,
  type MergeBranchOptions,
  type MergeBranchResult,
  type OpenPullRequestOptions,
  type PullRequest,
  type SideEffectRecord,
  Transient,
} from '@otheater/core';
import { FakeClock, FakeCodeHost, InMemoryStore } from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { createSilentLogger } from '../logger.js';
import { reconcileBeforeResume } from '../recovery/reconcile.js';
import { MAX_EFFECT_ATTEMPTS } from '../workspace/effects.js';
import {
  demandOf,
  makeWorkspaceRig,
  scriptOf,
  type WorkspaceRig,
} from '../workspace/workspace-fixture.js';
import {
  type DeliveryResult,
  type DeliverInput,
  type IntegrateInput,
  type IntegrationResult,
  Workspace,
} from '../workspace/workspace.js';
import { armFaults, type CrashInfo, disarmFaults } from './crash-points.js';
import { checkI4, type CodeHostJournalEntry } from './invariants.js';

/**
 * Idempotency of the integration and of the delivery under a crash at every boundary of
 * `runEffect` (Phase 11, P7; docs/23). The Workspace runs in this process over a real git
 * repository and the fake code host (with a journal of what changed on the "remote"); a crash is
 * the `effects.*` point of `crash-points.ts` armed with a plan whose action throws, which leaves
 * the registry exactly as a `SIGKILL` at that point would (the registry outlives it, like the
 * store file), and the "restart" is a new `Workspace` over the same store and host. Nothing waits
 * for a clock: the gates are promises.
 *
 * What is checked after every resume: I4 (the journal of the code host shows no effect twice and
 * the calls of each operation are counted), I5 (no record stays `pending` or `ambiguous` unless
 * the answer of the step said `ambiguous`), the chain of keys (`<key>~2` is born only after a
 * `not_done` or a `failed`, never after a `done`), and that the completion event is written once.
 */

afterAll(disposeTestGitIsolation);
afterEach(disarmFaults);

const PLAY = 'play-1';
const SCENARIO = 'scenario-1';
const T = 120_000;
const BRANCH = integrationBranch(PLAY);
const SCRIPT = scriptOf([demandOf('d1')]);

// -- The fake host with a journal ----------------------------------------------------------

/**
 * {@link FakeCodeHost} that also writes the journal that `checkI4` reads: one entry per change
 * that took effect on the remote (a push of the commit it already has, a merge that moved nothing
 * and a refused request change nothing). The calls of every operation, refused ones included, are
 * still in `calls` and `callCount`.
 */
class JournalHost extends FakeCodeHost {
  readonly journal: CodeHostJournalEntry[] = [];
  readonly #gates = new Map<string, Gate>();

  /** Holds the next call of `method` after it computed its answer, until `release()`. */
  hold(method: 'openPullRequest' | 'pushRef' | 'mergeBranch'): Gate {
    const gate = makeGate();
    this.#gates.set(method, gate);
    return gate;
  }

  async #pause(method: string): Promise<void> {
    const gate = this.#gates.get(method);
    if (gate === undefined) return;
    this.#gates.delete(method);
    gate.enter();
    await gate.released;
  }

  override async pushRef(target: BranchTarget): Promise<string> {
    const before = await super.remoteRef(target);
    const sha = await super.pushRef(target);
    if (sha !== before) this.journal.push({ op: 'pushRef', target, sha });
    await this.#pause('pushRef');
    return sha;
  }

  override async openPullRequest(opts: OpenPullRequestOptions): Promise<PullRequest> {
    const pull = await super.openPullRequest(opts);
    this.journal.push({ op: 'openPullRequest', opts: { head: opts.head, base: opts.base } });
    await this.#pause('openPullRequest');
    return pull;
  }

  override async mergeBranch(opts: MergeBranchOptions): Promise<MergeBranchResult> {
    const target: BranchTarget = {
      repo: opts.repo,
      branch: opts.base,
      ...(opts.remote === undefined ? {} : { remote: opts.remote }),
    };
    const before = await super.remoteRef(target);
    const result = await super.mergeBranch(opts);
    if (result.sha !== before) {
      this.journal.push({ op: 'mergeBranch', opts: { head: opts.head, base: opts.base } });
    }
    await this.#pause('mergeBranch');
    return result;
  }
}

interface Gate {
  /** Resolves when a call reached the gate. */
  readonly entered: Promise<void>;
  /** Resolved by `release`; the held call waits for it. */
  readonly released: Promise<void>;
  enter(): void;
  release(): void;
}

function makeGate(): Gate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, released, enter, release };
}

// -- The simulated crash -------------------------------------------------------------------

/** What the armed point throws instead of the `SIGKILL`: the code after the point never runs. */
class SimulatedCrash extends Error {
  constructor(readonly info: CrashInfo) {
    super(`crash at ${info.point}${info.detail === undefined ? '' : `:${info.detail}`}`);
    this.name = 'SimulatedCrash';
  }
}

function armCrash(point: string, detail: string, nth = 1): void {
  armFaults(
    { crash: [{ point, detail, nth }], fail: [] },
    {
      onCrash: (info) => {
        throw new SimulatedCrash(info);
      },
    },
  );
}

/** Runs `run` with a crash armed and expects it to die exactly there. */
async function runUntilCrash(point: string, detail: string, run: () => Promise<unknown>) {
  armCrash(point, detail);
  try {
    await run();
  } catch (error) {
    if (error instanceof SimulatedCrash) {
      expect(error.info.point).toBe(point);
      return;
    }
    throw error;
  } finally {
    disarmFaults();
  }
  throw new Error(`The run ended without reaching ${point}:${detail}`);
}

// -- The rig -------------------------------------------------------------------------------

interface Rig {
  readonly clock: FakeClock;
  readonly store: InMemoryStore;
  readonly host: JournalHost;
  readonly ws: WorkspaceRig;
  /** A new Workspace over the same store, host and repository: the daemon after a restart. */
  restarted(): Workspace;
  integrateInput(): IntegrateInput;
  deliverInput(mode: 'pr' | 'direct_merge'): DeliverInput;
  /** Brings the work to the point where the delivery starts, with no crash. */
  integrated(): Promise<string>;
  records(): Promise<readonly SideEffectRecord[]>;
  eventsOf(type: string): Promise<readonly unknown[]>;
  dispose(): Promise<void>;
}

const rigs: Rig[] = [];

async function makeRig(): Promise<Rig> {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const host = new JournalHost({ clock });
  const ws = await makeWorkspaceRig({ store, codeHost: host });
  await store.scenarios.create({
    id: SCENARIO,
    kind: 'project',
    flowId: 'play',
    name: 'scenario',
    folder: ws.repo,
    baseBranch: 'main',
  });
  await store.plays.create({
    id: PLAY,
    scenarioId: SCENARIO,
    need: 'need',
    flowId: 'play',
    flowVersion: 1,
    state: 'DELIVERING',
    counters: {},
  });
  await ws.workspace.createPlayBase({ repo: ws.repo, playId: PLAY, base: 'main' });
  await ws.attempt(PLAY, 'd1', 1, { 'd1.txt': 'one\n' });
  const rig: Rig = {
    clock,
    store,
    host,
    ws,
    restarted: () =>
      new Workspace({ store, vcs: ws.vcs, codeHost: host, worktreeRoot: ws.worktreeRoot }),
    integrateInput: () => ({
      repo: ws.repo,
      playId: PLAY,
      scenarioId: SCENARIO,
      script: SCRIPT,
      approved: [{ demandId: 'd1', attempt: 1 }],
    }),
    deliverInput: (mode) => ({
      repo: ws.repo,
      playId: PLAY,
      scenarioId: SCENARIO,
      base: 'main',
      title: 'Deliver play 1',
      configMode: mode,
      allowDirectMerge: true,
      requested: { mode, by: 'play' },
      attended: true,
    }),
    async integrated() {
      const result = await ws.workspace.integrate(rig.integrateInput());
      if (result.kind !== 'integrated') throw new Error(result.kind);
      // The fake host has no git: it learns the branch the real repository has.
      host.seedRemote(ws.repo, 'main');
      host.adoptLocal(ws.repo, BRANCH, result.head);
      return result.head;
    },
    records: () => store.sideEffects.list(),
    eventsOf: async (type) => (await store.events.readFrom(0, 1000)).filter((e) => e.type === type),
    dispose: () => ws.dispose(),
  };
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
});

// -- What is checked ------------------------------------------------------------------------

/**
 * The chain of keys: `<key>~n` exists only when `<key>~(n-1)` (or `<key>`) was settled `not_done`
 * or `failed`, and no record of the step is ever followed by a new key after a `done`.
 */
function expectKeyChains(records: readonly SideEffectRecord[]): void {
  const byKey = new Map(records.map((record) => [record.idempotencyKey, record]));
  for (const record of records) {
    const match = /^(.*)~(\d+)$/.exec(record.idempotencyKey);
    if (match === null) continue;
    const base = match[1] ?? '';
    const n = Number(match[2]);
    const previousKey = n === 2 ? base : `${base}~${String(n - 1)}`;
    const previous = byKey.get(previousKey);
    expect(previous, `${record.idempotencyKey} has no ${previousKey} before it`).toBeDefined();
    expect(['not_done', 'failed']).toContain(previous?.state);
  }
}

function expectNoOpenRecords(records: readonly SideEffectRecord[]): void {
  const open = records.filter((r) => r.state === 'pending' || r.state === 'ambiguous');
  expect(open.map((r) => `${r.idempotencyKey}:${r.state}`)).toEqual([]);
}

/** I4 over the journal of the host. */
function expectI4(rig: Rig): void {
  const result = checkI4(rig.host.journal);
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
}

function statesOf(records: readonly SideEffectRecord[], type: string): string[] {
  return records.filter((r) => r.type === type).map((r) => `${r.idempotencyKey}=${r.state}`);
}

function delivered(result: DeliveryResult) {
  if (result.kind !== 'delivered') throw new Error(`Expected delivered, got ${result.kind}`);
  return result;
}

function integrated(result: IntegrationResult) {
  if (result.kind !== 'integrated') throw new Error(`Expected integrated, got ${result.kind}`);
  return result;
}

/** How many merges that carry the idempotency trailer the integration branch has. */
async function trailerCommits(rig: Rig, key: string): Promise<number> {
  const log = await testGit(rig.ws.repo, 'log', BRANCH, '--format=%B%x00');
  return log.split('\0').filter((message) => message.includes(`Idempotency-Key: ${key}`)).length;
}

/** The points of the boundaries of `runEffect` that a single run can reach, and what each leaves. */
const BOUNDARIES = [
  { point: 'effects.before_intend', left: 'nothing', keys: 1 },
  { point: 'effects.after_intend', left: 'pending', keys: 2 },
  { point: 'effects.after_execute', left: 'pending', keys: 1 },
  { point: 'effects.after_resolve', left: 'done', keys: 1 },
] as const;

type Resume = 'again' | 'reconcile_then_again';

async function resume(rig: Rig, how: Resume): Promise<void> {
  if (how === 'again') return;
  await reconcileBeforeResume({
    store: rig.store,
    vcs: rig.ws.vcs,
    codeHost: rig.host,
    launcher: undefined,
    logger: createSilentLogger(),
  });
}

// -- The four types, one boundary at a time ---------------------------------------------------

describe('a crash at every boundary of runEffect, then the resume', () => {
  for (const how of ['again', 'reconcile_then_again'] as const) {
    describe(`resumed by ${how === 'again' ? 'the same call again' : 'the reconciliation and then the call'}`, () => {
      // git_commit: the merges of the integration.
      for (const { point, left, keys } of BOUNDARIES) {
        it(
          `git_commit crashed at ${point}: the merge is made once (${left})`,
          async () => {
            const rig = await makeRig();
            await runUntilCrash(point, 'git_commit', () =>
              rig.ws.workspace.integrate(rig.integrateInput()),
            );
            const key = 'play-1:integrate:d1:1';
            const crashed = await rig.records();
            expect(statesOf(crashed, 'git_commit')).toEqual(
              left === 'nothing' ? [] : [`${key}=${left}`],
            );

            await resume(rig, how);
            const result = integrated(await rig.restarted().integrate(rig.integrateInput()));
            expect(result.merged).toHaveLength(1);

            // One merge commit with the trailer, whatever key carried it.
            expect(await trailerCommits(rig, key)).toBe(1);
            const records = await rig.records();
            expect(records.filter((r) => r.type === 'git_commit')).toHaveLength(keys);
            expectKeyChains(records);
            expectNoOpenRecords(records);
            // The head moved by one merge only.
            expect(
              await testGit(rig.ws.repo, 'rev-list', '--count', `play/${PLAY}/base..${BRANCH}`),
            ).toBe('2');
            // And a third call changes nothing.
            const third = integrated(await rig.restarted().integrate(rig.integrateInput()));
            expect(third.head).toBe(result.head);
            expect((await rig.records()).length).toBe(records.length);
            // The event of the integration is written once, even when the crash came after the
            // last "after" and the resume had only a record to replay.
            expect(await rig.eventsOf('workspace.integrated')).toHaveLength(1);
          },
          T,
        );
      }

      // git_push, open_pr (mode pr) and merge_base (mode direct_merge).
      const DELIVERIES = [
        { type: 'git_push', mode: 'pr', mutating: 'pushRef' },
        { type: 'open_pr', mode: 'pr', mutating: 'openPullRequest' },
        { type: 'merge_base', mode: 'direct_merge', mutating: 'mergeBranch' },
      ] as const;
      for (const { type, mode, mutating } of DELIVERIES) {
        for (const { point, left, keys } of BOUNDARIES) {
          it(
            `${type} crashed at ${point}: ${mutating} reaches the host once (${left})`,
            async () => {
              const rig = await makeRig();
              const head = await rig.integrated();
              await runUntilCrash(point, type, () =>
                rig.ws.workspace.deliver(rig.deliverInput(mode)),
              );
              const crashed = await rig.records();
              expect(statesOf(crashed, type)).toHaveLength(left === 'nothing' ? 0 : 1);
              expect(crashed.filter((r) => r.type === type).map((r) => r.state)).toEqual(
                left === 'nothing' ? [] : [left],
              );

              await resume(rig, how);
              const result = delivered(await rig.restarted().deliver(rig.deliverInput(mode)));
              expect(result.pushedSha).toBe(head);

              // The diary of the host: every operation that changes it was called once.
              expect(rig.host.callCount('pushRef')).toBe(1);
              expect(rig.host.callCount('openPullRequest')).toBe(mode === 'pr' ? 1 : 0);
              expect(rig.host.callCount('mergeBranch')).toBe(mode === 'direct_merge' ? 1 : 0);
              expect(rig.host.pullRequests()).toHaveLength(mode === 'pr' ? 1 : 0);
              expectI4(rig);

              const records = await rig.records();
              expect(records.filter((r) => r.type === type)).toHaveLength(keys);
              if (keys === 1)
                expect(records.some((r) => r.idempotencyKey.includes('~'))).toBe(false);
              expectKeyChains(records);
              expectNoOpenRecords(records);

              // Whatever the crash, the completion is told once.
              expect(await rig.eventsOf('delivery.completed')).toHaveLength(1);
              // A third call is a replay: same answer, nothing more at the host.
              const third = await rig.restarted().deliver(rig.deliverInput(mode));
              expect(third).toEqual(result);
              expect(rig.host.callCount(mutating)).toBe(1);
              expect(await rig.eventsOf('delivery.completed')).toHaveLength(1);
            },
            T,
          );
        }
      }
    });
  }
});

// -- after_verify: the verifier said done and the daemon died before writing it -----------------

describe('a crash after the verifier said done', () => {
  for (const [type, mode, mutating] of [
    ['git_push', 'pr', 'pushRef'],
    ['open_pr', 'pr', 'openPullRequest'],
    ['merge_base', 'direct_merge', 'mergeBranch'],
  ] as const) {
    it(
      `${type}: the effect was done, the verifier finds it, dies at effects.after_verify, and the next run settles it`,
      async () => {
        const rig = await makeRig();
        await rig.integrated();
        await runUntilCrash('effects.after_execute', type, () =>
          rig.ws.workspace.deliver(rig.deliverInput(mode)),
        );
        // The first resume: the verifier says `done` and the daemon dies before resolving.
        await runUntilCrash('effects.after_verify', type, () =>
          rig.restarted().deliver(rig.deliverInput(mode)),
        );
        expect(statesOf(await rig.records(), type)).toHaveLength(1);
        expect((await rig.records()).find((r) => r.type === type)?.state).toBe('pending');

        const result = delivered(await rig.restarted().deliver(rig.deliverInput(mode)));
        expect(result.mode).toBe(mode);
        expect(rig.host.callCount(mutating)).toBe(1);
        expectI4(rig);
        const records = await rig.records();
        expect(records.some((r) => r.idempotencyKey.includes('~'))).toBe(false);
        expect(records.filter((r) => r.type === type).map((r) => r.verifier)).toEqual(['verifier']);
        expectNoOpenRecords(records);
        expect(await rig.eventsOf('delivery.completed')).toHaveLength(1);
      },
      T,
    );
  }

  it(
    'git_commit: the merge was done, the verifier finds the trailer, dies, and the next run settles it',
    async () => {
      const rig = await makeRig();
      await runUntilCrash('effects.after_execute', 'git_commit', () =>
        rig.ws.workspace.integrate(rig.integrateInput()),
      );
      await runUntilCrash('effects.after_verify', 'git_commit', () =>
        rig.restarted().integrate(rig.integrateInput()),
      );
      const result = integrated(await rig.restarted().integrate(rig.integrateInput()));
      expect(result.merged).toHaveLength(1);
      expect(await trailerCommits(rig, 'play-1:integrate:d1:1')).toBe(1);
      const records = await rig.records();
      expect(records.some((r) => r.idempotencyKey.includes('~'))).toBe(false);
      expectNoOpenRecords(records);
    },
    T,
  );
});

// -- The key `~2` ---------------------------------------------------------------------------------

describe('the key ~2', () => {
  it(
    'is born after a not_done (the crash came before the effect) and never after a done',
    async () => {
      const rig = await makeRig();
      await rig.integrated();
      await runUntilCrash('effects.after_intend', 'git_push', () =>
        rig.ws.workspace.deliver(rig.deliverInput('pr')),
      );
      delivered(await rig.restarted().deliver(rig.deliverInput('pr')));
      const records = await rig.records();
      const pushes = records.filter((r) => r.type === 'git_push');
      expect(pushes.map((r) => [r.idempotencyKey.endsWith('~2'), r.state])).toEqual([
        [false, 'not_done'],
        [true, 'done'],
      ]);
      expectKeyChains(records);

      // Every later call replays the `done`: no `~3`, nothing at the host.
      for (let i = 0; i < 3; i += 1)
        delivered(await rig.restarted().deliver(rig.deliverInput('pr')));
      expect((await rig.records()).filter((r) => r.type === 'git_push')).toHaveLength(2);
      expect(rig.host.callCount('pushRef')).toBe(1);
    },
    T,
  );

  it(
    'is born after a failed (the host refused) and the failure is not repeated by the replay',
    async () => {
      const rig = await makeRig();
      await rig.integrated();
      rig.host.failNext('openPullRequest', new Transient('The host is down for a moment'));
      await expect(rig.ws.workspace.deliver(rig.deliverInput('pr'))).rejects.toBeInstanceOf(
        Transient,
      );
      const failed = (await rig.records()).filter((r) => r.type === 'open_pr');
      expect(failed.map((r) => r.state)).toEqual(['failed']);

      delivered(await rig.restarted().deliver(rig.deliverInput('pr')));
      const records = await rig.records();
      expect(
        records
          .filter((r) => r.type === 'open_pr')
          .map((r) => [r.idempotencyKey.endsWith('~2'), r.state]),
      ).toEqual([
        [false, 'failed'],
        [true, 'done'],
      ]);
      expectKeyChains(records);
      expect(rig.host.callCount('openPullRequest')).toBe(2);
      expect(rig.host.pullRequests()).toHaveLength(1);
      expectI4(rig);
    },
    T,
  );

  it(`stops at ${String(MAX_EFFECT_ATTEMPTS)} keys per step, so a verifier that always says not_done cannot loop`, () => {
    // The bound is the protocol's; the loop itself is covered by effects.test.ts.
    expect(MAX_EFFECT_ATTEMPTS).toBeGreaterThan(2);
  });
});

// -- A PR that is there before the record ---------------------------------------------------------

describe('verifyOpenPr: a PR that was created before the record', () => {
  it(
    'an open PR for the same head and base is adopted: no second request, and the key stays the first',
    async () => {
      const rig = await makeRig();
      const head = await rig.integrated();
      // Someone (an earlier life of the play, or the Producer by hand) opened it earlier.
      await rig.host.pushRef({ repo: rig.ws.repo, branch: BRANCH });
      const before = await rig.host.openPullRequest({
        repo: rig.ws.repo,
        head: BRANCH,
        base: 'main',
        title: 'Opened by hand',
        body: '',
      });
      await rig.clock.advance(60_000);
      const callsBefore = rig.host.callCount('openPullRequest');

      const result = delivered(await rig.ws.workspace.deliver(rig.deliverInput('pr')));
      expect(result.pullRequest?.number).toBe(before.number);
      expect(result.pushedSha).toBe(head);
      expect(rig.host.callCount('openPullRequest')).toBe(callsBefore);
      expect(rig.host.pullRequests()).toHaveLength(1);
      expectKeyChains(await rig.records());
    },
    T,
  );

  it(
    'the same through the verifier: the intent is recorded after the PR exists, the crash comes before the effect, and the resume adopts it',
    async () => {
      const rig = await makeRig();
      await rig.integrated();
      await rig.host.pushRef({ repo: rig.ws.repo, branch: BRANCH });
      await runUntilCrash('effects.after_intend', 'open_pr', () =>
        rig.ws.workspace.deliver(rig.deliverInput('pr')),
      );
      // The host got the PR (by another path) after the record and before the verifier.
      const opened = await rig.host.openPullRequest({
        repo: rig.ws.repo,
        head: BRANCH,
        base: 'main',
        title: 'Opened by hand',
        body: '',
      });
      const result = delivered(await rig.restarted().deliver(rig.deliverInput('pr')));
      expect(result.pullRequest?.number).toBe(opened.number);
      expect(rig.host.callCount('openPullRequest')).toBe(1);
      const records = await rig.records();
      expect(records.some((r) => r.idempotencyKey.includes('~'))).toBe(false);
      expect(records.find((r) => r.type === 'open_pr')?.verifier).toBe('verifier');
    },
    T,
  );

  for (const state of ['closed', 'merged'] as const) {
    it(
      `an older ${state} PR does not count: the effect runs and opens a new one (with the key ~2 after the not_done)`,
      async () => {
        const rig = await makeRig();
        await rig.integrated();
        await rig.host.pushRef({ repo: rig.ws.repo, branch: BRANCH });
        const old = await rig.host.openPullRequest({
          repo: rig.ws.repo,
          head: BRANCH,
          base: 'main',
          title: 'An old one',
          body: '',
        });
        rig.host.setPullRequestState(old.number, state);
        await rig.clock.advance(60_000);
        await runUntilCrash('effects.after_intend', 'open_pr', () =>
          rig.ws.workspace.deliver(rig.deliverInput('pr')),
        );
        const result = delivered(await rig.restarted().deliver(rig.deliverInput('pr')));
        expect(result.pullRequest?.number).not.toBe(old.number);
        const records = (await rig.records()).filter((r) => r.type === 'open_pr');
        expect(records.map((r) => r.state)).toEqual(['not_done', 'done']);
        expectKeyChains(records);
        expect(rig.host.pullRequests().filter((p) => p.state === 'open')).toHaveLength(1);
      },
      T,
    );
  }
});

// -- The same delivery, three times -----------------------------------------------------------------

describe('the same delivery three times in a row', () => {
  for (const mode of ['pr', 'direct_merge'] as const) {
    it(
      `${mode}: the first does it, the other two only replay`,
      async () => {
        const rig = await makeRig();
        await rig.integrated();
        const first = delivered(await rig.ws.workspace.deliver(rig.deliverInput(mode)));
        const callsAfterFirst = rig.host.calls.length;
        const second = delivered(await rig.ws.workspace.deliver(rig.deliverInput(mode)));
        const third = delivered(await rig.restarted().deliver(rig.deliverInput(mode)));
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        // The replays do not even ask the host about what the registry already says is done.
        expect(rig.host.calls).toHaveLength(callsAfterFirst);
        expect(rig.host.callCount('pushRef')).toBe(1);
        expect(rig.host.callCount('openPullRequest')).toBe(mode === 'pr' ? 1 : 0);
        expect(rig.host.callCount('mergeBranch')).toBe(mode === 'direct_merge' ? 1 : 0);
        expectI4(rig);
        const records = await rig.records();
        expect(records.some((r) => r.idempotencyKey.includes('~'))).toBe(false);
        expectNoOpenRecords(records);
        expect(await rig.eventsOf('delivery.completed')).toHaveLength(1);
      },
      T,
    );
  }

  it(
    'the integration: three calls, one merge, one event',
    async () => {
      const rig = await makeRig();
      const first = integrated(await rig.ws.workspace.integrate(rig.integrateInput()));
      const second = integrated(await rig.restarted().integrate(rig.integrateInput()));
      const third = integrated(await rig.restarted().integrate(rig.integrateInput()));
      expect(second.head).toBe(first.head);
      expect(third.head).toBe(first.head);
      expect(await trailerCommits(rig, 'play-1:integrate:d1:1')).toBe(1);
      expect((await rig.records()).map((r) => r.idempotencyKey)).toEqual(['play-1:integrate:d1:1']);
      expect(await rig.eventsOf('workspace.integrated')).toHaveLength(1);
    },
    T,
  );
});

// -- The verifier cannot tell ---------------------------------------------------------------------

describe('a verifier that cannot tell (I5)', () => {
  it(
    'the record stays ambiguous, the answer says so, nothing is repeated, and a later run settles it',
    async () => {
      const rig = await makeRig();
      await rig.integrated();
      await runUntilCrash('effects.after_execute', 'git_push', () =>
        rig.ws.workspace.deliver(rig.deliverInput('pr')),
      );
      rig.host.failNext('remoteRef', new Transient('No answer'));
      const first = await rig.restarted().deliver(rig.deliverInput('pr'));
      expect(first).toMatchObject({ kind: 'ambiguous', step: 'push' });
      const open = (await rig.records()).filter((r) => r.type === 'git_push');
      expect(open.map((r) => r.state)).toEqual(['ambiguous']);
      expect(rig.host.callCount('pushRef')).toBe(1);
      expect(rig.host.callCount('openPullRequest')).toBe(0);

      // The reconciliation lists it for the Producer too.
      const report = await reconcileBeforeResume({
        store: rig.store,
        vcs: rig.ws.vcs,
        codeHost: rig.host,
        launcher: undefined,
        logger: createSilentLogger(),
      });
      expect(report.pending).toEqual([]);
      expect(report.resolved.map((r) => [r.effectType, r.outcome])).toEqual([['git_push', 'done']]);

      delivered(await rig.restarted().deliver(rig.deliverInput('pr')));
      expect(rig.host.callCount('pushRef')).toBe(1);
      expect(rig.host.callCount('openPullRequest')).toBe(1);
      expectNoOpenRecords(await rig.records());
      expectI4(rig);
    },
    T,
  );

  it(
    'the reconciliation reports an effect it could not check (pending for the Producer) and settles it when it can',
    async () => {
      const rig = await makeRig();
      await rig.integrated();
      await runUntilCrash('effects.after_execute', 'open_pr', () =>
        rig.ws.workspace.deliver(rig.deliverInput('pr')),
      );
      rig.host.failNext('findPullRequest', new Transient('No answer'));
      const deps = {
        store: rig.store,
        vcs: rig.ws.vcs,
        codeHost: rig.host,
        launcher: undefined,
        logger: createSilentLogger(),
      };
      const first = await reconcileBeforeResume(deps);
      expect(first.pending.map((p) => [p.effectType, p.playId])).toEqual([['open_pr', PLAY]]);
      expect((await rig.records()).find((r) => r.type === 'open_pr')?.state).toBe('ambiguous');
      // I5: the Producer was asked, once, and a second start asks nothing new.
      await reconcileBeforeResume(deps);
      const decisions = await rig.store.decisions.list({ playId: PLAY });
      expect(decisions.filter((d) => d.kind === 'recovery_effect')).toHaveLength(1);

      delivered(await rig.restarted().deliver(rig.deliverInput('pr')));
      expect(rig.host.callCount('openPullRequest')).toBe(1);
      expectNoOpenRecords(await rig.records());
    },
    T,
  );
});

// -- Two resumes at once ----------------------------------------------------------------------------

describe('two resumes of the same delivery at the same time', () => {
  it(
    'while the first is inside the effect, the second does not open a second PR nor take the record away',
    async () => {
      const rig = await makeRig();
      await rig.integrated();
      // A crash before the PR leaves its intent open; two resumers then come at once.
      await runUntilCrash('effects.after_intend', 'open_pr', () =>
        rig.ws.workspace.deliver(rig.deliverInput('pr')),
      );
      // The first one is held inside `openPullRequest`, after the host made the PR.
      const gate = rig.host.hold('openPullRequest');
      const first = rig.restarted().deliver(rig.deliverInput('pr'));
      await gate.entered;
      const second = rig.restarted().deliver(rig.deliverInput('pr'));
      // The second one gets as far as it can in a few turns of the loop (no timer is waited for).
      for (let turn = 0; turn < 50; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      gate.release();
      const [a, b] = await Promise.all([first, second]);
      expect(delivered(b)).toEqual(delivered(a));
      expect(rig.host.callCount('openPullRequest')).toBe(1);
      expect(rig.host.pullRequests()).toHaveLength(1);
      expectI4(rig);
      const records = await rig.records();
      expectKeyChains(records);
      expectNoOpenRecords(records);
      expect(await rig.eventsOf('delivery.completed')).toHaveLength(1);
    },
    T,
  );

  for (const { point, type, mode } of [
    { point: 'effects.before_intend', type: 'git_push', mode: 'pr' },
    { point: 'effects.after_intend', type: 'git_push', mode: 'pr' },
    { point: 'effects.after_execute', type: 'git_push', mode: 'pr' },
    { point: 'effects.after_resolve', type: 'git_push', mode: 'pr' },
    { point: 'effects.before_intend', type: 'open_pr', mode: 'pr' },
    { point: 'effects.after_intend', type: 'open_pr', mode: 'pr' },
    { point: 'effects.after_execute', type: 'open_pr', mode: 'pr' },
    { point: 'effects.after_resolve', type: 'open_pr', mode: 'pr' },
    { point: 'effects.before_intend', type: 'merge_base', mode: 'direct_merge' },
    { point: 'effects.after_intend', type: 'merge_base', mode: 'direct_merge' },
    { point: 'effects.after_execute', type: 'merge_base', mode: 'direct_merge' },
    { point: 'effects.after_resolve', type: 'merge_base', mode: 'direct_merge' },
  ] as const) {
    it(
      `${type} crashed at ${point}, two resumers: one effect, same answer`,
      async () => {
        const rig = await makeRig();
        await rig.integrated();
        await runUntilCrash(point, type, () => rig.ws.workspace.deliver(rig.deliverInput(mode)));
        const [a, b] = await Promise.all([
          rig.restarted().deliver(rig.deliverInput(mode)),
          rig.restarted().deliver(rig.deliverInput(mode)),
        ]);
        expect(delivered(b)).toEqual(delivered(a));
        expect(rig.host.callCount('pushRef')).toBe(1);
        expect(rig.host.callCount('openPullRequest')).toBe(mode === 'pr' ? 1 : 0);
        expect(rig.host.callCount('mergeBranch')).toBe(mode === 'direct_merge' ? 1 : 0);
        expectI4(rig);
        const records = await rig.records();
        expectKeyChains(records);
        expectNoOpenRecords(records);
        expect(await rig.eventsOf('delivery.completed')).toHaveLength(1);
      },
      T,
    );
  }

  for (const { point } of BOUNDARIES) {
    it(
      `git_commit crashed at ${point}, two resumers: one merge`,
      async () => {
        const rig = await makeRig();
        await runUntilCrash(point, 'git_commit', () =>
          rig.ws.workspace.integrate(rig.integrateInput()),
        );
        const [a, b] = await Promise.all([
          rig.restarted().integrate(rig.integrateInput()),
          rig.restarted().integrate(rig.integrateInput()),
        ]);
        expect(integrated(b).head).toBe(integrated(a).head);
        expect(await trailerCommits(rig, 'play-1:integrate:d1:1')).toBe(1);
        const records = await rig.records();
        expectKeyChains(records);
        expectNoOpenRecords(records);
        expect(await rig.eventsOf('workspace.integrated')).toHaveLength(1);
      },
      T,
    );
  }
});
