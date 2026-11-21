// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, InvalidInput, type JsonValue, type ProfileFact } from '@otheater/core';
import { basename } from 'node:path';
import { z } from 'zod';
import { redactConfig } from '../api/routes/redact.js';
import { isPausedPlay, playOf, scenarioOf } from '../api/routes/projections.js';
import { REMOVED_REASON } from '../executors/service.js';
import { resolveScenarioRoleExecutors } from '../orchestration/role-executors.js';
import type { SlashAction, SlashRunContext, SlashOutcome } from './types.js';

/** Events `/logs` looks back through (the log is not indexed by scenario). */
export const LOGS_SCAN_EVENTS = 5000;
const LOGS_PAGE = 500;
/** `/plays` cuts the need of a play at this many characters. */
const NEED_CHARS = 60;

/** A copy of a value as plain JSON (`Date`, `undefined` and class instances out). */
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

const time = (ms: number): string => new Date(ms).toISOString();

export { isPausedPlay };

/** Erases the type of the arguments, so the registry keeps one list of actions. */
function define<Args>(action: SlashAction<Args>): SlashAction {
  return {
    ...action,
    args: action.args,
    run: (context) => action.run(context as SlashRunContext<Args>),
  };
}

/** The arguments of a command that takes none. */
const NO_ARGS = z
  .string()
  .max(0)
  .transform(() => undefined);

/** The arguments of a command that takes a free text, which may be empty. */
const OPTIONAL_TEXT = z.string().max(2000);

/** The arguments of a command that needs a text. */
const REQUIRED_TEXT = z.string().min(1).max(7000);

const runner = (context: SlashRunContext<unknown>): NonNullable<typeof context.deps.runner> => {
  const { runner: found } = context.deps;
  if (found === undefined) throw new AdapterUnavailable(context.t('error.noRunner'));
  return found;
};

const channel = (context: SlashRunContext<unknown>): NonNullable<typeof context.deps.channel> => {
  const { channel: found } = context.deps;
  if (found === undefined) throw new AdapterUnavailable(context.t('error.noChannel'));
  return found;
};

/** The profiles as the selection reads them, to resolve the Executors of the roles. */
async function profileFacts(context: SlashRunContext<unknown>): Promise<ProfileFact[]> {
  return (await context.deps.store.profiles.list()).map((record) => ({
    id: record.id,
    kind: record.kind,
    state: record.state,
  }));
}

/** The Executor the Director of the scenario goes by now: the first valid one of its list. */
async function directorExecutor(context: SlashRunContext<unknown>) {
  const { store, config } = context.deps;
  const resolved = await resolveScenarioRoleExecutors(
    { config, scenarios: store.scenarios },
    { profiles: await profileFacts(context) },
    context.scenario.id,
  );
  const list = resolved.roles.director.executors;
  const found = list.find((item) => item.validity === 'valid') ?? list[0];
  if (found === undefined) throw new InvalidInput(context.t('error.noDirector'));
  return found;
}

/** Lines of text for the Producer: what a client that draws nothing of its own shows. */
const lines = (...rows: readonly string[]): string => rows.join('\n');

const done = (text: string, data?: JsonValue): SlashOutcome =>
  data === undefined ? { text } : { text, data };

// ---- query ----

const status = define({
  id: 'status',
  origin: 'daemon',
  group: 'query',
  descriptionKey: 'desc.status',
  argsKey: undefined,
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: true },
  args: NO_ARGS,
  async run({ scenario, facts, t, deps }) {
    const pending = await deps.store.decisions.list({
      scenarioId: scenario.id,
      states: ['pending'],
    });
    const directors = deps.directors;
    let director: 'busy' | 'idle' | 'asleep' | 'none' = 'none';
    if (directors?.isAsleep(scenario.id) === true) {
      director = 'asleep';
    } else if (directors !== undefined) {
      const open = await directors.clientCommands(scenario.id);
      if (open !== undefined) director = open.inTurn ? 'busy' : 'idle';
    }
    return done(
      lines(
        t('out.status.scenario', {
          name: scenario.name,
          kind: scenario.kind,
          state: scenario.state,
        }),
        t('out.status.counts', { plays: facts.plays.length, decisions: pending.length }),
        t(`out.status.director.${director}`),
      ),
      {
        scenario: {
          id: scenario.id,
          name: scenario.name,
          kind: scenario.kind,
          state: scenario.state,
        },
        openPlays: facts.plays.length,
        pendingDecisions: pending.length,
        director,
      },
    );
  },
});

const quota = define({
  id: 'quota',
  origin: 'daemon',
  group: 'query',
  descriptionKey: 'desc.quota',
  argsKey: undefined,
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: false },
  args: NO_ARGS,
  async run({ t, deps }) {
    const profiles = (await deps.store.profiles.list()).filter((p) => p.state !== 'removed');
    if (profiles.length === 0) return done(t('out.quota.empty'), []);
    const rows: { profile: string; state: string; untilReset: number | null }[] = [];
    for (const profile of profiles) {
      const read = await deps.quota.statusOf(profile.id);
      rows.push({ profile: profile.id, state: read.state, untilReset: read.untilReset });
    }
    return done(
      lines(
        ...rows.map((row) =>
          t('out.quota.line', {
            profile: row.profile,
            state: row.state,
            until:
              row.untilReset === null ? '' : t('out.quota.until', { time: time(row.untilReset) }),
          }),
        ),
      ),
      json(rows),
    );
  },
});

const cost = define({
  id: 'cost',
  origin: 'daemon',
  group: 'query',
  descriptionKey: 'desc.cost',
  argsKey: undefined,
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: false },
  args: NO_ARGS,
  async run({ t, deps }) {
    const totals = await deps.usage.totals({});
    const exceeded: { profile: string; resetsAt: number }[] = [];
    for (const profile of await deps.store.profiles.list()) {
      const breach = deps.budget.exceededOf(profile.id);
      if (breach !== undefined)
        exceeded.push({ profile: breach.profile, resetsAt: breach.resetsAt });
    }
    const rows = [
      t('out.cost.total', {
        turns: totals.turns,
        input: totals.inputTokens,
        output: totals.outputTokens,
      }),
      t('out.cost.usd', {
        real: totals.realUsd.toFixed(2),
        equivalent: totals.apiEquivalentUsd.toFixed(2),
      }),
      ...(totals.complete ? [] : [t('out.cost.unknown', { count: totals.unknownCostTurns })]),
      ...exceeded.map((item) =>
        t('out.cost.exceeded', { profile: item.profile, time: time(item.resetsAt) }),
      ),
    ];
    return done(lines(...rows), json({ totals, exceeded }));
  },
});

const executors = define({
  id: 'executors',
  origin: 'daemon',
  group: 'query',
  descriptionKey: 'desc.executors',
  argsKey: undefined,
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: false },
  args: NO_ARGS,
  async run({ t, deps }) {
    const rows = (await deps.store.executors.list()).filter(
      (row) => row.invalidReason !== REMOVED_REASON,
    );
    if (rows.length === 0) return done(t('out.executors.empty'), []);
    return done(
      lines(
        ...rows.map((row) =>
          t('out.executors.line', {
            id: row.id,
            model: row.model,
            effort: row.effort,
            validity: row.validity,
          }),
        ),
      ),
      json(
        rows.map((row) => ({
          id: row.id,
          profileId: row.profileId,
          model: row.model,
          effort: row.effort,
          validity: row.validity,
        })),
      ),
    );
  },
});

const plays = define({
  id: 'plays',
  origin: 'daemon',
  group: 'query',
  descriptionKey: 'desc.plays',
  argsKey: undefined,
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: true, kinds: ['project', 'task'] },
  args: NO_ARGS,
  run({ facts, t }) {
    if (facts.plays.length === 0) return Promise.resolve(done(t('out.plays.empty'), []));
    return Promise.resolve(
      done(
        lines(
          ...facts.plays.map((play) =>
            t('out.plays.line', {
              id: play.id,
              state: play.state,
              paused: isPausedPlay(play) ? t('out.plays.paused') : '',
              need:
                play.need.length > NEED_CHARS ? `${play.need.slice(0, NEED_CHARS)}...` : play.need,
            }),
          ),
        ),
        json(facts.plays.map(playOf)),
      ),
    );
  },
});

const LOG_COUNT = z
  .string()
  .regex(/^\d*$/)
  .transform((text) => (text === '' ? undefined : Number(text)))
  .pipe(z.int().min(1).max(500).optional());

const logs = define({
  id: 'logs',
  origin: 'daemon',
  group: 'query',
  descriptionKey: 'desc.logs',
  argsKey: 'args.logs',
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: true },
  args: LOG_COUNT,
  async run({ scenario, args, t, deps }) {
    const wanted = args ?? deps.config.chat.slash_logs_lines;
    const last = await deps.store.events.lastId();
    const found: { id: number; timestamp: number; type: string }[] = [];
    let cursor = Math.max(0, last - LOGS_SCAN_EVENTS);
    for (;;) {
      const page = await deps.store.events.readFrom(cursor, LOGS_PAGE);
      if (page.length === 0) break;
      for (const event of page) {
        if (event.scenarioId === scenario.id) {
          found.push({ id: event.id, timestamp: event.timestamp, type: event.type });
        }
      }
      cursor = page[page.length - 1]?.id ?? last;
      if (cursor >= last) break;
    }
    const shown = found.slice(-wanted);
    if (shown.length === 0) return done(t('out.logs.empty'), []);
    return done(
      lines(
        ...shown.map((event) =>
          t('out.logs.line', { id: event.id, time: time(event.timestamp), type: event.type }),
        ),
      ),
      shown,
    );
  },
});

const doctor = define({
  id: 'doctor',
  origin: 'daemon',
  group: 'query',
  descriptionKey: 'desc.doctor',
  argsKey: undefined,
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: false },
  args: NO_ARGS,
  async run({ t, deps }) {
    const checks: { name: string; ok: boolean; line: string }[] = [];
    const mark = (ok: boolean): string => t(ok ? 'out.doctor.ok' : 'out.doctor.problem');
    try {
      const last = await deps.store.events.lastId();
      checks.push({
        name: 'store',
        ok: true,
        line: t('out.doctor.store', { status: mark(true), last }),
      });
    } catch {
      // The failure is the answer: the line says the store has a problem.
      checks.push({
        name: 'store',
        ok: false,
        line: t('out.doctor.store', { status: mark(false), last: 0 }),
      });
    }
    const profiles = await deps.store.profiles.list();
    const active = profiles.filter((p) => p.state === 'active');
    checks.push({
      name: 'profiles',
      ok: true,
      line: t('out.doctor.profiles', {
        status: mark(true),
        active: active.length,
        total: profiles.length,
      }),
    });
    const rows = (await deps.store.executors.list()).filter(
      (row) => row.invalidReason !== REMOVED_REASON,
    );
    const invalid = rows.filter((row) => row.validity === 'invalid').length;
    checks.push({
      name: 'executors',
      ok: invalid === 0,
      line: t('out.doctor.executors', {
        status: mark(invalid === 0),
        valid: rows.length - invalid,
        invalid,
      }),
    });
    let exhausted = 0;
    for (const profile of active) {
      if ((await deps.quota.statusOf(profile.id)).state === 'exhausted') exhausted += 1;
    }
    checks.push({
      name: 'quota',
      ok: exhausted === 0,
      line: t('out.doctor.quota', {
        status: mark(exhausted === 0),
        exhausted,
        total: active.length,
      }),
    });
    const runs = deps.runner !== undefined;
    checks.push({
      name: 'plays',
      ok: runs,
      line: t('out.doctor.plays', {
        status: mark(runs),
        state: t(runs ? 'out.doctor.playsOn' : 'out.doctor.playsOff'),
      }),
    });
    const problems = checks.filter((check) => !check.ok).length;
    return done(
      lines(...checks.map((check) => check.line), t('out.doctor.summary', { problems })),
      json({ checks: checks.map(({ name, ok }) => ({ name, ok })), problems }),
    );
  },
});

// ---- control ----

const REASON = OPTIONAL_TEXT.transform((text) => (text === '' ? undefined : text));

const pause = define({
  id: 'pause',
  origin: 'daemon',
  group: 'control',
  descriptionKey: 'desc.pause',
  argsKey: 'args.pause',
  permission: 'write',
  confirm: false,
  appliesTo: { scoped: true, kinds: ['project', 'task'], states: ['active'], plays: 'unpaused' },
  args: REASON,
  async run(context) {
    const { facts, args, t, deps } = context;
    const target = runner(context);
    const mode = deps.pauseMode?.() ?? 'drain';
    const open = facts.plays.filter((play) => !isPausedPlay(play));
    for (const play of open) {
      await target.send(play.id, {
        type: 'PAUSE',
        mode,
        ...(args === undefined ? {} : { reason: args }),
      });
    }
    return done(lines(t('out.pause.done', { count: open.length }), t('out.pause.mode', { mode })), {
      paused: open.map((play) => play.id),
      mode,
    });
  },
});

const resume = define({
  id: 'resume',
  origin: 'daemon',
  group: 'control',
  descriptionKey: 'desc.resume',
  argsKey: 'args.pause',
  permission: 'write',
  confirm: false,
  appliesTo: { scoped: true, kinds: ['project', 'task'], states: ['active'], plays: 'paused' },
  args: REASON,
  async run(context) {
    const { facts, args, t } = context;
    const target = runner(context);
    const held = facts.plays.filter(isPausedPlay);
    for (const play of held) {
      await target.send(play.id, {
        type: 'RESUME',
        ...(args === undefined ? {} : { reason: args }),
      });
    }
    return done(t('out.resume.done', { count: held.length }), { resumed: held.map((p) => p.id) });
  },
});

const cancel = define({
  id: 'cancel',
  origin: 'daemon',
  group: 'control',
  descriptionKey: 'desc.cancel',
  argsKey: 'args.cancel',
  permission: 'write',
  confirm: true,
  appliesTo: { scoped: true, kinds: ['project', 'task'], states: ['active'], plays: 'open' },
  args: REASON,
  async run(context) {
    const { facts, args, t } = context;
    const target = runner(context);
    for (const play of facts.plays) {
      await target.send(play.id, {
        type: 'CANCEL',
        ...(args === undefined ? {} : { reason: args }),
      });
    }
    return done(t('out.cancel.done', { count: facts.plays.length }), {
      cancelled: facts.plays.map((play) => play.id),
    });
  },
});

/**
 * Esc of the TUI (Phase 7, P12): stops the reply the Director is giving, without pausing the play.
 * It is valid even in a turn, which is its point; a plain action of the daemon, no turn of its own.
 */
const stop = define({
  id: 'stop',
  origin: 'daemon',
  group: 'control',
  descriptionKey: 'desc.stop',
  argsKey: undefined,
  permission: 'write',
  confirm: false,
  appliesTo: { scoped: true, states: ['active'] },
  args: NO_ARGS,
  async run({ scenario, t, deps }) {
    const stopped = (await deps.directors?.interrupt(scenario.id)) === true;
    return done(t(stopped ? 'out.stop.done' : 'out.stop.idle'), { stopped });
  },
});

// ---- session and scenario ----

const NAME = z
  .string()
  .max(200)
  .transform((text) => (text === '' ? undefined : text));

/**
 * `/new project <repo>` (N208, item 1): the word `project` first, then the repository. Anything
 * else is the name of a chat, as before; a chat that must be named "project" cannot be opened by
 * this command (the TUI and the `ot chat` command still can).
 */
const PROJECT_ARGS = /^project(?:\s+([\s\S]*))?$/;

const newScenario = define({
  id: 'new',
  origin: 'daemon',
  group: 'session',
  descriptionKey: 'desc.new',
  argsKey: 'args.new',
  permission: 'write',
  confirm: false,
  appliesTo: { scoped: false },
  args: NAME,
  async run(context) {
    const project = context.args === undefined ? null : PROJECT_ARGS.exec(context.args.trim());
    if (project !== null) {
      const repo = (project[1] ?? '').trim();
      if (repo === '') throw new InvalidInput(context.t('error.newProject.noRepo'));
      // The same route as `ot chat --type project --repo <repo>` (`openChat`, the type registry).
      const opened = await channel(context)
        .openChat({ type: 'project', repo })
        .catch((error: unknown) => {
          if (error instanceof InvalidInput) {
            throw new InvalidInput(context.t('error.newProject.badRepo', { repo }), {
              cause: error,
            });
          }
          throw error;
        });
      return done(context.t('out.new.project', { name: basename(repo), id: opened.scenarioId }), {
        scenarioId: opened.scenarioId,
        type: 'project',
      });
    }
    const opened = await channel(context).openChat({
      type: 'chat',
      ...(context.args === undefined ? {} : { name: context.args }),
    });
    return done(context.t('out.new.done', { id: opened.scenarioId }), {
      scenarioId: opened.scenarioId,
    });
  },
});

const attach = define({
  id: 'attach',
  origin: 'daemon',
  group: 'session',
  descriptionKey: 'desc.attach',
  argsKey: 'args.attach',
  permission: 'write',
  confirm: false,
  appliesTo: { scoped: true, states: ['active'] },
  args: REQUIRED_TEXT,
  async run(context) {
    const record = await channel(context).attach(context.scenario.id, { path: context.args });
    return done(context.t('out.attach.done', { name: record.name, id: record.id }), {
      attachmentId: record.id,
    });
  },
});

const exportScenario = define({
  id: 'export',
  origin: 'daemon',
  group: 'session',
  descriptionKey: 'desc.export',
  argsKey: undefined,
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: true },
  args: NO_ARGS,
  async run({ scenario, t, deps }) {
    const [allPlays, decisions] = await Promise.all([
      deps.store.plays.list({ scenarioId: scenario.id }),
      deps.store.decisions.list({ scenarioId: scenario.id }),
    ]);
    return done(
      t('out.export.done', {
        name: scenario.name,
        plays: allPlays.length,
        decisions: decisions.length,
      }),
      json({
        scenario: scenarioOf(scenario),
        plays: allPlays.map(playOf),
        decisions,
      }),
    );
  },
});

// ---- configure ----

const model = define({
  id: 'model',
  origin: 'daemon',
  group: 'configure',
  descriptionKey: 'desc.model',
  argsKey: undefined,
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: true },
  args: NO_ARGS,
  async run(context) {
    const found = await directorExecutor(context);
    return done(context.t('out.model.line', { model: found.entry.model, id: found.id }), {
      executor: found.id,
      model: found.entry.model,
    });
  },
});

const effort = define({
  id: 'effort',
  origin: 'daemon',
  group: 'configure',
  descriptionKey: 'desc.effort',
  argsKey: undefined,
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: true },
  args: NO_ARGS,
  async run(context) {
    const found = await directorExecutor(context);
    return done(context.t('out.effort.line', { effort: found.entry.effort, id: found.id }), {
      executor: found.id,
      effort: found.entry.effort,
    });
  },
});

const direct = define({
  id: 'direct',
  origin: 'daemon',
  group: 'session',
  descriptionKey: 'desc.direct',
  argsKey: 'args.direct',
  permission: 'write',
  confirm: false,
  appliesTo: { scoped: true, states: ['active'] },
  args: REASON,
  async run(context) {
    const { args, t, deps, scenario } = context;
    if (deps.direct === undefined) throw new AdapterUnavailable(t('error.noDirect'));
    const opened = await deps.direct.open(scenario.id, { executor: args });
    if (opened.session === undefined) {
      return done(t('out.direct.confirm'), { status: opened.status, workspace: opened.workspace });
    }
    return done(
      t('out.direct.opened', {
        id: opened.session.id,
        executor: opened.session.executor,
        workspace: opened.workspace,
      }),
      { status: opened.status, session: opened.session.id },
    );
  },
});

const profile = define({
  id: 'profile',
  origin: 'daemon',
  group: 'configure',
  descriptionKey: 'desc.profile',
  argsKey: undefined,
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: false },
  args: NO_ARGS,
  async run({ t, deps }) {
    const rows = (await deps.store.profiles.list()).filter((row) => row.state !== 'removed');
    if (rows.length === 0) return done(t('out.profile.empty'), []);
    return done(
      lines(
        ...rows.map((row) =>
          t('out.profile.line', { id: row.id, kind: row.kind, state: row.state }),
        ),
      ),
      json(rows.map((row) => ({ id: row.id, kind: row.kind, state: row.state }))),
    );
  },
});

const directives = define({
  id: 'directives',
  origin: 'daemon',
  group: 'configure',
  descriptionKey: 'desc.directives',
  argsKey: undefined,
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: true },
  args: NO_ARGS,
  async run({ scenario, t, deps }) {
    const rows = await deps.directives.list({ scenarioId: scenario.id, states: ['active'] });
    if (rows.length === 0) return done(t('out.directives.empty'), []);
    return done(
      lines(
        ...rows.map((row) =>
          t('out.directives.line', {
            id: row.id,
            scope: row.scope,
            kind: row.kind,
            text: row.text,
          }),
        ),
      ),
      json(rows.map((row) => ({ id: row.id, scope: row.scope, kind: row.kind, text: row.text }))),
    );
  },
});

const CONFIG_KEY = z.string().max(200);

const config = define({
  id: 'config',
  origin: 'daemon',
  group: 'configure',
  descriptionKey: 'desc.config',
  argsKey: 'args.config',
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: false },
  args: CONFIG_KEY,
  run({ args, t, deps }) {
    const { value } = redactConfig(deps.config);
    if (args === '') {
      const names = Object.keys(value);
      return Promise.resolve(done(t('out.config.sections', { names: names.join(', ') }), names));
    }
    let found: unknown = value;
    for (const part of args.split('.')) {
      if (typeof found !== 'object' || found === null || !(part in found)) {
        throw new InvalidInput(t('error.unknownKey', { key: args }));
      }
      found = (found as Record<string, unknown>)[part];
    }
    return Promise.resolve(
      done(t('out.config.value', { key: args, value: JSON.stringify(found) }), json(found)),
    );
  },
});

const help = define({
  id: 'help',
  origin: 'daemon',
  group: 'help',
  descriptionKey: 'desc.help',
  argsKey: 'args.help',
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: false },
  args: CONFIG_KEY,
  async run({ args, t, commands }) {
    const all = await commands();
    const hint = (item: { args: string }): string => (item.args === '' ? '' : ` ${item.args}`);
    if (args !== '') {
      const wanted = args.replace(/^\//, '');
      const item = all.find((entry) => entry.id === wanted);
      if (item === undefined) throw new InvalidInput(t('error.unknown', { name: wanted }));
      return done(
        lines(
          t('out.help.one', {
            name: item.name,
            args: hint(item),
            description: item.description,
          }),
          ...(item.confirm ? [t('out.help.confirm')] : []),
        ),
        json(item),
      );
    }
    return done(
      lines(
        t('out.help.header'),
        ...all.map((item) =>
          t('out.help.line', { name: item.name, args: hint(item), description: item.description }),
        ),
      ),
      json(all),
    );
  },
});

// ---- trajectory (P14) ----

/** The arguments of `/trajectory`: a play (default: the latest of the scenario) and a demand. */
const TRAJECTORY_ARGS = z
  .string()
  .max(400)
  .transform((text) => {
    const [play, demand] = text.trim().split(/\s+/);
    return {
      play: play === undefined || play === '' ? undefined : play,
      demand: demand === undefined || demand === '' ? undefined : demand,
    };
  });

const trajectory = define({
  id: 'trajectory',
  origin: 'daemon',
  group: 'query',
  descriptionKey: 'desc.trajectory',
  argsKey: 'args.trajectory',
  permission: 'read',
  confirm: false,
  appliesTo: { scoped: true, kinds: ['project', 'task'] },
  args: TRAJECTORY_ARGS,
  async run({ scenario, args, t, deps }) {
    const { trajectory: service } = deps;
    if (service === undefined) throw new AdapterUnavailable(t('error.noTrajectory'));
    const own = await deps.store.plays.list({ scenarioId: scenario.id });
    const play =
      args.play === undefined
        ? own[own.length - 1]
        : own.find((candidate) => candidate.id === args.play);
    if (play === undefined) {
      throw new InvalidInput(
        args.play === undefined
          ? t('error.trajectory.noPlay')
          : t('error.trajectory.unknownPlay', { id: args.play }),
      );
    }
    if (args.demand !== undefined) {
      const found = await service.diff(play.id, args.demand);
      if (!found.available) {
        return done(
          t('out.trajectory.diffUnavailable', {
            demand: args.demand,
            reason: t(`out.trajectory.reason.${found.unavailable ?? 'no_vcs'}`),
          }),
          json(found),
        );
      }
      if (found.diff === '')
        return done(t('out.trajectory.diffEmpty', { demand: args.demand }), json(found));
      return done(
        lines(
          t('out.trajectory.diffHeader', { demand: args.demand, play: play.id }),
          found.diff,
          ...(found.truncated ? [t('out.trajectory.diffTruncated')] : []),
        ),
        json(found),
      );
    }
    const folded = await service.trajectory(play.id);
    if (folded.attempts.length === 0) {
      return done(t('out.trajectory.empty', { play: play.id }), json(folded));
    }
    return done(
      lines(
        t('out.trajectory.header', { play: play.id, state: play.state }),
        ...folded.attempts.map((attempt) =>
          t('out.trajectory.attempt', {
            id: attempt.attemptId,
            demand: attempt.demandId ?? '-',
            state: attempt.state,
            turns: attempt.turns.length,
            entries: attempt.turns.reduce((sum, turn) => sum + turn.entries.length, 0),
          }),
        ),
      ),
      json(folded),
    );
  },
});

/** The commands of the daemon, in the order the list shows them. */
export const BUILTIN_ACTIONS: readonly SlashAction[] = [
  status,
  quota,
  cost,
  executors,
  plays,
  logs,
  doctor,
  pause,
  resume,
  cancel,
  stop,
  newScenario,
  attach,
  exportScenario,
  model,
  effort,
  profile,
  direct,
  directives,
  config,
  trajectory,
  help,
];

/**
 * A template for the Director (`chat.slash_templates`): the words of the Producer go after the
 * text of the template, and the whole goes to the Director like any message of the Producer.
 */
export function templateAction(name: string, template: string): SlashAction {
  return define({
    id: name,
    origin: 'template',
    group: 'session',
    descriptionKey: 'desc.template',
    descriptionVars: { text: template.trim() },
    argsKey: 'args.template',
    permission: 'write',
    confirm: false,
    appliesTo: { scoped: true, states: ['active'] },
    args: REQUIRED_TEXT,
    async run(context) {
      await channel(context).send(context.scenario.id, `${template}${context.args}`);
      return { status: 'forwarded', text: context.t('out.forwarded.template') };
    },
  });
}
