// SPDX-License-Identifier: MPL-2.0
import type { ProfileRef } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttemptOutcome } from '../execution/attempt-runner.js';
import { createSilentLogger } from '../logger.js';
import { MiniMaxProbeError, MiniMaxQuotaProbe } from '../quota/minimax-probe.js';
import { QuotaService } from '../quota/service.js';
import {
  startLoopbackServer,
  type LoopbackOptions,
  type LoopbackServer,
} from './loopback-server.js';
import { aliveEntries } from './census.js';
import {
  eventsOf,
  installExecutorFakes,
  scriptPrompt,
  withExecutorRig,
  type ExecutorRig,
} from './executor-fixture.js';

/** A fake clock that remembers every sleep asked of it: the gate that tells a backoff is armed. */
class RecordingClock extends FakeClock {
  readonly requested: number[] = [];
  override sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.requested.push(ms);
    return super.sleep(ms, signal);
  }
}

installExecutorFakes({
  clock: () => new RecordingClock(),
  vault: () => new InMemorySecretVault(),
  client: ({ parts, unenforced, enforcement, command, env }) =>
    new FakeClientAdapter({
      launcher: parts.launcher,
      baseEnv: {},
      env,
      adapterVersion: '1.0.0',
      enforcement,
      unenforced,
      command,
    }),
});

/**
 * Chaos B, the provider that is down (docs/23, P4; table "Como cada falha é simulada", line
 * "Provedor fora do ar"). The client is up and answers every prompt with an error: `fail-transient`
 * (the provider is overloaded or down) or `fail-quota`. Time is the fake clock. What is measured is
 * the ceiling of attempts: how many times the client is launched before the daemon stops asking, and
 * that the waits between them are the ones of `resume.transient_backoff`, not a tight loop.
 */

const MINUTE = 60_000;
/**
 * `resume.transient_backoff` of these tests, in ms. The values are odd on purpose: the services of
 * the daemon sleep on the same clock (a poll every 10 minutes, say), and an unusual number is what
 * tells the backoff of the attempt apart from them in the record of sleeps.
 */
const BACKOFF_MS = [31_000, 121_000, 601_000] as const;
const BACKOFF_YAML = 'transient_backoff: [31s, 121s, 601s]';
/** A demand limit above the whole backoff, so the ceiling measured is the one of `resume.*`. */
const LONG_DEMAND = 'limits:\n  demand_timeout: 2h\n';
const resumeKeys = (extra = ''): string => `${LONG_DEMAND}resume:\n  ${BACKOFF_YAML}\n${extra}`;

const POLL_MS = 5;
const CAP_MS = 120_000;

/** Polls a condition of the log; each lap is a poll, no window of time decides the result. */
async function until(
  description: string,
  condition: () => Promise<boolean> | boolean,
): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > CAP_MS) throw new Error(`gave up waiting for: ${description}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}

const count = async (rig: ExecutorRig, type: string): Promise<number> =>
  eventsOf(await rig.events(), type).length;

/** How many backoff sleeps the attempt armed so far. */
const backoffsArmed = (rig: ExecutorRig): number =>
  (rig.clock as RecordingClock).requested.filter((ms) =>
    (BACKOFF_MS as readonly number[]).includes(ms),
  ).length;

/**
 * Runs an attempt to its end, moving the fake clock only when the attempt is waiting for it: the
 * N-th backoff is armed (its sleep is on the clock), and the clock goes forward by exactly that
 * step. Nothing here waits for a number of milliseconds, and the clock never moves while a client
 * is being launched, so the demand limit is not eaten by the driver.
 */
async function drive(rig: ExecutorRig, run: Promise<AttemptOutcome>): Promise<AttemptOutcome> {
  const state = { ended: false };
  const outcome = run.finally(() => {
    state.ended = true;
  });
  for (let armed = 1; ; armed += 1) {
    await until(
      `backoff ${String(armed)} or the end`,
      () => state.ended || backoffsArmed(rig) >= armed,
    );
    if (state.ended) break;
    const step = BACKOFF_MS[Math.min(armed - 1, BACKOFF_MS.length - 1)] ?? MINUTE;
    await rig.clock.advance(step);
  }
  return outcome;
}

/** `resume.stuck.same_error_times`: high enough that the same error never ends the loop first. */
const NEVER_THE_SAME = 'stuck:\n    same_error_times: 20\n';
const indent = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? line : `  ${line}`))
    .join('\n');

/** The gaps between the interruption of a launch and the next launch, in order. */
function gaps(events: Awaited<ReturnType<ExecutorRig['events']>>): number[] {
  const interrupted = eventsOf(events, 'session.interrupted');
  const opened = eventsOf(events, 'session.opened');
  return opened
    .slice(1)
    .map((event, index) => event.timestamp - (interrupted[index]?.timestamp ?? event.timestamp));
}

describe('chaos B: the provider that is down (through the client)', () => {
  it('fail-transient: with the clock frozen the client is launched once; the backoff holds it', async () => {
    await withExecutorRig({ config: resumeKeys(), script: 'fail-transient' }, async (rig) => {
      const run = rig.attempt('anything');
      await until(
        'the first interruption',
        async () => (await count(rig, 'session.interrupted')) >= 1,
      );
      // The attempt is in its backoff: yielding to the event loop many times launches nothing.
      for (let lap = 0; lap < 200; lap += 1) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      expect(await count(rig, 'session.opened')).toBe(1);
      expect(backoffsArmed(rig)).toBe(1);
      const outcome = await drive(rig, run);
      expect(outcome.state).toBe('interrupted');
    });
  });

  it('fail-transient: the same error three times is a stuck client, and the baton is due', async () => {
    await withExecutorRig({ config: resumeKeys(), script: 'fail-transient' }, async (rig) => {
      const outcome = await drive(rig, rig.attempt('anything'));
      // The default ceiling: resume.stuck.same_error_times (3) comes before resume.max_resumes (5).
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'stuck',
        needsDecision: true,
        resumes: 2,
        decision: { action: 'handoff', differentExecutor: true },
      });
      expect(outcome.handoffWait?.reason).toBe('no_other_executor');
      const events = await rig.events();
      expect(eventsOf(events, 'session.opened')).toHaveLength(3);
      // Each launch waited at least the step of the backoff it was given (31s, then 121s).
      const waited = gaps(events);
      expect(waited).toHaveLength(2);
      expect(waited[0]).toBeGreaterThanOrEqual(31_000);
      expect(waited[1]).toBeGreaterThanOrEqual(121_000);
      expect(eventsOf(events, 'session.processes_left')).toHaveLength(0);
      expect(aliveEntries(rig.census())).toEqual([]);
    });
  });

  it.each([2, 4])(
    'fail-transient: same_error_times %i is the ceiling of launches',
    async (times) => {
      await withExecutorRig(
        {
          config: resumeKeys(`  stuck:\n    same_error_times: ${String(times)}\n`),
          script: 'fail-transient',
        },
        async (rig) => {
          const outcome = await drive(rig, rig.attempt('anything'));
          expect(outcome).toMatchObject({ state: 'interrupted', cause: 'stuck' });
          expect(await count(rig, 'session.opened')).toBe(times);
          expect(aliveEntries(rig.census())).toEqual([]);
        },
      );
    },
  );

  it('fail-transient: when no error repeats, one launch plus resume.max_resumes, then the Director decides', async () => {
    await withExecutorRig(
      { config: resumeKeys(indent(NEVER_THE_SAME)), script: 'fail-transient' },
      async (rig) => {
        const outcome = await drive(rig, rig.attempt('anything'));
        expect(outcome).toMatchObject({
          state: 'interrupted',
          cause: 'transient',
          needsDecision: true,
          resumes: 5,
          decision: { action: 'director_judgment' },
        });
        const events = await rig.events();
        // 1 launch + 5 resumes (the default of resume.max_resumes): the loop is bounded.
        expect(eventsOf(events, 'session.opened')).toHaveLength(6);
        // The backoff steps are 31s, 121s, 601s, and the last one repeats.
        const steps = [31_000, 121_000, 601_000, 601_000, 601_000];
        const waited = gaps(events);
        expect(waited).toHaveLength(5);
        steps.forEach((step, index) => {
          expect(waited[index]).toBeGreaterThanOrEqual(step);
        });
        expect(aliveEntries(rig.census())).toEqual([]);
      },
    );
  });

  it.each([1, 3])(
    'fail-transient: resume.max_resumes %i moves the ceiling with it',
    async (max) => {
      await withExecutorRig(
        {
          config: resumeKeys(`  max_resumes: ${String(max)}\n${indent(NEVER_THE_SAME)}`),
          script: 'fail-transient',
        },
        async (rig) => {
          const outcome = await drive(rig, rig.attempt('anything'));
          expect(outcome).toMatchObject({
            state: 'interrupted',
            cause: 'transient',
            resumes: max,
            decision: { action: 'director_judgment' },
          });
          expect(await count(rig, 'session.opened')).toBe(max + 1);
          expect(aliveEntries(rig.census())).toEqual([]);
        },
      );
    },
  );

  it('fail-transient with transient_exhausted handoff: the backoff steps are the ceiling', async () => {
    await withExecutorRig(
      {
        config: resumeKeys(`  transient_exhausted: handoff\n${indent(NEVER_THE_SAME)}`),
        script: 'fail-transient',
      },
      async (rig) => {
        const outcome = await drive(rig, rig.attempt('anything'));
        // 3 steps in transient_backoff: 1 launch + 3 resumes, then the baton, and nobody to take it.
        expect(await count(rig, 'session.opened')).toBe(4);
        expect(outcome).toMatchObject({
          state: 'interrupted',
          cause: 'transient',
          decision: { action: 'handoff' },
        });
        expect(outcome.handoffWait?.reason).toBe('no_other_executor');
        expect(aliveEntries(rig.census())).toEqual([]);
      },
    );
  });

  it('a provider that comes back: the resume after the backoff finishes the attempt', async () => {
    // The first prompt fails; the resume sends `resume.continue_prompt`, which names no script, so
    // the fake agent answers it normally: the outage ended between the two.
    await withExecutorRig({ config: resumeKeys() }, async (rig) => {
      const outcome = await drive(rig, rig.attempt(scriptPrompt('fail-transient', {})));
      expect(outcome.state).not.toBe('interrupted');
      expect(await count(rig, 'session.opened')).toBe(2);
      expect(aliveEntries(rig.census())).toEqual([]);
    });
  });
});

/** `resume.quota_wait_grace` of the quota tests: odd, so its sleep is told apart from the services'. */
const GRACE_MS = 13_000;
const QUOTA_YAML = `${LONG_DEMAND}resume:\n  quota_wait_grace: 13s\n`;
/** The reset that the first sleep of a wait is made of: the reset, 10 minutes ahead, plus the grace. */
const FIRST_WAIT_MS = 10 * MINUTE + GRACE_MS;

const resetIn = (minutes: number): string =>
  new Date(new FakeClock().now() + minutes * MINUTE).toISOString();

const quotaScript = (resetsAt: string): string => `fail-quota ${JSON.stringify({ resetsAt })}`;

describe('chaos B: the quota that is out (through the client)', () => {
  it('fail-quota with the default (next): one launch, the baton is due, no wait, no attempt spent', async () => {
    await withExecutorRig({ config: QUOTA_YAML, script: quotaScript(resetIn(10)) }, async (rig) => {
      const outcome = await rig.attempt('anything');
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'quota_exhausted',
        resumes: 0,
        needsDecision: true,
        countsAsAttempt: false,
        decision: { action: 'handoff', differentExecutor: false },
      });
      expect(outcome.handoffWait?.reason).toBe('no_other_executor');
      const events = await rig.events();
      expect(eventsOf(events, 'session.opened')).toHaveLength(1);
      expect(eventsOf(events, 'attempt.reset_wait_started')).toHaveLength(0);
      expect(eventsOf(events, 'quota.exhausted')).toHaveLength(1);
      expect(aliveEntries(rig.census())).toEqual([]);
    });
  });

  it('fail-quota with a reset past resume.quota_wait_max: no wait, the baton at once', async () => {
    await withExecutorRig(
      { config: QUOTA_YAML, script: quotaScript(resetIn(120)) },
      async (rig) => {
        const outcome = await rig.attempt('anything', { whenExhausted: 'wait' });
        expect(outcome).toMatchObject({
          state: 'interrupted',
          cause: 'quota_exhausted',
          decision: {
            action: 'handoff',
            reason: 'the quota comes back later than resume.quota_wait_max',
          },
        });
        const events = await rig.events();
        expect(eventsOf(events, 'session.opened')).toHaveLength(1);
        expect(eventsOf(events, 'attempt.reset_wait_started')).toHaveLength(0);
      },
    );
  });

  it('fail-quota that waits (whenExhausted wait): one wait on the clock, one resume, then the baton', async () => {
    await withExecutorRig({ config: QUOTA_YAML, script: quotaScript(resetIn(10)) }, async (rig) => {
      let ended = false;
      const run = rig.attempt('anything', { whenExhausted: 'wait' }).finally(() => {
        ended = true;
      });
      const armed = (): number =>
        (rig.clock as RecordingClock).requested.filter(
          (ms) => ms === FIRST_WAIT_MS || ms === GRACE_MS,
        ).length;
      // The gate: the sleep of the wait is on the clock. Before the clock moves, nothing resumes.
      await until('the wait is armed', () => ended || armed() >= 1);
      expect(await count(rig, 'session.opened')).toBe(1);
      expect(await count(rig, 'attempt.reset_wait_started')).toBe(1);
      await rig.clock.advance(FIRST_WAIT_MS);
      const outcome = await run;
      // The reset time went by, the provider still refuses: the second quota error carries no
      // usable reset, so the policy passes the baton instead of waiting again. Two launches, in all.
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'quota_exhausted',
        resumes: 1,
        needsDecision: true,
        countsAsAttempt: false,
        decision: { action: 'handoff' },
      });
      const events = await rig.events();
      expect(eventsOf(events, 'session.opened')).toHaveLength(2);
      expect(eventsOf(events, 'attempt.reset_wait_started')).toHaveLength(1);
      expect(eventsOf(events, 'attempt.reset_wait_ended')).toHaveLength(1);
      expect(aliveEntries(rig.census())).toEqual([]);
    });
  });
});

/**
 * The provider as an HTTP origin that is down, on the loopback (`loopback-server.ts`): the quota
 * probe of MiniMax is the daemon's caller of an external API. Nothing leaves the machine, and the
 * ceiling is counted on the server: how many requests reach it.
 */
describe('chaos B: the provider that is down (HTTP, on the loopback)', () => {
  const REF: ProfileRef = { client: 'opencode', profile: 'mm' };
  const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
  const OK_BODY = JSON.stringify({
    base_resp: { status_code: 0 },
    data: {
      current_interval_total_count: 100,
      current_interval_usage_count: 40,
      current_interval_reset_time: new Date(T0 + 3 * 60 * MINUTE).toISOString(),
    },
  });
  const POLL_MS = 5 * MINUTE + 123;

  const servers: LoopbackServer[] = [];
  const services: QuotaService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.stop()));
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function origin(options: LoopbackOptions = {}): Promise<LoopbackServer> {
    const server = await startLoopbackServer({ body: OK_BODY, ...options });
    servers.push(server);
    return server;
  }

  function probeOf(server: LoopbackServer, timeoutMs = 10_000): MiniMaxQuotaProbe {
    return new MiniMaxQuotaProbe({
      baseUrl: server.url,
      network: { allowHosts: ['127.0.0.1'], timeoutMs },
      usageCountMeans: 'remaining',
      keyOf: () => Promise.resolve('sk-test-not-a-real-key'),
      clock: new FakeClock(T0),
      logger: createSilentLogger(),
    });
  }

  const reasonOf = async (read: Promise<unknown>): Promise<string> => {
    try {
      await read;
    } catch (error) {
      if (error instanceof MiniMaxProbeError) return error.reason;
      throw error;
    }
    return 'read';
  };

  it('refuse: nothing listens, the read fails as unreachable, and the same address comes back', async () => {
    const server = await origin({ mode: 'refuse' });
    const probe = probeOf(server);
    expect(await reasonOf(probe.read(REF))).toBe('unreachable');
    expect(server.requests()).toHaveLength(0);
    await server.setMode('ok');
    expect(await reasonOf(probe.read(REF))).toBe('read');
    expect(server.requests()).toHaveLength(1);
  });

  it('503: each read costs exactly one request, and a Retry-After is not obeyed by the probe', async () => {
    const server = await origin({ mode: '503', retryAfterSeconds: 120 });
    const probe = probeOf(server);
    for (let read = 1; read <= 3; read += 1) {
      expect(await reasonOf(probe.read(REF))).toBe('http_error');
      // No inner retry: the requests are the reads.
      expect(server.requests()).toHaveLength(read);
    }
  });

  it('cut: an answer that ends before its Content-Length is unreachable, not a reading', async () => {
    const server = await origin({ mode: 'cut' });
    expect(await reasonOf(probeOf(server).read(REF))).toBe('unreachable');
    expect(server.requests()).toHaveLength(1);
  });

  it('slow: a provider that never answers ends at the timeout of the daemon, and frees the connection', async () => {
    const server = await origin({ mode: 'slow' });
    // The origin never answers, so the result is the timeout whatever the speed of the machine.
    expect(await reasonOf(probeOf(server, 250).read(REF))).toBe('timeout');
    await until('the held request is dropped', () => server.held() === 0);
    expect(server.requests().map((request) => request.outcome)).toEqual(['slow']);
  });

  it('flap: the provider falls and comes back by request, and the probe follows without state', async () => {
    const server = await origin({ mode: 'flap' });
    const probe = probeOf(server);
    // The default pattern: connection reset, 503, ok.
    expect(await reasonOf(probe.read(REF))).toBe('unreachable');
    expect(await reasonOf(probe.read(REF))).toBe('http_error');
    expect(await reasonOf(probe.read(REF))).toBe('read');
    expect(server.requests().map((request) => request.outcome)).toEqual(['reset', '503', 'ok']);
  });

  describe('through the poller of the quota service (the clock decides how often it asks)', () => {
    async function poller(server: LoopbackServer): Promise<{
      readonly service: QuotaService;
      readonly clock: RecordingClock;
    }> {
      const clock = new RecordingClock(T0);
      const service = new QuotaService({
        store: new InMemoryStore({ clock }),
        clock,
        settings: {
          nearLimitAt: 0.8,
          staleAfterMs: 10 * MINUTE,
          delivery: 'poll',
          pollEveryMs: POLL_MS,
        },
        logger: createSilentLogger(),
      });
      service.addProbe('opencode', probeOf(server));
      services.push(service);
      service.track('opencode/mm');
      await service.start();
      return { service, clock };
    }

    const pollsArmed = (clock: RecordingClock): number =>
      clock.requested.filter((ms) => ms === POLL_MS).length;

    it('503 all the time: the first read is at the start, then one per period and none while the clock is frozen', async () => {
      const server = await origin({ mode: '503' });
      const { clock } = await poller(server);
      await until(
        'the first read and the first poll',
        () => server.requests().length >= 1 && pollsArmed(clock) >= 1,
      );
      for (let lap = 0; lap < 200; lap += 1) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      // The clock is frozen: the read of the start is the only request, whatever the real time.
      expect(server.requests()).toHaveLength(1);
      for (let period = 1; period <= 4; period += 1) {
        await clock.advance(POLL_MS);
        // The poll of this period reached the server and the next one is armed again.
        await until(
          `period ${String(period)} asked and re-armed`,
          () => server.requests().length >= period + 1 && pollsArmed(clock) >= period + 1,
        );
        expect(server.requests()).toHaveLength(period + 1);
      }
    });

    it('a provider that comes back is read at the next period, and the profile gets a state', async () => {
      const server = await origin({ mode: '503' });
      const { service, clock } = await poller(server);
      await until(
        'the first read and the first poll',
        () => server.requests().length >= 1 && pollsArmed(clock) >= 1,
      );
      expect((await service.statusOf('opencode/mm')).state).toBe('unknown');
      await server.setMode('ok');
      await clock.advance(POLL_MS);
      await until(
        'the poll that reads',
        () => server.requests().length >= 2 && pollsArmed(clock) >= 2,
      );
      const status = await service.statusOf('opencode/mm');
      expect(server.requests().map((request) => request.outcome)).toEqual(['503', 'ok']);
      expect(status.state).not.toBe('unknown');
    });
  });
});
