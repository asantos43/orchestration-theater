// SPDX-License-Identifier: MPL-2.0
import { INTERRUPTION_CAUSES, type InterruptionCause } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import {
  decideInterruption,
  INTERRUPTION_ACTIONS,
  type InterruptionAction,
  type InterruptionFacts,
  type InterruptionRules,
} from './interruption-policy.js';

const NOW = 1_000_000;
const MINUTE = 60_000;

const RULES: InterruptionRules = {
  maxResumes: 5,
  quotaWaitMaxMs: 30 * MINUTE,
  transientBackoffMs: [30_000, 120_000, 600_000],
  transientExhausted: 'last',
  clientCrashCounts: 'repeat',
  stuckSameErrorTimes: 3,
};

function factsOf(
  cause: InterruptionCause,
  extra: Partial<InterruptionFacts> = {},
): InterruptionFacts {
  return {
    cause,
    now: NOW,
    resetsAt: null,
    whenExhausted: 'next',
    inFlight: 'handoff',
    reloadable: true,
    free: false,
    resumes: 0,
    repeated: 1,
    priorCrashes: 0,
    ...extra,
  };
}

interface Row {
  readonly name: string;
  readonly facts: InterruptionFacts;
  readonly rules?: Partial<InterruptionRules>;
  readonly expect: {
    readonly cause?: InterruptionCause;
    readonly action: InterruptionAction;
    readonly form: 'native' | 'handoff' | null;
    readonly counts: boolean;
    readonly delayMs?: number;
    readonly differentExecutor?: boolean;
  };
}

/** One group of rows per cause of the table in architecture 5.16. */
const TABLE: readonly Row[] = [
  // ---- quota_exhausted ----
  {
    name: 'quota: the role moves to the next Executor (when_exhausted: next)',
    facts: factsOf('quota_exhausted', { resetsAt: NOW + MINUTE }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'quota: waits for a reset nearer than quota_wait_max (when_exhausted: wait)',
    facts: factsOf('quota_exhausted', { whenExhausted: 'wait', resetsAt: NOW + 10 * MINUTE }),
    expect: { action: 'wait_for_reset', form: 'native', counts: false },
  },
  {
    name: 'quota: a reset exactly at quota_wait_max is still waited for',
    facts: factsOf('quota_exhausted', { whenExhausted: 'wait', resetsAt: NOW + 30 * MINUTE }),
    expect: { action: 'wait_for_reset', form: 'native', counts: false },
  },
  {
    name: 'quota: a reset beyond quota_wait_max is a handoff',
    facts: factsOf('quota_exhausted', { whenExhausted: 'wait', resetsAt: NOW + 31 * MINUTE }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'quota: no source says when it comes back, so it is a handoff',
    facts: factsOf('quota_exhausted', { whenExhausted: 'wait', resetsAt: null }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'quota: a reset already in the past is no wait',
    facts: factsOf('quota_exhausted', { whenExhausted: 'wait', resetsAt: NOW - MINUTE }),
    expect: { action: 'wait_for_reset', form: 'native', counts: false },
  },
  {
    name: 'quota: the conversation cannot be reloaded, so waiting is pointless',
    facts: factsOf('quota_exhausted', {
      whenExhausted: 'wait',
      resetsAt: NOW + MINUTE,
      reloadable: false,
    }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'quota: a smaller quota_wait_max (agile preset) turns the same reset into a handoff',
    facts: factsOf('quota_exhausted', { whenExhausted: 'wait', resetsAt: NOW + 20 * MINUTE }),
    rules: { quotaWaitMaxMs: 10 * MINUTE },
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  // ---- spend_cap ----
  {
    name: 'spend cap, in_flight handoff: a handoff',
    facts: factsOf('spend_cap', { inFlight: 'handoff' }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'spend cap, on_exceeded wait: a cap back within quota_wait_max is waited for (P19)',
    facts: factsOf('spend_cap', { waitForCap: true, resetsAt: NOW + 10 * MINUTE }),
    expect: { action: 'wait_for_reset', form: 'native', counts: false },
  },
  {
    name: 'spend cap, on_exceeded wait: a cap back after quota_wait_max is a handoff',
    facts: factsOf('spend_cap', { waitForCap: true, resetsAt: NOW + 31 * MINUTE }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'spend cap, on_exceeded wait: no date for the cap is a handoff',
    facts: factsOf('spend_cap', { waitForCap: true, resetsAt: null }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'spend cap, on_exceeded wait: a conversation that cannot be reloaded is a handoff',
    facts: factsOf('spend_cap', {
      waitForCap: true,
      resetsAt: NOW + MINUTE,
      reloadable: false,
    }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'spend cap, on_exceeded skip: a near reset changes nothing',
    facts: factsOf('spend_cap', { waitForCap: false, resetsAt: NOW + MINUTE }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'spend cap, in_flight finish: on_exceeded wait does not override the in-flight mode',
    facts: factsOf('spend_cap', { inFlight: 'finish', waitForCap: true, resetsAt: NOW + MINUTE }),
    expect: { action: 'finish_session', form: null, counts: false },
  },
  {
    name: 'spend cap, in_flight finish: the session ends by itself',
    facts: factsOf('spend_cap', { inFlight: 'finish' }),
    expect: { action: 'finish_session', form: null, counts: false },
  },
  {
    name: 'spend cap, in_flight stop: the Producer is asked',
    facts: factsOf('spend_cap', { inFlight: 'stop' }),
    expect: { action: 'ask_producer', form: null, counts: false },
  },
  // ---- transient ----
  {
    name: 'transient: resumes in place after the first backoff step',
    facts: factsOf('transient', { resumes: 0 }),
    expect: { action: 'resume_native', form: 'native', counts: false, delayMs: 30_000 },
  },
  {
    name: 'transient: the backoff grows with each resume',
    facts: factsOf('transient', { resumes: 1 }),
    expect: { action: 'resume_native', form: 'native', counts: false, delayMs: 120_000 },
  },
  {
    name: 'transient: past the list the last step repeats (transient_exhausted: last)',
    facts: factsOf('transient', { resumes: 4 }),
    expect: { action: 'resume_native', form: 'native', counts: false, delayMs: 600_000 },
  },
  {
    name: 'transient: past the list it is a handoff (transient_exhausted: handoff)',
    facts: factsOf('transient', { resumes: 3 }),
    rules: { transientExhausted: 'handoff' },
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'transient: still inside the list with transient_exhausted: handoff',
    facts: factsOf('transient', { resumes: 2 }),
    rules: { transientExhausted: 'handoff' },
    expect: { action: 'resume_native', form: 'native', counts: false, delayMs: 600_000 },
  },
  {
    name: 'transient: an empty backoff list resumes at once',
    facts: factsOf('transient', { resumes: 2 }),
    rules: { transientBackoffMs: [] },
    expect: { action: 'resume_native', form: 'native', counts: false, delayMs: 0 },
  },
  {
    name: 'transient: the conversation cannot be reloaded, so a handoff',
    facts: factsOf('transient', { reloadable: false }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  // ---- client_crash ----
  {
    name: 'client crash: the first drop resumes in place and costs no attempt',
    facts: factsOf('client_crash'),
    expect: { action: 'resume_native', form: 'native', counts: false, delayMs: 0 },
  },
  {
    name: 'client crash: a repeated drop resumes in place and costs an attempt (repeat)',
    facts: factsOf('client_crash', { priorCrashes: 1 }),
    expect: { action: 'resume_native', form: 'native', counts: true },
  },
  {
    name: 'client crash: never counts, whatever the repetition (client_crash_counts: never)',
    facts: factsOf('client_crash', { priorCrashes: 4 }),
    rules: { clientCrashCounts: 'never' },
    expect: { action: 'resume_native', form: 'native', counts: false },
  },
  {
    name: 'client crash: always counts, the first one too (client_crash_counts: always)',
    facts: factsOf('client_crash'),
    rules: { clientCrashCounts: 'always' },
    expect: { action: 'resume_native', form: 'native', counts: true },
  },
  {
    name: 'client crash: the drop of a cancel on a shared process is free and never counts',
    facts: factsOf('client_crash', { free: true, priorCrashes: 3 }),
    rules: { clientCrashCounts: 'always' },
    expect: { action: 'resume_native', form: 'native', counts: false },
  },
  {
    name: 'client crash: the client lost the conversation, so a handoff',
    facts: factsOf('client_crash', { reloadable: false }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'client crash: a handoff after a repeated drop still counts',
    facts: factsOf('client_crash', { reloadable: false, priorCrashes: 1 }),
    expect: { action: 'handoff', form: 'handoff', counts: true },
  },
  // ---- daemon_restart ----
  {
    name: 'daemon restart: the conversation is there, so it resumes in place',
    facts: factsOf('daemon_restart'),
    expect: { action: 'resume_native', form: 'native', counts: false },
  },
  {
    name: 'daemon restart: the files are gone, so a handoff',
    facts: factsOf('daemon_restart', { reloadable: false }),
    expect: { action: 'handoff', form: 'handoff', counts: false },
  },
  {
    name: 'daemon restart: never limited by max_resumes',
    facts: factsOf('daemon_restart', { resumes: 50, repeated: 50 }),
    expect: { action: 'resume_native', form: 'native', counts: false },
  },
  // ---- timeout ----
  {
    name: 'timeout: the Director judges the partial result and it costs an attempt',
    facts: factsOf('timeout'),
    expect: { action: 'director_judgment', form: 'handoff', counts: true },
  },
  // ---- stuck ----
  {
    name: 'stuck: a handoff to a different Executor, and it costs an attempt',
    facts: factsOf('stuck'),
    expect: {
      action: 'handoff',
      form: 'handoff',
      counts: true,
      differentExecutor: true,
    },
  },
  // ---- refusal ----
  {
    name: 'refusal: the Director decides (reformulate, change Executor or ask)',
    facts: factsOf('refusal'),
    expect: { action: 'director_judgment', form: null, counts: true },
  },
  // ---- permission ----
  {
    name: 'permission: the Director decides',
    facts: factsOf('permission'),
    expect: { action: 'director_judgment', form: null, counts: true },
  },
  // ---- max_resumes ----
  {
    name: 'max_resumes: a transient error past the limit goes to the Director',
    facts: factsOf('transient', { resumes: 5 }),
    expect: { action: 'director_judgment', form: null, counts: false },
  },
  {
    name: 'max_resumes: a quota past the limit goes to the Director',
    facts: factsOf('quota_exhausted', { resumes: 5, resetsAt: NOW + MINUTE }),
    expect: { action: 'director_judgment', form: null, counts: false },
  },
  {
    name: 'max_resumes: a client crash past the limit counts by the crash rule',
    facts: factsOf('client_crash', { resumes: 5, priorCrashes: 2 }),
    expect: { action: 'director_judgment', form: null, counts: true },
  },
  {
    name: 'max_resumes: one resume left is still a resume',
    facts: factsOf('transient', { resumes: 4 }),
    expect: { action: 'resume_native', form: 'native', counts: false, delayMs: 600_000 },
  },
  {
    name: 'max_resumes: a free drop does not meet the limit',
    facts: factsOf('client_crash', { resumes: 5, free: true }),
    expect: { action: 'resume_native', form: 'native', counts: false },
  },
  {
    name: 'max_resumes: 0 means the first interruption already goes to the Director',
    facts: factsOf('transient'),
    rules: { maxResumes: 0 },
    expect: { action: 'director_judgment', form: null, counts: false },
  },
  // ---- the same interruption again and again ----
  {
    name: 'repeated: the same transient error three times is a stuck agent',
    facts: factsOf('transient', { repeated: 3 }),
    expect: {
      cause: 'stuck',
      action: 'handoff',
      form: 'handoff',
      counts: true,
      differentExecutor: true,
    },
  },
  {
    name: 'repeated: twice is not yet stuck',
    facts: factsOf('transient', { repeated: 2 }),
    expect: { action: 'resume_native', form: 'native', counts: false, delayMs: 30_000 },
  },
  {
    name: 'repeated: stuck.same_error_times 2 (agile preset) makes the second one stuck',
    facts: factsOf('client_crash', { repeated: 2 }),
    rules: { stuckSameErrorTimes: 2 },
    expect: {
      cause: 'stuck',
      action: 'handoff',
      form: 'handoff',
      counts: true,
      differentExecutor: true,
    },
  },
  {
    name: 'repeated: a free drop is never counted as a repetition',
    facts: factsOf('client_crash', { repeated: 9, free: true }),
    expect: { action: 'resume_native', form: 'native', counts: false },
  },
  {
    name: 'repeated: a quota that is a handoff anyway stays a handoff',
    facts: factsOf('quota_exhausted', { repeated: 9 }),
    expect: { cause: 'quota_exhausted', action: 'handoff', form: 'handoff', counts: false },
  },
];

describe('decideInterruption, the table of architecture 5.16', () => {
  it.each(TABLE)('$name', (row) => {
    const decision = decideInterruption(row.facts, { ...RULES, ...row.rules });
    expect(decision).toMatchObject({
      cause: row.expect.cause ?? row.facts.cause,
      action: row.expect.action,
      form: row.expect.form,
      countsAsAttempt: row.expect.counts,
      delayMs: row.expect.delayMs ?? 0,
      differentExecutor: row.expect.differentExecutor ?? false,
    });
    expect(decision.reason).not.toBe('');
  });

  it('has at least one row for every cause of the table', () => {
    const covered = new Set(TABLE.map((row) => row.facts.cause));
    for (const cause of INTERRUPTION_CAUSES) expect(covered, cause).toContain(cause);
  });

  it('reaches every action of the vocabulary with some row', () => {
    const reached = new Set(
      TABLE.map((row) => decideInterruption(row.facts, { ...RULES, ...row.rules }).action),
    );
    for (const action of INTERRUPTION_ACTIONS) expect(reached, action).toContain(action);
  });

  it('carries the reset time of a quota into the decision', () => {
    const decision = decideInterruption(
      factsOf('quota_exhausted', { whenExhausted: 'wait', resetsAt: NOW + MINUTE }),
      RULES,
    );
    expect(decision.resetsAt).toBe(NOW + MINUTE);
  });

  it('is pure: the same facts always give the same decision', () => {
    const facts = factsOf('transient', { resumes: 1, repeated: 2 });
    expect(decideInterruption(facts, RULES)).toEqual(decideInterruption(facts, RULES));
  });

  it('hands off whenever the quota runs out, with no predicate on the Executor (N126)', () => {
    const decision = decideInterruption(
      factsOf('quota_exhausted', { whenExhausted: 'next', resetsAt: NOW + 5 * MINUTE }),
      RULES,
    );
    expect(decision.action).toBe('handoff');
  });
});
