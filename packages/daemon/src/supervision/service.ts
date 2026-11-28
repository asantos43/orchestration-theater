// SPDX-License-Identifier: MPL-2.0
import {
  parseScript,
  SCRIPT_KEY,
  type Clock,
  type EventEnvelope,
  type Script,
  type Store,
} from '@otheater/core';
import { isFinalPlayState, type SupervisionLimit } from '@otheater/protocol';
import type { Logger } from '../logger.js';
import { ToolFailure, type ToolCall, type ToolHandlers } from '../mcp/handlers.js';
import type { EventHub } from '../events/event-hub.js';
import type { DirectorSessions } from '../orchestration/director.js';
import type { PromptDispatcher } from '../prompt-dispatcher.js';
import type { SituationSink } from '../situations.js';
import { clipText, noticeLabel, SupervisionChannel, type Notice } from './channel.js';
import type { SupervisionSettings } from './config.js';
import { DirectorCaller, statusAnswerPrompt } from './director-call.js';
import {
  changedContracts,
  SignalDetector,
  type DetectedSignal,
  type WatchedAttempt,
} from './signals.js';

/**
 * The Director's supervision of the Actors (N309, D8; plan of Phase 11b, P14): the service that
 * ties the signals ({@link SignalDetector}), the channel ({@link SupervisionChannel}), the call to
 * the Director ({@link DirectorCaller}) and the four tools of the Director. It follows the event
 * log, like the automatic ATIF export: it looks at what the daemon already sees and never touches
 * the Actors by itself, except for the notice of a changed contract.
 *
 * It is created before the MCP server (the server needs {@link noticesFor} and the handlers need
 * to be registered) and bound with {@link bind} once the orchestration exists.
 */

/** What the service needs of the store. */
export type SupervisionStore = Pick<Store, 'blackboard' | 'plays' | 'attempts'>;

export interface SupervisionServiceDeps {
  readonly store: SupervisionStore;
  /** `supervision`, read live (the configuration can be reloaded). */
  readonly settings: () => SupervisionSettings;
  /** `limits.demand_timeout`, in ms: the time of a demand that sets none. */
  readonly demandTimeoutMs: () => number;
  readonly situations: SituationSink | undefined;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Pick<Logger, 'warn'>;
  readonly newId?: () => string;
}

/** What is bound once the orchestration exists. */
export interface SupervisionRuntime {
  readonly directors: Pick<DirectorSessions, 'ensure' | 'scenarioOf'>;
  readonly dispatcher: Pick<PromptDispatcher, 'submit'>;
  readonly hub: Pick<EventHub, 'follow'>;
  /** Cancels an attempt (`execution.runner.cancelAttempt`). */
  readonly cancelAttempt: (attemptId: string) => Promise<unknown>;
}

/** The attempt states in which an attempt still has work to do. */
const ACTIVE_STATES: ReadonlySet<string> = new Set([
  'executing',
  'interrupted',
  'awaiting_resume',
  'resuming',
]);

/** The events the service reads. */
const FOLLOWED = ['permission.', 'session.', 'tool.', 'attempt.', 'play.', 'demand.'] as const;

/** How often (ms) a play with running attempts is checked for a changed script. [proposta] */
const SCRIPT_CHECK_MS = 2000;

/** The text of the notice that asks for a partial state. */
const STATUS_REQUEST_TEXT =
  'The Director asks where you are. Call `submit` once with {"result": {"state": "status", "summary": "<what is done, what is left, what blocks you>"}} and then go on working: that call does not end your turn.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The notice as the Actor reads it: marked as the Director's, and not as data of the tool. */
export function formatNotice(notice: Pick<Notice, 'kind' | 'text'>): string {
  return `[Director supervision, ${noticeLabel(notice.kind)}: this message comes from the Director of the scenario, not from the tool and not from the user.]\n${notice.text}`;
}

function failure(code: string, message: string, details?: Record<string, unknown>): ToolFailure {
  return new ToolFailure(code, message, details);
}

export class SupervisionService {
  readonly #deps: SupervisionServiceDeps;
  readonly channel: SupervisionChannel;
  readonly detector: SignalDetector;
  #runtime: SupervisionRuntime | undefined;
  #caller: DirectorCaller | undefined;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;
  /** Attempts that are not Actor attempts (the Director's own session): not looked up again. */
  readonly #ignored = new Set<string>();
  /** The script of each watched play as the supervision last saw it. */
  readonly #scripts = new Map<string, { version: number; script: Script | undefined }>();
  readonly #scriptChecked = new Map<string, number>();
  /** The redirects whose attempt was cancelled and not yet judged: by attempt. */
  readonly #redirects = new Map<string, { readonly demand: string; readonly text: string }>();
  /** The text of the redirects the relaunch of the demand carries in its prompt: by `play/demand`. */
  readonly #relaunch = new Map<string, string>();

  constructor(deps: SupervisionServiceDeps) {
    this.#deps = deps;
    this.channel = new SupervisionChannel({
      store: deps.store,
      situations: deps.situations,
      settings: deps.settings,
      ...(deps.newId === undefined ? {} : { newId: deps.newId }),
    });
    this.detector = new SignalDetector(deps.settings);
  }

  // ---- life ----

  /** Binds the orchestration and starts to follow the log; a second call replaces the first. */
  async bind(runtime: SupervisionRuntime): Promise<void> {
    await this.unbind();
    this.#runtime = runtime;
    this.#caller = new DirectorCaller({
      settings: this.#deps.settings,
      channel: this.channel,
      directors: runtime.directors,
      dispatcher: runtime.dispatcher,
    });
    if (this.#deps.settings().mode === 'off') return;
    const abort = new AbortController();
    this.#abort = abort;
    this.#loop = this.#run(runtime, abort.signal);
  }

  /** Stops following and waits for the event in progress. */
  async unbind(): Promise<void> {
    this.#abort?.abort();
    await this.#loop;
    this.#abort = undefined;
    this.#loop = undefined;
    this.#runtime = undefined;
    this.#caller = undefined;
    this.#redirects.clear();
    this.#relaunch.clear();
  }

  async #run(runtime: SupervisionRuntime, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of runtime.hub.follow({
        filter: { typePrefixes: [...FOLLOWED] },
        signal,
      })) {
        await this.handle(event);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.#deps.logger.warn({ err: error }, 'the supervision of the Director stopped');
      }
    }
  }

  // ---- the MCP server ----

  /** The text blocks to add to the next tool reply of an Actor attempt (and they count as delivered). */
  async noticesFor(context: {
    readonly attemptId: string;
    readonly playId: string;
    readonly demandId: string;
  }): Promise<readonly string[]> {
    if (this.#deps.settings().mode === 'off') return [];
    const taken = await this.channel.take(context);
    return taken.map(formatNotice);
  }

  /**
   * The reason the cancel of an attempt gives when the Director redirected it: it goes to judgment
   * point 2 (`actor_timeout`), whose `reassign` relaunches the demand. One use; the text then waits
   * for the relaunch ({@link redirectFeedback}). [proposta]
   */
  redirectReason(attemptId: string): string | undefined {
    const redirect = this.#redirects.get(attemptId);
    if (redirect === undefined) return undefined;
    this.#redirects.delete(attemptId);
    this.#relaunch.set(redirect.demand, redirect.text);
    return `Redirected by the Director: ${redirect.text}`;
  }

  /**
   * The feedback of the relaunch of a demand the Director redirected: its text, in the prompt of the
   * next attempt ("Why this runs again"). The machine of the play drops the reason of the cancel
   * when the judgment is answered, so the relaunch asks for it here. One use. [proposta]
   */
  redirectFeedback(playId: string, demandId: string): string | undefined {
    const key = `${playId}/${demandId}`;
    const text = this.#relaunch.get(key);
    if (text === undefined) return undefined;
    this.#relaunch.delete(key);
    return `Redirected by the Director: ${text}`;
  }

  // ---- the events ----

  /** One event of the log. Public so a test can feed it without a hub. */
  async handle(event: EventEnvelope): Promise<void> {
    const settings = this.#deps.settings();
    const caller = this.#caller;
    if (settings.mode === 'off' || caller === undefined) return;
    if (event.type.startsWith('supervision.')) return;
    const { playId, attemptId } = event;
    const payload: unknown = event.payload;
    if (playId !== undefined && isStep(event)) caller.step(playId);
    try {
      if (event.type === 'play.transitioned' && playId !== undefined) {
        const to = isRecord(payload) ? payload.to : undefined;
        if (typeof to === 'string' && isFinalPlayState(to)) await this.#endPlay(playId);
        return;
      }
      if (event.type === 'demand.transitioned' && playId !== undefined) {
        await this.#checkContracts(playId, true);
        return;
      }
      if (attemptId === undefined || playId === undefined) return;
      if (event.type === 'session.prompt_finished') this.channel.turnFinished(attemptId);
      if (await this.#ends(event)) return;
      if (!this.detector.has(attemptId)) await this.#discover(attemptId, playId);
      if (!this.detector.has(attemptId)) return;
      if (event.type === 'attempt.submitted') {
        await this.#statusAnswer(event);
        return;
      }
      for (const signal of this.detector.inspect(event)) await this.#onSignal(signal);
      for (const signal of this.detector.elapsed(this.#deps.clock.now())) {
        await this.#onSignal(signal);
      }
      await this.#checkContracts(playId, false);
    } catch (error) {
      this.#deps.logger.warn({ err: error, type: event.type }, 'the supervision skipped an event');
    }
  }

  /** The event ends an attempt: its notices are settled and it is not watched any more. */
  async #ends(event: EventEnvelope): Promise<boolean> {
    const { attemptId } = event;
    if (attemptId === undefined) return false;
    const payload: unknown = event.payload;
    const closed =
      event.type === 'attempt.cancelled' ||
      event.type === 'attempt.aborted' ||
      (event.type === 'session.closed' && isRecord(payload) && payload.reason !== 'interrupted');
    if (!closed) return false;
    const watched = this.detector.watched(attemptId);
    if (watched === undefined) return true;
    this.detector.remove(attemptId);
    await this.channel.endAttempt(watched.playId, watched.demandId, attemptId);
    return true;
  }

  async #endPlay(playId: string): Promise<void> {
    for (const watched of this.detector.attempts(playId)) {
      this.detector.remove(watched.attemptId);
      await this.channel.endAttempt(playId, watched.demandId, watched.attemptId);
    }
    this.#scripts.delete(playId);
    this.#scriptChecked.delete(playId);
    for (const key of [...this.#relaunch.keys()]) {
      if (key.startsWith(`${playId}/`)) this.#relaunch.delete(key);
    }
  }

  /** Starts to watch an attempt the registry says is an Actor attempt that is running. */
  async #discover(attemptId: string, playId: string): Promise<void> {
    if (this.#ignored.has(attemptId)) return;
    const record = await this.#deps.store.attempts.get(attemptId);
    if (record === undefined) {
      this.#ignored.add(attemptId);
      return;
    }
    if (!ACTIVE_STATES.has(record.state)) return;
    const script = await this.#scriptOf(playId);
    const demand = script?.demands.find((candidate) => candidate.id === record.demandId);
    const cited = [...(demand?.contract.inputs ?? []), ...(demand?.contract.outputs ?? [])];
    const timeoutMs =
      demand?.timeoutMin === undefined ? this.#deps.demandTimeoutMs() : demand.timeoutMin * 60_000;
    this.detector.add({
      attemptId,
      playId,
      demandId: record.demandId,
      worktree: record.worktree,
      startedAt: this.#deps.clock.now(),
      expectedFiles: demand?.expectedFiles ?? [],
      contracts: cited,
      timeoutMs,
    } satisfies WatchedAttempt);
  }

  /** The script of the play, and the baseline for `contract_changed`. */
  async #scriptOf(playId: string): Promise<Script | undefined> {
    const entry = await this.#deps.store.blackboard.get(playId, SCRIPT_KEY);
    if (entry === undefined) return undefined;
    const parsed = parseScript(entry.value);
    const script = parsed.success ? parsed.script : undefined;
    if (!this.#scripts.has(playId)) this.#scripts.set(playId, { version: entry.version, script });
    return script;
  }

  /** Looks for a script version the supervision has not seen (at most every `SCRIPT_CHECK_MS`). */
  async #checkContracts(playId: string, force: boolean): Promise<void> {
    if (this.detector.attempts(playId).length === 0) return;
    const now = this.#deps.clock.now();
    const last = this.#scriptChecked.get(playId);
    if (!force && last !== undefined && now - last < SCRIPT_CHECK_MS) return;
    this.#scriptChecked.set(playId, now);
    const known = this.#scripts.get(playId);
    const entry = await this.#deps.store.blackboard.get(playId, SCRIPT_KEY);
    if (entry === undefined || known === undefined || entry.version <= known.version) return;
    const parsed = parseScript(entry.value);
    const script = parsed.success ? parsed.script : undefined;
    this.#scripts.set(playId, { version: entry.version, script });
    if (script === undefined || known.script === undefined) return;
    const signal = this.detector.contractChanged(playId, changedContracts(known.script, script));
    if (signal !== undefined) await this.#onSignal(signal);
  }

  // ---- the signals ----

  async #onSignal(signal: DetectedSignal): Promise<void> {
    const settings = this.#deps.settings();
    const caller = this.#caller;
    if (settings.mode === 'off' || caller === undefined) return;
    const scenarioId = await this.#scenarioOf(signal.playId);
    let outcome: 'director_called' | 'notified' | 'logged' | 'limited' = 'logged';
    try {
      if (settings.mode === 'log' || scenarioId === undefined) {
        outcome = 'logged';
      } else if (signal.signal === 'contract_changed') {
        outcome = await this.#notifyDependents(signal);
      } else {
        outcome = (await caller.call(signal, scenarioId)).outcome;
      }
    } catch (error) {
      this.#deps.logger.warn({ err: error, signal: signal.signal }, 'the Director was not called');
    }
    await this.channel.record(
      'supervision.signal',
      {
        signal: signal.signal,
        demandId: signal.demandId,
        detail: clipText(signal.detail),
        outcome,
        attemptIds: [...signal.attemptIds],
      },
      signal.playId,
      signal.attemptIds[0],
    );
  }

  /**
   * The contract a demand cites changed in the script: the daemon itself warns the Actors that
   * depend on it, with no call to the Director (it is the Director that replans). Each Actor's
   * notice counts against `max_warnings_per_demand`.
   */
  async #notifyDependents(signal: DetectedSignal): Promise<'notified' | 'limited'> {
    const max = this.#deps.settings().max_warnings_per_demand;
    let sent = 0;
    for (const attemptId of signal.attemptIds) {
      const watched = this.detector.watched(attemptId);
      if (watched === undefined) continue;
      const used = await this.channel.warnings(watched.playId, watched.demandId);
      if (used >= max) {
        await this.#limit('max_warnings_per_demand', watched, used + 1, max);
        continue;
      }
      await this.channel.queue({
        playId: watched.playId,
        demandId: watched.demandId,
        attemptId,
        kind: 'contract',
        text: `${signal.detail}. Check the contract in the script before you rely on it.`,
      });
      sent += 1;
    }
    return sent > 0 ? 'notified' : 'limited';
  }

  /** An Actor answered `request_status`: the Director gets the partial state as a prompt. */
  async #statusAnswer(event: EventEnvelope): Promise<void> {
    const payload: unknown = event.payload;
    const output = isRecord(payload) ? payload.output : undefined;
    const result = isRecord(output) ? output.result : undefined;
    if (!isRecord(result) || result.state !== 'status') return;
    const runtime = this.#runtime;
    const { playId, attemptId } = event;
    if (runtime === undefined || playId === undefined || attemptId === undefined) return;
    const watched = this.detector.watched(attemptId);
    const scenarioId = await this.#scenarioOf(playId);
    if (watched === undefined || scenarioId === undefined) return;
    await runtime.directors.ensure(scenarioId);
    await runtime.dispatcher.submit({
      scenarioId,
      source: 'daemon',
      text: statusAnswerPrompt(playId, attemptId, watched.demandId, JSON.stringify(result)),
    });
  }

  async #scenarioOf(playId: string): Promise<string | undefined> {
    return (await this.#deps.store.plays.get(playId))?.scenarioId;
  }

  async #limit(
    limit: SupervisionLimit,
    watched: Pick<WatchedAttempt, 'playId' | 'demandId' | 'attemptId'>,
    value: number,
    max: number,
  ): Promise<void> {
    await this.channel.record(
      'supervision.limit_reached',
      { limit, demandId: watched.demandId, value, max },
      watched.playId,
      watched.attemptId,
    );
  }

  // ---- the tools of the Director ----

  /** Registers the four tools of the supervision, skipping a name that has a handler. */
  register(handlers: ToolHandlers): ToolHandlers {
    const mine: Record<string, (call: ToolCall) => unknown> = {
      warn_actor: (call) => this.#tool(call, (ctx) => this.#warn(ctx, 'warn')),
      redirect_actor: (call) => this.#tool(call, (ctx) => this.#warn(ctx, 'redirect')),
      broadcast: (call) => this.#tool(call, (ctx) => this.#broadcast(ctx)),
      request_status: (call) => this.#tool(call, (ctx) => this.#requestStatus(ctx)),
    };
    for (const [name, handler] of Object.entries(mine)) {
      if (!handlers.has(name)) handlers.register(name, handler);
    }
    return handlers;
  }

  async #tool(call: ToolCall, run: (context: ToolContext) => Promise<unknown>): Promise<unknown> {
    const runtime = this.#runtime;
    if (runtime === undefined) {
      return failure(
        'not_ready',
        'The daemon is still starting (or already stopping): try again in a moment.',
      );
    }
    const scenarioId = runtime.directors.scenarioOf(call.caller.attemptId);
    if (scenarioId === undefined) {
      return failure(
        'no_scenario',
        `${call.tool.name} is a tool of the Director of a scenario, and this session is not one.`,
      );
    }
    const settings = this.#deps.settings();
    if (settings.mode === 'off' || settings.mode === 'log') {
      return failure(
        'supervision_off',
        `${call.tool.name}: the supervision is ${settings.mode} (supervision.mode); the Director sends no messages.`,
      );
    }
    return await run({ call, runtime, scenarioId, settings });
  }

  /** The running attempt of this scenario a tool names, or the refusal. */
  async #target(
    context: ToolContext,
    attemptId: string,
  ): Promise<ToolFailure | { readonly playId: string; readonly demandId: string }> {
    const record = await this.#deps.store.attempts.get(attemptId);
    const play = record === undefined ? undefined : await this.#deps.store.plays.get(record.playId);
    if (record === undefined || play?.scenarioId !== context.scenarioId) {
      return failure('not_found', `There is no attempt ${attemptId} in this scenario.`);
    }
    if (!ACTIVE_STATES.has(record.state)) {
      return failure('not_running', `The attempt ${attemptId} is not running (${record.state}).`);
    }
    return { playId: record.playId, demandId: record.demandId };
  }

  async #warn(context: ToolContext, kind: 'warn' | 'redirect'): Promise<unknown> {
    const { attemptId, text } = context.call.input as { attemptId: string; text: string };
    const { settings, runtime } = context;
    if (kind === 'redirect' && settings.mode !== 'redirect') {
      return failure(
        'mode_too_low',
        'redirect_actor needs supervision.mode: redirect; use warn_actor, or cancel_actor to stop the attempt.',
      );
    }
    const target = await this.#target(context, attemptId);
    if (target instanceof ToolFailure) return target;
    const used = await this.channel.warnings(target.playId, target.demandId);
    if (used >= settings.max_warnings_per_demand) {
      const limit = { playId: target.playId, demandId: target.demandId, attemptId };
      await this.#limit(
        'max_warnings_per_demand',
        limit,
        used + 1,
        settings.max_warnings_per_demand,
      );
      return failure(
        'limit_reached',
        `This demand already got ${String(used)} warnings, the most allowed (supervision.max_warnings_per_demand).`,
        { limit: 'max_warnings_per_demand', max: settings.max_warnings_per_demand },
      );
    }
    // [proposta] delivery `relaunch` makes every warning a redirect, when the mode allows one
    const relaunch =
      kind === 'redirect' || (settings.delivery === 'relaunch' && settings.mode === 'redirect');
    const notice = await this.channel.queue({
      ...target,
      attemptId,
      kind: relaunch ? 'redirect' : 'warn',
      text,
    });
    if (!relaunch) {
      return {
        ok: true,
        noticeId: notice.noticeId,
        via: settings.delivery === 'next_turn' ? 'next_turn' : 'tool_reply',
      };
    }
    this.#redirects.set(attemptId, { demand: `${target.playId}/${target.demandId}`, text });
    await this.channel.record(
      'supervision.redirect',
      { demandId: target.demandId, text: clipText(text) },
      target.playId,
      attemptId,
    );
    await runtime.cancelAttempt(attemptId);
    return { ok: true, noticeId: notice.noticeId, via: 'relaunch' };
  }

  async #broadcast(context: ToolContext): Promise<unknown> {
    const { text, play } = context.call.input as { text: string; play?: string };
    const { settings } = context;
    if (settings.broadcast === 'off') {
      return failure('broadcast_off', 'broadcast is off (supervision.broadcast).');
    }
    const open = (
      await this.#deps.store.plays.list({ scenarioId: context.scenarioId, open: true })
    ).map((record) => record.id);
    const playId = play ?? (open.length === 1 ? open[0] : undefined);
    if (playId === undefined) {
      return failure(
        open.length === 0 ? 'not_found' : 'play_required',
        open.length === 0
          ? 'The scenario has no play running.'
          : 'Several plays are running: say which one with `play`.',
      );
    }
    if (!open.includes(playId)) {
      return failure('not_found', `There is no running play ${playId} in this scenario.`);
    }
    const used = this.channel.broadcasts(playId);
    if (used >= settings.max_warnings_per_demand) {
      await this.channel.record(
        'supervision.limit_reached',
        {
          limit: 'broadcast',
          demandId: null,
          value: used + 1,
          max: settings.max_warnings_per_demand,
        },
        playId,
      );
      return failure(
        'limit_reached',
        `This play already got ${String(used)} broadcasts, the most allowed.`,
        {
          limit: 'broadcast',
          max: settings.max_warnings_per_demand,
        },
      );
    }
    const recipients = this.detector.attempts(playId);
    for (const watched of recipients) {
      await this.channel.queue({
        playId,
        demandId: watched.demandId,
        attemptId: watched.attemptId,
        kind: 'broadcast',
        text,
      });
    }
    if (recipients.length > 0) this.channel.countBroadcast(playId);
    await this.channel.record(
      'supervision.broadcast',
      {
        recipients: recipients.length,
        attemptIds: recipients.map((watched) => watched.attemptId),
        text: clipText(text),
      },
      playId,
    );
    return { ok: true, recipients: recipients.length };
  }

  async #requestStatus(context: ToolContext): Promise<unknown> {
    const { attemptId } = context.call.input as { attemptId: string };
    const { settings } = context;
    if (settings.status_request === 'off') {
      return failure('status_request_off', 'request_status is off (supervision.status_request).');
    }
    const target = await this.#target(context, attemptId);
    if (target instanceof ToolFailure) return target;
    const used = await this.channel.statusRequests(target.playId, target.demandId);
    if (used >= settings.max_warnings_per_demand) {
      await this.#limit(
        'status_request',
        { ...target, attemptId },
        used + 1,
        settings.max_warnings_per_demand,
      );
      return failure(
        'limit_reached',
        `This demand already got ${String(used)} status requests, the most allowed.`,
        {
          limit: 'status_request',
          max: settings.max_warnings_per_demand,
        },
      );
    }
    const notice = await this.channel.queue({
      ...target,
      attemptId,
      kind: 'status_request',
      text: STATUS_REQUEST_TEXT,
    });
    await this.channel.record(
      'supervision.status_requested',
      { demandId: target.demandId, noticeId: notice.noticeId },
      target.playId,
      attemptId,
    );
    return {
      ok: true,
      noticeId: notice.noticeId,
      via: settings.delivery === 'next_turn' ? 'next_turn' : 'tool_reply',
    };
  }
}

interface ToolContext {
  readonly call: ToolCall;
  readonly runtime: SupervisionRuntime;
  readonly scenarioId: string;
  readonly settings: SupervisionSettings;
}

/** A step of the play for the budget: a tool call, a permission request, a tool call of the client. */
function isStep(event: EventEnvelope): boolean {
  if (event.type === 'tool.called' || event.type === 'permission.asked') return true;
  if (event.type !== 'session.update') return false;
  const payload: unknown = event.payload;
  const update = isRecord(payload) ? payload.update : undefined;
  return isRecord(update) && update.kind === 'tool_call';
}
