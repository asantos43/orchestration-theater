// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the setup screen only (excluded from the build of the package).
import { ApiRequestError } from '@otheater/client';
import type {
  SetupDetectedProfile,
  SetupOverview,
  SetupPlan,
  SetupPrompt,
  SetupRunView,
  SetupStepId,
  SetupStepSubmission,
} from '@otheater/protocol';
import type { SetupApi, SetupFlow } from './api.js';

/**
 * A setup API in memory that behaves as the daemon of P4 does where the screen can tell: one run in
 * progress per flow, a second start is a conflict, back on the first step is refused, a submission
 * for another step is a conflict, and nothing is "written" before confirm. It records what the
 * screen asked, so a test says which commands went and in which order.
 */

export const FLOW_STEPS: Readonly<Record<SetupFlow, readonly SetupStepId[]>> = {
  first_run: ['detect', 'preset', 'executors', 'review'],
  add_account: ['account', 'executors', 'review'],
  change_preset: ['preset', 'review'],
};

export function profileOf(
  profileId: string,
  options: Partial<SetupDetectedProfile> = {},
): SetupDetectedProfile {
  const [client = 'claude-code'] = profileId.split('/');
  return {
    profileId,
    client,
    kind: 'token_plan',
    state: 'active',
    hasSecret: false,
    login: 'logged_in',
    usable: true,
    ...options,
  };
}

export function requestError(code: string, status: number, message: string): ApiRequestError {
  return new ApiRequestError({ status, body: { code, message } } as never, {
    routeId: 'setup',
  });
}

export interface FakeSetupOptions {
  readonly profiles?: readonly SetupDetectedProfile[];
  readonly firstRunNeeded?: boolean;
  readonly current?: 'quality' | 'balanced' | 'economical' | null;
}

export class FakeSetupApi implements SetupApi {
  /** What the screen asked of the daemon, in order (`submit:detect`, `back`, `confirm`...). */
  readonly calls: string[] = [];
  /** What was submitted at each step of the runs, in order. */
  readonly submissions: SetupStepSubmission[] = [];
  /** The runs in progress, by flow. */
  readonly active = new Map<SetupFlow, { run: SetupRunView; inputs: Map<SetupStepId, unknown> }>();
  /** Every confirmed result: the "configuration" the daemon would have written. */
  readonly written: SetupPlan[] = [];
  profiles: SetupDetectedProfile[];
  firstRunNeeded: boolean;
  current: 'quality' | 'balanced' | 'economical' | null;
  /** The next command fails with this error. */
  failNext: Error | undefined;
  /** An `overview` that never answers (a daemon that hangs). */
  hang = false;
  #next = 1;

  constructor(options: FakeSetupOptions = {}) {
    this.profiles = [...(options.profiles ?? [])];
    this.firstRunNeeded = options.firstRunNeeded ?? true;
    this.current = options.current ?? null;
  }

  overview(): Promise<SetupOverview> {
    this.calls.push('overview');
    if (this.hang) return new Promise<never>(() => undefined);
    return this.#take(() => ({
      firstRunNeeded: this.firstRunNeeded,
      flows: (Object.keys(FLOW_STEPS) as SetupFlow[]).map((flow) => ({
        flow,
        steps: [...FLOW_STEPS[flow]],
        active: this.active.get(flow)?.run ?? null,
        lastFinished: null,
      })),
    }));
  }

  start(flow: SetupFlow): Promise<SetupRunView> {
    this.calls.push(`start:${flow}`);
    return this.#take(() => {
      if (this.active.has(flow)) {
        throw requestError('conflict', 409, `A run of ${flow} is already in progress.`);
      }
      const steps = FLOW_STEPS[flow];
      const first = steps[0] ?? 'review';
      const run = this.#view(flow, steps, first, 'active', null);
      this.active.set(flow, { run, inputs: new Map() });
      return run;
    });
  }

  submit(runId: string, body: SetupStepSubmission): Promise<SetupRunView> {
    this.calls.push(`submit:${body.step}`);
    this.submissions.push(body);
    return this.#take(() => {
      const entry = this.#find(runId);
      if (entry.run.step !== body.step) {
        throw requestError('conflict', 409, `The run is at ${entry.run.step}, not ${body.step}.`);
      }
      if (body.step === 'executors') {
        const bad = body.input.executors?.find((executor) => executor.model === 'bad-model');
        if (bad !== undefined) {
          throw requestError('invalid_input', 400, `The model ${bad.model} is not in the catalog.`);
        }
      }
      entry.inputs.set(body.step, body.input);
      const steps = entry.run.steps;
      const next = steps[steps.indexOf(entry.run.step) + 1] ?? 'review';
      entry.run = this.#view(entry.run.flow, steps, next, 'active', null, entry.run.id, entry);
      return entry.run;
    });
  }

  back(runId: string): Promise<SetupRunView> {
    this.calls.push('back');
    return this.#take(() => {
      const entry = this.#find(runId);
      const steps = entry.run.steps;
      const at = steps.indexOf(entry.run.step);
      if (at <= 0) throw requestError('invalid_input', 400, 'There is no step before the first.');
      const previous = steps[at - 1] ?? 'review';
      entry.inputs.delete(previous);
      entry.run = this.#view(entry.run.flow, steps, previous, 'active', null, entry.run.id, entry);
      return entry.run;
    });
  }

  confirm(runId: string): Promise<SetupRunView> {
    this.calls.push('confirm');
    return this.#take(() => {
      const entry = this.#find(runId);
      if (entry.run.step !== 'review') {
        throw requestError('conflict', 409, 'The run is not at the review.');
      }
      const plan = this.#plan(entry.run.flow, entry.inputs);
      this.written.push(plan);
      const done = this.#view(
        entry.run.flow,
        entry.run.steps,
        'review',
        'confirmed',
        {
          preset: plan.preset,
          executors: plan.executors.map((executor) => executor.id),
          written: plan.writes,
        },
        entry.run.id,
        entry,
      );
      this.active.delete(entry.run.flow);
      return done;
    });
  }

  cancel(runId: string): Promise<SetupRunView> {
    this.calls.push('cancel');
    return this.#take(() => {
      const entry = this.#find(runId);
      const done = this.#view(
        entry.run.flow,
        entry.run.steps,
        entry.run.step,
        'cancelled',
        null,
        entry.run.id,
        entry,
      );
      this.active.delete(entry.run.flow);
      return done;
    });
  }

  #take<T>(make: () => T): Promise<T> {
    if (this.failNext !== undefined) {
      const error = this.failNext;
      this.failNext = undefined;
      return Promise.reject(error);
    }
    try {
      return Promise.resolve(make());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #find(runId: string): { run: SetupRunView; inputs: Map<SetupStepId, unknown> } {
    for (const entry of this.active.values()) if (entry.run.id === runId) return entry;
    throw requestError('not_found', 404, `No run ${runId}.`);
  }

  #plan(flow: SetupFlow, inputs: Map<SetupStepId, unknown>): SetupPlan {
    const preset =
      (inputs.get('preset') as { preset?: SetupPlan['preset'] } | undefined)?.preset ?? null;
    const executors = (
      (
        inputs.get('executors') as
          { executors?: { profileId: string; model: string }[] } | undefined
      )?.executors ?? []
    ).map((executor) => ({
      id: `${executor.model}@${executor.profileId}`,
      profileId: executor.profileId,
      model: executor.model,
      alias: executor.model,
      effort: null,
      provider: 'fake',
      source: 'registered' as const,
      presetExpand: true,
      local: null,
    }));
    const writes = [
      ...(preset === null ? [] : ['roles.preset']),
      ...executors.map((executor) => `executors.${executor.id}`),
    ];
    return { flow, preset, roles: [], executors, budgets: [], writes, notes: [] };
  }

  #prompt(
    step: SetupStepId,
    entry: { inputs: Map<SetupStepId, unknown> } | undefined,
    flow: SetupFlow,
  ): SetupPrompt {
    switch (step) {
      case 'detect':
        return {
          step,
          clients: [
            { client: 'claude-code', installed: true },
            { client: 'codex', installed: false },
          ],
          profiles: this.profiles,
        };
      case 'account':
        return { step, profiles: this.profiles };
      case 'preset':
        return { step, current: this.current, options: ['quality', 'balanced', 'economical'] };
      case 'executors':
        return {
          step,
          apiProfiles: this.profiles.filter(
            (profile) => profile.kind === 'api' && profile.hasSecret,
          ),
          suggestedBudget: { dailyUsd: 5, monthlyUsd: 50 },
        };
      case 'review':
        return { step, plan: this.#plan(flow, entry?.inputs ?? new Map<SetupStepId, unknown>()) };
    }
  }

  #view(
    flow: SetupFlow,
    steps: readonly SetupStepId[],
    step: SetupStepId,
    state: SetupRunView['state'],
    result: SetupRunView['result'],
    id = `setup_run${String(this.#next++)}`,
    entry?: { inputs: Map<SetupStepId, unknown> },
  ): SetupRunView {
    return {
      id,
      flow,
      state,
      step,
      steps: [...steps],
      done: [],
      prompt: state === 'active' ? this.#prompt(step, entry, flow) : null,
      result,
      createdAt: 0,
      updatedAt: 0,
      finishedAt: state === 'active' ? null : 0,
    };
  }
}
