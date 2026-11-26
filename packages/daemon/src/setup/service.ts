// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  Conflict,
  DEFAULT_ROLE_PRESET,
  InvalidInput,
  NotFound,
  ROLE_PRESET_NAMES,
  parseProfileId,
  SETUP_FLOWS,
  isOTheaterError,
  tryParseExecutorId,
  type Clock,
  type JsonObject,
  type JsonValue,
  type ModelCatalog,
  type ModelInfo,
  type ProfileFact,
  type RolePresetName,
  type SetupFlow,
  type SetupRunRecord,
  type Store,
} from '@otheater/core';
import {
  SETUP_FLOW_STEPS,
  SetupAccountInputSchema,
  SetupDetectInputSchema,
  SetupDoneStepSchema,
  SetupExecutorsInputSchema,
  SetupPresetInputSchema,
  SetupStepSubmissionSchema,
  type DaemonEventPayloads,
  type SetupBudget,
  type SetupDoneStep,
  type SetupExecutor,
  type SetupFlowStatus,
  type SetupModels,
  type SetupNote,
  type SetupOverview,
  type SetupAdapterClient,
  type SetupAdapterInstallResult,
  type SetupRedetectResult,
  type SetupPrompt,
  type SetupResult,
  type SetupRolePlacement,
  type SetupRunView,
  type SetupStepId,
  type SetupStepSubmission,
} from '@otheater/protocol';
import { redactTree, treeAt } from '../api/routes/redact.js';
import { editConfigFile } from '../config-edit.js';
import type { ClientRedetectTrigger } from '../client-redetect.js';
import type { ConfigReload } from '../config-reload.js';
import { loadConfig, type DaemonConfig } from '../config.js';
import { executorConfigEntry, type ExecutorService } from '../executors/service.js';
import type { Logger } from '../logger.js';
import type { ProfileService } from '../profiles/service.js';
import { writeSituation } from '../situations.js';
import {
  confirmAccounts,
  detectClients,
  detectedProfileOf,
  detectProfiles,
  type ClientReasons,
  type InstalledClients,
} from './detect.js';
import { discoverForPreset, matchPreset } from './discover.js';
import { buildPlan, type PlanApply, type PlanResult } from './plan.js';

/**
 * The setup assistant of the daemon (architecture 5.7, "Primeira execução e assistente de
 * configuração"; N121; P4 of docs/18). [proposta] The rules:
 * - a run is a row of `setup_runs`: the steps answered, in order, with what the Producer sent and
 *   what the daemon derived; the screen of a step is read again at every view, so a run survives the
 *   TUI closing and a restart of the daemon;
 * - each step is validated when it is answered (its zod input, then what the daemon checks against
 *   the machine); one that fails changes nothing;
 * - nothing enters `config.yaml` before `confirm`, which writes everything at once through the
 *   editor of `PUT /v1/config` (comments stay, a secret is refused), then the rows of the table of
 *   Executors, then hands the written keys to the same reload `PUT /v1/config` uses (P23: the roles,
 *   the Executors and the caps are in the running daemon at once, with `config.changed`), then ends
 *   the run. Every write is idempotent, so a `confirm` that stopped halfway is safe to repeat;
 * - `back` undoes only the state of the step it leaves; `cancel` writes nothing;
 * - the plan of `review` is computed by the same function `confirm` applies, over the file as it is
 *   at that moment.
 */

export interface SetupServiceOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `<data>/config.yaml`. */
  readonly configPath: string;
  readonly profiles: Pick<ProfileService, 'list'>;
  /** The cadastro of an Executor (the logic of `ot executor add`); the assistant only uses its dry run. */
  readonly executors: Pick<ExecutorService, 'add'>;
  /** The model catalog of a client, or `undefined` when it is not installed. */
  readonly catalogs: (client: string) => ModelCatalog | undefined;
  /** The clients that can run on this machine. */
  readonly installedClients: InstalledClients;
  /** Why each client is on or off (P18, N321); absent, the steps carry no reason. */
  readonly clientReasons?: ClientReasons | undefined;
  /**
   * Looks for the clients again (P18, N321) and gives the ones it added: `open` before the
   * assistant shows them (each time it opens and starts a run; it never throws), `asked` when the
   * Producer asks ({@link SetupService.redetect}).
   */
  readonly redetect?: ((trigger: ClientRedetectTrigger) => Promise<readonly string[]>) | undefined;
  /**
   * Installs the ACP adapter of a client (P18, N321; the I key of the assistant): the pinned
   * version, as `ot adapters install` does. It never throws for a failed download: it says why.
   * Absent (a daemon with no execution, a test), the install is `unavailable`.
   */
  readonly installAdapter?:
    ((client: SetupAdapterClient) => Promise<AdapterInstallOutcome>) | undefined;
  /**
   * Takes the confirmed write into the running daemon (P23, N208 item 3): the same reload as
   * `PUT /v1/config`. Absent (a test, a tool with no daemon), the file is read at the next start.
   */
  readonly reload?: ConfigReload | undefined;
}

/** What an install of an adapter did, before the clients are looked for again. */
export interface AdapterInstallOutcome {
  readonly adapter: string;
  readonly version: string;
  readonly installed: boolean;
  readonly failure: string | null;
}

/** What the answered steps of a run say. */
interface RunFacts {
  readonly accounts: readonly string[] | null;
  readonly preset: RolePresetName | null;
  readonly discovered: readonly SetupExecutor[];
  readonly registered: readonly SetupExecutor[];
  readonly givenBudgets: readonly SetupBudget[];
  /** N333: the roles given at the review to Executors of the run. */
  readonly placements: readonly SetupRolePlacement[];
  readonly notes: readonly SetupNote[];
}

/** A JSON value from what a schema parsed (the store keeps JSON; undefined keys do not exist there). */
function jsonOf(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function firstStepOf(flow: SetupFlow): SetupStepId {
  const [first] = SETUP_FLOW_STEPS[flow];
  if (first === undefined) throw new Error(`The flow ${flow} has no steps`);
  return first;
}

function stepsOf(flow: SetupFlow): readonly SetupStepId[] {
  return SETUP_FLOW_STEPS[flow];
}

/** The steps answered, as the protocol types them; a row the schema does not read is a bug or a damaged store. */
function doneOf(run: SetupRunRecord): SetupDoneStep[] {
  return run.done.map((entry) => {
    const parsed = SetupDoneStepSchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(`The setup run ${run.id} holds a step the daemon cannot read: ${entry.step}`);
    }
    return parsed.data;
  });
}

function factsOf(done: readonly SetupDoneStep[]): RunFacts {
  let accounts: string[] | null = null;
  let preset: RolePresetName | null = null;
  let discovered: SetupExecutor[] = [];
  let registered: SetupExecutor[] = [];
  let givenBudgets: SetupBudget[] = [];
  let placements: SetupRolePlacement[] = [];
  const notes: SetupNote[] = [];
  for (const entry of done) {
    switch (entry.step) {
      case 'detect':
        accounts = [...entry.output.accounts];
        break;
      case 'account':
        discovered = [...entry.output.discovered];
        notes.push(...entry.output.notes);
        break;
      case 'preset':
        preset = entry.output.preset;
        discovered = [...entry.output.discovered];
        notes.push(...entry.output.notes);
        break;
      case 'executors': {
        // N324: the Executors of the preset the person unchecked stay out of the plan.
        const excluded = new Set(entry.input.exclude);
        discovered = discovered.filter((executor) => !excluded.has(executor.id));
        registered = [...entry.output.executors];
        givenBudgets = [...entry.input.budgets];
        placements = [...entry.input.roles];
        notes.push(...entry.output.notes);
        break;
      }
    }
  }
  return { accounts, preset, discovered, registered, givenBudgets, placements, notes };
}

/** One change of `config.yaml` the confirmation makes. */
type ConfigOp =
  | {
      readonly kind: 'set';
      readonly path: string[];
      readonly value: JsonValue;
      readonly onlyIfAbsent?: true;
    }
  | { readonly kind: 'remove'; readonly path: string[] }
  | {
      readonly kind: 'insert';
      readonly path: string[];
      readonly position: number;
      readonly id: string;
    };

function opsOf(apply: PlanApply): ConfigOp[] {
  const ops: ConfigOp[] = [];
  if (apply.preset !== null)
    ops.push({ kind: 'set', path: ['roles', 'preset'], value: apply.preset });
  for (const list of apply.lists) {
    const path = ['roles', list.role, 'executors'];
    if (list.executors.length === 0) ops.push({ kind: 'remove', path });
    else ops.push({ kind: 'set', path, value: [...list.executors] });
  }
  for (const executor of apply.executors) {
    const [client = '', profile = ''] = executor.profileId.split('/');
    ops.push({
      kind: 'set',
      path: ['executors', executor.id],
      value: jsonOf(
        executorConfigEntry({
          client,
          profile,
          model: executor.model,
          effort: executor.effort,
          provider: executor.provider,
          presetExpand: executor.presetExpand,
        }),
      ) as JsonValue,
    });
    if (executor.local !== null) {
      ops.push({
        kind: 'set',
        path: ['profiles', executor.profileId, 'local'],
        value: { server: executor.local.server, url: executor.local.url },
        onlyIfAbsent: true,
      });
    }
  }
  for (const insertion of apply.insertions) {
    ops.push({
      kind: 'insert',
      path: ['roles', insertion.role, 'executors'],
      position: insertion.position,
      id: insertion.id,
    });
  }
  for (const budget of apply.budgets) {
    const base = ['profiles', budget.profileId, 'budget'];
    for (const [key, value] of [
      ['daily_usd', budget.dailyUsd],
      ['monthly_usd', budget.monthlyUsd],
    ] as const) {
      const path = [...base, key];
      ops.push(value === null ? { kind: 'remove', path } : { kind: 'set', path, value });
    }
  }
  return ops;
}

export class SetupService {
  readonly #o: SetupServiceOptions;
  /** `confirm`s that arrive together run one after the other: the file is read, changed and written whole. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: SetupServiceOptions) {
    this.#o = options;
  }

  // ---- reads ---------------------------------------------------------------------------------

  /** Whether a first run is needed, and the run to resume in each flow. */
  async overview(): Promise<SetupOverview> {
    const { store } = this.#o;
    await this.#o.redetect?.('open');
    const config = await loadConfig(this.#o.configPath);
    const runs = await store.setupRuns.list();
    const confirmedFirstRun = runs.some(
      (run) => run.flow === 'first_run' && run.state === 'confirmed',
    );
    const flows: SetupFlowStatus[] = [];
    for (const flow of SETUP_FLOWS) {
      const own = runs.filter((run) => run.flow === flow);
      const active = own.find((run) => run.state === 'active');
      const finished = own.filter((run) => run.state !== 'active').at(-1);
      flows.push({
        flow,
        steps: [...stepsOf(flow)],
        active: active === undefined ? null : await this.#view(active, config),
        lastFinished:
          finished === undefined || finished.finishedAt === null
            ? null
            : {
                id: finished.id,
                state: finished.state === 'confirmed' ? 'confirmed' : 'cancelled',
                finishedAt: finished.finishedAt,
              },
      });
    }
    return {
      firstRunNeeded:
        !confirmedFirstRun &&
        config.roles.preset === undefined &&
        Object.keys(config.executors.entries).length === 0,
      flows,
    };
  }

  /**
   * Looks for the clients again now (P18, N321; the R key of the assistant), whatever
   * `clients.detection.redetect` says, and gives what changed and the clients as they are.
   */
  async redetect(): Promise<SetupRedetectResult> {
    const added = (await this.#o.redetect?.('asked')) ?? [];
    return {
      added: [...added],
      clients: detectClients(this.#o.installedClients, this.#o.clientReasons),
    };
  }

  /**
   * Installs the ACP adapter of `client` (P18, N321; the I key) and, when it worked, looks for the
   * clients again, so the client enters the pool without a restart. A failed download is the
   * answer (`failure`), not an error; the notices `adapter_*` of the manager say it as well.
   */
  async installAdapter(client: SetupAdapterClient): Promise<SetupAdapterInstallResult> {
    const install = this.#o.installAdapter;
    if (install === undefined) {
      throw new AdapterUnavailable('This daemon cannot install the ACP adapters');
    }
    const outcome = await install(client);
    const added = outcome.installed ? ((await this.#o.redetect?.('asked')) ?? []) : [];
    return {
      client,
      adapter: outcome.adapter,
      version: outcome.version,
      installed: outcome.installed,
      failure: outcome.failure,
      added: [...added],
      clients: detectClients(this.#o.installedClients, this.#o.clientReasons),
    };
  }

  /**
   * After the login of an account (N324): whether the client says it is logged in, and the models
   * its catalog lists, each marked with the Executors of the preset it fills and the ones the
   * configuration already has. [proposta] Reads only: the choice goes in the `executors` step. A
   * catalog that fails is said in the answer (`unavailable`), not thrown: the screen offers L.
   */
  async models(profileId: string): Promise<SetupModels> {
    const ref = parseProfileId(profileId);
    const summary = (await this.#o.profiles.list({ client: ref.client, checkLogin: true })).find(
      (s) => s.profile.id === profileId,
    );
    if (summary === undefined) throw new NotFound(`There is no profile "${profileId}"`);
    const config = await loadConfig(this.#o.configPath);
    const preset = config.roles.preset ?? DEFAULT_ROLE_PRESET;
    const base = {
      profileId,
      kind: summary.profile.kind,
      login: summary.login ?? null,
      preset,
    };
    const catalog = this.#o.catalogs(ref.client);
    if (catalog === undefined) {
      return { ...base, catalog: 'none', reason: null, models: [], notes: [] };
    }
    let listed: readonly ModelInfo[];
    try {
      listed = await catalog.list(ref);
    } catch (error) {
      return {
        ...base,
        catalog: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
        models: [],
        notes: [],
      };
    }
    const found = matchPreset({ profileId, listed, preset, presetExpand: true });
    const registered = Object.entries(config.executors.entries).filter(
      ([, entry]) => entry.client === ref.client && entry.profile === ref.profile,
    );
    return {
      ...base,
      catalog: catalog.discovery === 'automatic' ? 'listed' : 'assisted',
      reason: null,
      models: listed.map((info) => ({
        id: info.id,
        name: info.name ?? null,
        family: info.family ?? null,
        efforts: [...info.efforts],
        local: info.local,
        contextWindow: info.contextWindow ?? null,
        floating: info.floating ?? null,
        preset: found.discovered
          .filter((executor) => executor.model === info.id)
          .map((executor) => ({ id: executor.id, effort: executor.effort })),
        registered: registered.filter(([, entry]) => entry.model === info.id).map(([id]) => id),
      })),
      notes: found.notes,
    };
  }

  async get(runId: string): Promise<SetupRunView> {
    const run = await this.#run(runId);
    return this.#view(run, await loadConfig(this.#o.configPath));
  }

  // ---- the flow ------------------------------------------------------------------------------

  async start(flow: SetupFlow): Promise<SetupRunView> {
    const { store } = this.#o;
    await this.#o.redetect?.('open');
    let run: SetupRunRecord;
    try {
      run = await store.setupRuns.create({ flow, step: firstStepOf(flow) });
    } catch (error) {
      if (error instanceof Conflict) {
        const [active] = await store.setupRuns.list({ flow, states: ['active'] });
        throw new Conflict(
          active === undefined
            ? error.message
            : `A ${flow} run is already in progress (${active.id}): resume it or cancel it first`,
          { cause: error },
        );
      }
      throw error;
    }
    await this.#emit('setup.started', { runId: run.id, flow, step: firstStepOf(flow) });
    return this.#view(run, await loadConfig(this.#o.configPath));
  }

  async submit(runId: string, submission: SetupStepSubmission): Promise<SetupRunView> {
    const run = await this.#active(runId);
    const body = SetupStepSubmissionSchema.parse(submission);
    if (body.step !== run.step) {
      throw new Conflict(
        `The run ${run.id} waits at the step ${run.step}, not ${body.step}: reload it`,
      );
    }
    const steps = stepsOf(run.flow);
    const index = steps.indexOf(run.step);
    const next = steps[index + 1];
    if (index === -1 || next === undefined) {
      throw new InvalidInput(`The step ${run.step} takes no answer: confirm or cancel the run`);
    }
    const config = await loadConfig(this.#o.configPath);
    const done = doneOf(run);
    const output = await this.#answer(run, done, body, config);
    const entry = { step: body.step, input: jsonOf(body.input), output: jsonOf(output) };
    const updated = await this.#o.store.setupRuns.update(run.id, {
      done: [...run.done, entry],
      step: next,
    });
    await this.#emit('setup.step', { runId: run.id, flow: run.flow, step: body.step, next });
    return this.#view(updated, config);
  }

  async back(runId: string): Promise<SetupRunView> {
    const run = await this.#active(runId);
    const last = run.done.at(-1);
    if (last === undefined) {
      throw new InvalidInput(`The run ${run.id} is at its first step: there is nothing to undo`);
    }
    const updated = await this.#o.store.setupRuns.update(run.id, {
      done: run.done.slice(0, -1),
      step: last.step,
    });
    await this.#emit('setup.back', {
      runId: run.id,
      flow: run.flow,
      step: last.step as SetupStepId,
    });
    return this.#view(updated, await loadConfig(this.#o.configPath));
  }

  async cancel(runId: string): Promise<SetupRunView> {
    const run = await this.#active(runId);
    const updated = await this.#o.store.setupRuns.update(run.id, { state: 'cancelled' });
    await this.#emit('setup.cancelled', {
      runId: run.id,
      flow: run.flow,
      step: run.step as SetupStepId,
    });
    return this.#view(updated, await loadConfig(this.#o.configPath));
  }

  /** Writes the whole result at once. See the module comment. */
  confirm(runId: string): Promise<SetupRunView> {
    const next = this.#chain.then(
      () => this.#confirm(runId),
      () => this.#confirm(runId),
    );
    this.#chain = next.catch(() => undefined);
    return next;
  }

  // ---- internals -----------------------------------------------------------------------------

  async #run(runId: string): Promise<SetupRunRecord> {
    const run = await this.#o.store.setupRuns.get(runId);
    if (run === undefined) throw new NotFound(`Setup run ${runId} does not exist`);
    return run;
  }

  async #active(runId: string): Promise<SetupRunRecord> {
    const run = await this.#run(runId);
    if (run.state !== 'active') {
      throw new Conflict(`The run ${run.id} is ${run.state}: start another one`);
    }
    return run;
  }

  async #emit<
    T extends 'setup.started' | 'setup.step' | 'setup.back' | 'setup.cancelled' | 'setup.confirmed',
  >(type: T, payload: DaemonEventPayloads[T]): Promise<void> {
    await writeSituation(this.#o.store.events, this.#o.logger, type, payload);
  }

  /** The accounts that take part: the confirmed ones (first run) or every active one (the others). */
  async #accountsOf(run: SetupRunRecord, facts: RunFacts): Promise<string[]> {
    if (run.flow === 'first_run') return [...(facts.accounts ?? [])];
    const summaries = await this.#o.profiles.list();
    return summaries.filter((s) => s.profile.state === 'active').map((s) => s.profile.id);
  }

  async #factsFor(accounts: readonly string[]): Promise<ProfileFact[]> {
    const summaries = await this.#o.profiles.list();
    const byId = new Map(summaries.map((s) => [s.profile.id, s.profile]));
    const out: ProfileFact[] = [];
    for (const id of accounts) {
      const profile = byId.get(id);
      if (profile !== undefined) out.push({ id, kind: profile.kind, state: profile.state });
    }
    return out;
  }

  /** The plan of a run over the file as it is now. */
  async #planOf(
    run: SetupRunRecord,
    done: readonly SetupDoneStep[],
    config: DaemonConfig,
  ): Promise<PlanResult> {
    const facts = factsOf(done);
    const accounts = await this.#accountsOf(run, facts);
    return buildPlan({
      flow: run.flow,
      config,
      profiles: await this.#factsFor(accounts),
      preset: facts.preset,
      discovered: facts.discovered,
      registered: facts.registered,
      givenBudgets: facts.givenBudgets,
      placements: facts.placements,
      carriedNotes: facts.notes,
      settings: {
        suggestedBudget: {
          dailyUsd: config.setup.suggested_budget.daily_usd,
          monthlyUsd: config.setup.suggested_budget.monthly_usd,
        },
        roleLists: config.setup.role_lists,
      },
    });
  }

  async #view(run: SetupRunRecord, config: DaemonConfig): Promise<SetupRunView> {
    const done = doneOf(run);
    const result =
      run.state === 'confirmed' && run.result !== null
        ? (run.result as unknown as SetupResult)
        : null;
    return {
      id: run.id,
      flow: run.flow,
      state: run.state,
      step: run.step as SetupStepId,
      steps: [...stepsOf(run.flow)],
      done,
      prompt: run.state === 'active' ? await this.#promptOf(run, done, config) : null,
      result,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt,
    };
  }

  async #promptOf(
    run: SetupRunRecord,
    done: readonly SetupDoneStep[],
    config: DaemonConfig,
  ): Promise<SetupPrompt> {
    const step = run.step as SetupStepId;
    switch (step) {
      case 'detect':
        return {
          step,
          clients: detectClients(this.#o.installedClients, this.#o.clientReasons),
          profiles: await detectProfiles(this.#o.profiles, { checkLogin: true }),
        };
      case 'account':
        return { step, profiles: await detectProfiles(this.#o.profiles, { checkLogin: false }) };
      case 'preset':
        return { step, current: config.roles.preset ?? null, options: [...ROLE_PRESET_NAMES] };
      case 'executors': {
        const facts = factsOf(done);
        const accounts = new Set(await this.#accountsOf(run, facts));
        const known = await detectProfiles(this.#o.profiles, { checkLogin: false });
        return {
          step,
          apiProfiles: known.filter(
            (p) => p.kind === 'api' && p.hasSecret && accounts.has(p.profileId),
          ),
          suggestedBudget: {
            dailyUsd: config.setup.suggested_budget.daily_usd,
            monthlyUsd: config.setup.suggested_budget.monthly_usd,
          },
        };
      }
      case 'review':
        return { step, plan: (await this.#planOf(run, done, config)).plan };
    }
  }

  /** Validates the answer of the current step and derives its output. Changes nothing. */
  async #answer(
    run: SetupRunRecord,
    done: readonly SetupDoneStep[],
    body: ReturnType<typeof SetupStepSubmissionSchema.parse>,
    config: DaemonConfig,
  ): Promise<JsonObject | object> {
    const facts = factsOf(done);
    switch (body.step) {
      case 'detect': {
        const input = SetupDetectInputSchema.parse(body.input);
        const profiles = await detectProfiles(this.#o.profiles, { checkLogin: true });
        return {
          clients: detectClients(this.#o.installedClients, this.#o.clientReasons),
          profiles,
          accounts: confirmAccounts(profiles, input.accounts),
        };
      }
      case 'account': {
        const input = SetupAccountInputSchema.parse(body.input);
        const summaries = await this.#o.profiles.list({ checkLogin: false });
        const summary = summaries.find((s) => s.profile.id === input.profileId);
        if (summary === undefined) {
          throw new InvalidInput(`Account ${input.profileId} is not registered`);
        }
        if (summary.profile.state !== 'active') {
          throw new InvalidInput(
            `Account ${input.profileId} is ${summary.profile.state}: only an active account takes part`,
          );
        }
        const found = await discoverForPreset({
          accounts: [input.profileId],
          preset: config.roles.preset ?? DEFAULT_ROLE_PRESET,
          catalogs: this.#o.catalogs,
          presetExpand: true,
        });
        return {
          profile: detectedProfileOf(summary),
          discovered: found.discovered,
          notes: found.notes,
        };
      }
      case 'preset': {
        const input = SetupPresetInputSchema.parse(body.input);
        const accounts = await this.#accountsOf(run, facts);
        const found = await discoverForPreset({
          accounts,
          preset: input.preset,
          catalogs: this.#o.catalogs,
          presetExpand: true,
        });
        const preview = buildPlan({
          flow: run.flow,
          config,
          profiles: await this.#factsFor(accounts),
          preset: input.preset,
          discovered: found.discovered,
          registered: [],
          givenBudgets: [],
          carriedNotes: [],
          settings: {
            suggestedBudget: {
              dailyUsd: config.setup.suggested_budget.daily_usd,
              monthlyUsd: config.setup.suggested_budget.monthly_usd,
            },
            roleLists: config.setup.role_lists,
          },
        });
        return {
          preset: input.preset,
          discovered: found.discovered,
          roles: preview.plan.roles,
          notes: found.notes,
        };
      }
      case 'executors':
        return this.#answerExecutors(
          run,
          facts,
          done,
          SetupExecutorsInputSchema.parse(body.input),
          config,
        );
    }
  }

  async #answerExecutors(
    run: SetupRunRecord,
    facts: RunFacts,
    done: readonly SetupDoneStep[],
    input: ReturnType<typeof SetupExecutorsInputSchema.parse>,
    config: DaemonConfig,
  ): Promise<object> {
    const accounts = await this.#accountsOf(run, facts);
    const known = await this.#o.profiles.list();
    const kindOf = new Map(known.map((s) => [s.profile.id, s.profile.kind]));
    const found = new Set(facts.discovered.map((executor) => executor.id));
    const excluded = new Set<string>();
    for (const id of input.exclude) {
      if (!found.has(id)) {
        throw new InvalidInput(
          `The Executor ${id} is not one the catalogs found for this run: only those can be left out`,
        );
      }
      if (excluded.has(id)) throw new InvalidInput(`The Executor ${id} is left out twice`);
      excluded.add(id);
    }
    const taken = new Set([...found].filter((id) => !excluded.has(id)));
    const registered: SetupExecutor[] = [];
    const notes: SetupNote[] = [];
    for (const request of input.executors) {
      if (!accounts.includes(request.profileId)) {
        throw new InvalidInput(
          `Account ${request.profileId} does not take part in this run: confirm it first`,
        );
      }
      const result = await this.#o.executors.add({
        profileId: request.profileId,
        model: request.model,
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        ...(request.family === undefined ? {} : { family: request.family }),
        ...(request.alias === undefined ? {} : { alias: request.alias }),
        ...(request.localUrl === undefined ? {} : { localUrl: request.localUrl }),
        ...(request.localServer === undefined ? {} : { localServer: request.localServer }),
        testSession: 'off',
        dryRun: true,
      });
      if (result.status === 'needs_input') {
        throw new InvalidInput(
          `The model ${request.model} on ${request.profileId} needs more data: ${result.missing.join(', ')}`,
        );
      }
      if (result.status === 'refused') {
        const reasons = result.issues.filter((issue) => issue.severity === 'error');
        throw new InvalidInput(
          `The model ${request.model} on ${request.profileId} was refused: ${
            reasons.map((issue) => issue.message).join('; ') || 'see the checks of the cadastro'
          }`,
        );
      }
      const id = result.executor.id;
      if (taken.has(id)) throw new InvalidInput(`The Executor ${id} is given twice`);
      taken.add(id);
      const parsed = tryParseExecutorId(id);
      registered.push({
        id,
        profileId: request.profileId,
        model: result.configEntry.model,
        alias: typeof parsed === 'string' ? id : parsed.model,
        effort: result.executor.effort,
        provider: result.executor.provider,
        source: 'registered',
        presetExpand: result.configEntry.preset_expand !== false,
        local: result.localConfig === null ? null : { ...result.localConfig },
      });
      for (const issue of result.issues) {
        if (issue.severity === 'error') continue;
        notes.push({
          severity: issue.severity,
          code: issue.code,
          role: null,
          executorId: id,
          profileId: request.profileId,
          message: issue.message,
        });
      }
    }
    // N333: a role is given to an Executor of this run: the ones the catalogs found (not left out)
    // and the ones this answer registers.
    const placed = new Set<string>();
    for (const placement of input.roles) {
      if (!taken.has(placement.executorId)) {
        throw new InvalidInput(
          `The Executor ${placement.executorId} is not one of this run: only those can be given roles`,
        );
      }
      if (placed.has(placement.executorId)) {
        throw new InvalidInput(`The roles of ${placement.executorId} are given twice`);
      }
      placed.add(placement.executorId);
      if (new Set(placement.roles).size !== placement.roles.length) {
        throw new InvalidInput(`A role is repeated for ${placement.executorId}`);
      }
    }
    const seen = new Set<string>();
    for (const budget of input.budgets) {
      if (seen.has(budget.profileId)) {
        throw new InvalidInput(`The cap of ${budget.profileId} is given twice`);
      }
      seen.add(budget.profileId);
      if (!accounts.includes(budget.profileId)) {
        throw new InvalidInput(`Account ${budget.profileId} does not take part in this run`);
      }
      if (kindOf.get(budget.profileId) !== 'api') {
        throw new InvalidInput(
          `${budget.profileId} is not an API account: a spending cap only applies to an API account`,
        );
      }
    }
    // The caps that will be written: what the plan says with these Executors and these caps.
    const trial: SetupDoneStep = {
      step: 'executors',
      input,
      output: { executors: registered, budgets: [], notes: [] },
    };
    const plan = await this.#planOf(run, [...done, trial], config);
    return { executors: registered, budgets: plan.plan.budgets, notes };
  }

  async #confirm(runId: string): Promise<SetupRunView> {
    const { store } = this.#o;
    const run = await this.#active(runId);
    if (run.step !== 'review') {
      throw new Conflict(`The run ${run.id} is at the step ${run.step}: answer the steps first`);
    }
    const done = doneOf(run);
    const facts = factsOf(done);
    const config = await loadConfig(this.#o.configPath);
    const { plan, apply } = await this.#planOf(run, done, config);

    // Every account that gets an Executor must still be active: the row of the table needs it.
    const summaries = await this.#o.profiles.list();
    for (const executor of apply.executors) {
      const profile = summaries.find((s) => s.profile.id === executor.profileId)?.profile;
      if (profile?.state !== 'active') {
        throw new Conflict(
          `Account ${executor.profileId} is not active any more: go back and choose again`,
        );
      }
    }

    const ops = opsOf(apply);
    for (const op of ops) {
      if (op.kind === 'set' && redactTree(treeAt(op.path, op.value)).paths.length > 0) {
        throw new InvalidInput(
          `The value of ${op.path.join('.')} looks like a secret: keep secrets in the vault, not in the configuration`,
        );
      }
    }
    let next: DaemonConfig;
    try {
      next = await editConfigFile(this.#o.configPath, (editor) => {
        for (const op of ops) {
          if (op.kind === 'set') {
            if (op.onlyIfAbsent === true && editor.has(op.path)) continue;
            editor.set(op.path, op.value);
          } else if (op.kind === 'remove') {
            if (editor.has(op.path)) editor.remove(op.path);
          } else {
            editor.insert(op.path, op.position, op.id);
          }
        }
      });
    } catch (error) {
      if (error instanceof InvalidInput) {
        throw new InvalidInput(error.message.split(this.#o.configPath).join('config.yaml'));
      }
      if (isOTheaterError(error)) throw error;
      throw new InvalidInput(
        `The edit does not fit the file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // The table of Executors: a row for each Executor of the run, whether the file had it or not.
    const written = new Set(apply.executors.map((executor) => executor.id));
    const seen = new Set<string>();
    for (const executor of [...facts.discovered, ...facts.registered]) {
      if (seen.has(executor.id)) continue;
      seen.add(executor.id);
      const row = await store.executors.get(executor.id);
      if (row === undefined) {
        await store.executors.create({
          profileId: executor.profileId,
          model: executor.alias,
          effort: executor.effort,
          provider: executor.provider,
        });
      } else if (row.validity === 'invalid' && written.has(executor.id)) {
        await store.executors.update(executor.id, {
          provider: executor.provider,
          validity: 'valid',
        });
      }
    }

    // The running daemon takes in what was written: the hot keys now, the others at the next start.
    await this.#o.reload?.({ next, paths: plan.writes });

    const result: SetupResult = {
      preset: apply.preset,
      executors: apply.executors.map((executor) => executor.id),
      written: plan.writes,
    };
    const updated = await store.setupRuns.update(run.id, {
      state: 'confirmed',
      result: jsonOf(result),
    });
    this.#o.logger.info(
      { run: run.id, flow: run.flow, executors: result.executors.length },
      'setup confirmed',
    );
    await this.#emit('setup.confirmed', {
      runId: run.id,
      flow: run.flow,
      preset: result.preset,
      executors: result.executors,
      written: result.written,
    });
    return this.#view(updated, await loadConfig(this.#o.configPath));
  }
}
