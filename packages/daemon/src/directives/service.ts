// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import {
  directiveStateAt,
  formatInTimezone,
  hasErrorCode,
  isKnownTimezone,
  nextBoundary,
  OTheaterError,
  renderContinuationOrders,
  resolveRule,
  validitiesOverlap,
  type Clock,
  type DecisionRecord,
  type DirectiveOrigin,
  type DirectiveRecord,
  type DirectiveState,
  type NewDirective,
  type NewEvent,
  type Registry,
  type RuleKeyDefinition,
  type Store,
} from '@otheater/core';
import { buildDaemonEvent } from '@otheater/protocol';
import type { Logger } from '../logger.js';
import { ToolFailure } from '../mcp/handlers.js';
import {
  checkValidityText,
  DRAFT_DECISION_KIND,
  DraftSpecSchema,
  resolveValidity,
  type DraftSpec,
  type ResolvedValidity,
  type ValidityText,
} from './spec.js';

/** The longest the watcher sleeps, so a clock jump is noticed within the hour. [proposta] */
export const WATCH_MAX_SLEEP_MS = 3_600_000;

/** The shortest it sleeps, so a boundary that is already past cannot make the loop spin. */
export const WATCH_MIN_SLEEP_MS = 1000;

export interface DirectiveSettings {
  /** Time zone of an order that does not name one (`directives.timezone`). */
  readonly timezone: string;
  /** Advance of the "ends soon" notice in ms; 0 turns it off (`directives.expiring_notice`). */
  readonly expiringNoticeMs: number;
}

export interface DirectiveServiceOptions {
  readonly store: Pick<Store, 'events' | 'directives' | 'decisions' | 'plays'>;
  readonly clock: Clock;
  readonly ruleKeys: Registry<RuleKeyDefinition>;
  readonly settings: DirectiveSettings;
  readonly logger: Logger;
}

/** What it takes to write an order directly (the Producer at the terminal, or a confirmed draft). */
export interface DirectiveInput {
  readonly text: string;
  readonly scope: 'global' | 'local';
  readonly scenarioId?: string | null | undefined;
  readonly kind?: 'instruction' | 'rule' | 'suspension' | undefined;
  readonly roles?: readonly string[] | undefined;
  readonly ruleKey?: string | null | undefined;
  readonly ruleValue?: unknown;
  readonly suspendsId?: string | null | undefined;
  readonly replacesId?: string | null | undefined;
  readonly timezone?: string | undefined;
  readonly validity?: ValidityText | undefined;
}

type CreateSpec = Extract<DraftSpec, { action: 'create' }>;

/** A draft that waits for the Producer (a pending `decisions` row of kind `directive_draft`). */
export interface DraftView {
  readonly draftId: string;
  readonly scenarioId: string;
  readonly preview: Record<string, unknown>;
  /** The orders a `rule` draft clashes with; a draft with conflicts cannot be confirmed. */
  readonly conflicts: readonly string[];
  readonly createdAt: number;
}

/** What the Producer may change in a draft before confirming it. */
export interface DraftEdits {
  readonly text?: string | undefined;
  readonly validity?: ValidityText | undefined;
}

/** The scenario and the play a draft belongs to (a decision needs a scenario). */
export interface DraftContext {
  readonly scenarioId: string;
  readonly playId?: string | undefined;
}

/** Stable view of an order for the tools and the CLI. */
export function summarizeDirective(d: DirectiveRecord): Record<string, unknown> {
  return {
    id: d.id,
    scope: d.scope,
    scenarioId: d.scenarioId,
    kind: d.kind,
    text: d.text,
    roles: d.roles,
    ruleKey: d.ruleKey,
    ruleValue: d.ruleValue,
    suspendsId: d.suspendsId,
    replacesId: d.replacesId,
    state: d.state,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    timezone: d.timezone,
    from: formatInTimezone(d.startsAt, d.timezone),
    until: d.endsAt === null ? null : formatInTimezone(d.endsAt, d.timezone),
    revokeReason: d.revokeReason,
  };
}

function refuse(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new ToolFailure(code, message, details);
}

/** Turns an error of the store into one the caller of a tool can read. */
export function asToolFailure(error: unknown): unknown {
  if (error instanceof ToolFailure) return error;
  if (error instanceof OTheaterError) {
    const code = String(error.code as unknown);
    return new ToolFailure(code.toLowerCase(), error.message);
  }
  return error;
}

function rolesIntersect(a: readonly string[], b: readonly string[]): boolean {
  return a.length === 0 || b.length === 0 || a.some((role) => b.includes(role));
}

/** Who a rule is about when its value names a role (`roles.executors`, `roles.when_exhausted`). */
function ruleSubject(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'role' in value) {
    const { role } = value;
    return typeof role === 'string' ? role : undefined;
  }
  return undefined;
}

/**
 * The orders (architecture 5.17): writes them, keeps their state in step with the clock and
 * records `directive.*` events. The validity itself is a pure function of the clock
 * (`directiveStateAt`); nothing here is a timer that decides. The watcher only wakes the service
 * at the next boundary so the events come out on time, and a restart finds what it missed by
 * comparing the stored state with the clock, so a boundary crossed while the daemon was stopped
 * still gets its event, with the real boundary time.
 *
 * Drafts: the Director does not write orders. It leaves a draft (a pending decision) and the
 * Producer confirms, edits or cancels it; only `confirm` creates the order.
 */
export class DirectiveService {
  readonly #options: DirectiveServiceOptions;
  readonly #stop = new AbortController();

  #isStopped(): boolean {
    return this.#stop.signal.aborted;
  }
  #wake = new AbortController();
  #queue: Promise<unknown> = Promise.resolve();
  #loop: Promise<void> | undefined;
  /** `<id>@<endsAt>` of the notices already written (this run, and the log on first need). */
  readonly #noticed = new Set<string>();
  #noticeLogRead = false;

  constructor(options: DirectiveServiceOptions) {
    this.#options = options;
  }

  get #now(): number {
    return this.#options.clock.now();
  }

  // ---- reading ----

  /** The orders in force for a scenario, for `role` when given (suspended globals are out). */
  async inForce(scenarioId: string, role?: string): Promise<readonly DirectiveRecord[]> {
    await this.sync();
    return this.#options.store.directives.inForce({
      scenarioId,
      ...(role === undefined ? {} : { role }),
    });
  }

  /**
   * The value of a configuration key for a scenario and role: the `rule` in force overrides it,
   * and once the rule is revoked or expired the configuration value comes back (5.17).
   */
  async rule<T>(key: string, fallback: T, scenarioId: string, role?: string): Promise<T> {
    return resolveRule(await this.inForce(scenarioId, role), key, fallback, role);
  }

  /** The "Orders in force now" section of a continuation package (`undefined` when none). */
  async continuationOrders(scenarioId: string, role: string): Promise<string | undefined> {
    return renderContinuationOrders(role, await this.inForce(scenarioId, role));
  }

  async get(id: string): Promise<DirectiveRecord | undefined> {
    await this.sync();
    return this.#options.store.directives.get(id);
  }

  /** The orders that reach a scenario (the global ones and its own); every scenario when absent. */
  async list(
    filter: {
      scenarioId?: string | undefined;
      states?: readonly DirectiveState[] | undefined;
    } = {},
  ): Promise<readonly DirectiveRecord[]> {
    await this.sync();
    const all = await this.#options.store.directives.list(
      filter.states === undefined ? {} : { states: filter.states },
    );
    const { scenarioId } = filter;
    return scenarioId === undefined
      ? all
      : all.filter((d) => d.scope === 'global' || d.scenarioId === scenarioId);
  }

  // ---- direct writes (the Producer) ----

  create(input: DirectiveInput, origin: DirectiveOrigin = 'terminal'): Promise<DirectiveRecord> {
    return this.#exclusive(async () => {
      await this.#sync();
      return this.#createNow(this.#specOf(input), origin).then((r) => r.record);
    });
  }

  extend(id: string, validity: ValidityText): Promise<DirectiveRecord> {
    return this.#exclusive(async () => {
      await this.#sync();
      return this.#extendNow(id, validity);
    });
  }

  revoke(id: string, reason: string): Promise<DirectiveRecord> {
    return this.#exclusive(async () => {
      await this.#sync();
      return this.#revokeNow(id, reason);
    });
  }

  // ---- drafts (the Director proposes, the Producer decides) ----

  proposeCreate(input: DirectiveInput, context: DraftContext): Promise<DraftView> {
    return this.#exclusive(async () => {
      await this.#sync();
      const spec = this.#specOf(input);
      const checked = await this.#checkCreate(spec, this.#now);
      return this.#saveDraft(spec, context, checked.conflicts);
    });
  }

  proposeExtend(id: string, validity: ValidityText, context: DraftContext): Promise<DraftView> {
    return this.#exclusive(async () => {
      await this.#sync();
      const current = await this.#need(id);
      if (current.state === 'revoked') refuse('conflict', `The order ${id} was revoked.`);
      checkValidityText(validity, current.timezone);
      const next = resolveValidity(validity, current.timezone, this.#now, current);
      const conflicts = await this.#conflictsOf(current, next);
      return this.#saveDraft({ action: 'extend', directiveId: id, validity }, context, conflicts);
    });
  }

  proposeRevoke(id: string, reason: string, context: DraftContext): Promise<DraftView> {
    return this.#exclusive(async () => {
      await this.#sync();
      const current = await this.#need(id);
      if (current.state === 'revoked') refuse('conflict', `The order ${id} was already revoked.`);
      if (reason.trim() === '') refuse('invalid_input', 'A revocation needs a reason.');
      return this.#saveDraft({ action: 'revoke', directiveId: id, reason }, context, []);
    });
  }

  /** The drafts waiting for the Producer, oldest first. */
  async listDrafts(scenarioId?: string): Promise<readonly DraftView[]> {
    const pending = await this.#options.store.decisions.list({
      kinds: [DRAFT_DECISION_KIND],
      states: ['pending'],
      ...(scenarioId === undefined ? {} : { scenarioId }),
    });
    const views: DraftView[] = [];
    for (const decision of pending) views.push(await this.#viewOf(decision));
    return views;
  }

  /**
   * The Producer confirms a draft, optionally with edits: only now the order exists (or is
   * extended, or revoked). A clash with another rule refuses the confirmation and leaves the
   * draft pending.
   */
  confirmDraft(
    draftId: string,
    options: { origin?: DirectiveOrigin; edits?: DraftEdits } = {},
  ): Promise<{ action: DraftSpec['action']; directive: DirectiveRecord }> {
    return this.#exclusive(async () => {
      await this.#sync();
      const decision = await this.#pendingDraft(draftId);
      const spec = this.#edited(this.#specFrom(decision), options.edits);
      const origin = options.origin ?? 'chat';
      let directive: DirectiveRecord;
      if (spec.action === 'create') {
        directive = (await this.#createNow(spec, origin)).record;
      } else if (spec.action === 'extend') {
        directive = await this.#extendNow(spec.directiveId, spec.validity);
      } else {
        directive = await this.#revokeNow(spec.directiveId, spec.reason);
      }
      await this.#options.store.decisions.decide(draftId, {
        answer: { action: spec.action, directiveId: directive.id, confirmed: true },
        decidedBy: 'producer',
      });
      return { action: spec.action, directive };
    });
  }

  cancelDraft(draftId: string): Promise<void> {
    return this.#exclusive(async () => {
      await this.#pendingDraft(draftId);
      await this.#options.store.decisions.cancel(draftId);
    });
  }

  // ---- the clock ----

  /**
   * Brings the stored states and the log up to the clock: for each order whose stored state is
   * behind, writes `directive.activated` and `directive.expired` with the real boundary time,
   * then the "ends soon" notices that are due. Safe to call at any time and from anywhere.
   */
  sync(): Promise<void> {
    return this.#exclusive(() => this.#sync());
  }

  /**
   * Catches up with what happened while the daemon was stopped and starts the watcher. Resolves
   * once the catch-up is done, so the sessions opened after it see the orders as they are now.
   */
  async start(): Promise<void> {
    await this.sync();
    if (this.#loop !== undefined) return;
    this.#loop = this.#watch().catch((error: unknown) => {
      this.#options.logger.error({ err: error }, 'the directive watcher stopped by itself');
    });
  }

  async stop(): Promise<void> {
    this.#stop.abort(new Error('directive service stopped'));
    await this.#loop;
  }

  /** Tells the watcher the orders changed, so it recomputes the next boundary. */
  #poke(): void {
    this.#wake.abort(new Error('woken'));
    this.#wake = new AbortController();
  }

  async #watch(): Promise<void> {
    const { clock } = this.#options;
    while (!this.#isStopped()) {
      const wake = this.#wake.signal;
      const wait = await this.#nextWait();
      try {
        await clock.sleep(wait, AbortSignal.any([this.#stop.signal, wake]));
      } catch (error) {
        if (!hasErrorCode(error, 'CANCELLED')) throw error;
        if (this.#isStopped()) return;
        continue;
      }
      try {
        await this.sync();
      } catch (error) {
        this.#options.logger.error({ err: error }, 'the directive watcher could not sync');
        await clock.sleep(WATCH_MAX_SLEEP_MS, this.#stop.signal).catch(() => undefined);
      }
    }
  }

  async #nextWait(): Promise<number> {
    const now = this.#now;
    const live = await this.#options.store.directives.list({ states: ['scheduled', 'active'] });
    let next = now + WATCH_MAX_SLEEP_MS;
    for (const d of live) {
      const boundary = nextBoundary(d, now);
      if (boundary !== undefined && boundary < next) next = boundary;
      const notice = this.#noticeAt(d);
      if (notice !== undefined && notice > now && notice < next) next = notice;
    }
    return Math.max(WATCH_MIN_SLEEP_MS, next - now);
  }

  /** When the "ends soon" notice of an order is due; `undefined` when it has none. */
  #noticeAt(d: DirectiveRecord): number | undefined {
    const notice = this.#options.settings.expiringNoticeMs;
    if (notice <= 0 || d.endsAt === null) return undefined;
    // [proposta] An order that lasts less than the notice gets none: it would be born "expiring".
    if (d.endsAt - d.startsAt < notice) return undefined;
    return d.endsAt - notice;
  }

  async #sync(): Promise<void> {
    const { directives } = this.#options.store;
    const now = this.#now;
    const live = await directives.list({ states: ['scheduled', 'active'] });
    const due: { at: number; event: NewEvent }[] = [];
    for (const d of live) {
      const actual = directiveStateAt(d, now);
      if (actual === d.state) continue;
      if (d.state === 'scheduled') {
        due.push({
          at: d.startsAt,
          event: this.#event(d, 'directive.activated', { effectiveAt: d.startsAt }),
        });
        if (d.kind === 'suspension' && d.suspendsId !== null) {
          due.push({ at: d.startsAt, event: this.#suspended(d) });
        }
      }
      if (actual === 'expired' && d.endsAt !== null) {
        due.push({
          at: d.endsAt,
          event: this.#event(d, 'directive.expired', { effectiveAt: d.endsAt }),
        });
      }
    }
    if (due.length > 0) {
      await directives.refreshStates();
      due.sort((a, b) => a.at - b.at);
      for (const { event } of due) await this.#options.store.events.append(event);
    }
    await this.#notices(live, now);
  }

  async #notices(live: readonly DirectiveRecord[], now: number): Promise<void> {
    const candidates = live.filter((d) => {
      const at = this.#noticeAt(d);
      return at !== undefined && now >= at && d.endsAt !== null && now < d.endsAt;
    });
    if (candidates.length === 0) return;
    await this.#readNoticeLog();
    for (const d of candidates) {
      const key = `${d.id}@${String(d.endsAt)}`;
      if (this.#noticed.has(key) || d.endsAt === null) continue;
      this.#noticed.add(key);
      await this.#options.store.events.append(
        this.#event(d, 'directive.expiring', {
          endsAt: d.endsAt,
          noticeMs: this.#options.settings.expiringNoticeMs,
        }),
      );
    }
  }

  /** Reads the notices the previous runs wrote, once, so a restart does not repeat them. */
  async #readNoticeLog(): Promise<void> {
    if (this.#noticeLogRead) return;
    this.#noticeLogRead = true;
    const { events } = this.#options.store;
    let after = 0;
    for (;;) {
      const batch = await events.readFrom(after, 500);
      if (batch.length === 0) break;
      for (const event of batch) {
        after = event.id;
        if (event.type !== 'directive.expiring') continue;
        const { directiveId, endsAt } = event.payload;
        if (typeof directiveId === 'string' && typeof endsAt === 'number') {
          this.#noticed.add(`${directiveId}@${String(endsAt)}`);
        }
      }
    }
  }

  // ---- writes (called inside the queue) ----

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run.catch((error: unknown) => {
      throw asToolFailure(error);
    });
  }

  #specOf(input: DirectiveInput): CreateSpec {
    const kind = input.kind ?? 'instruction';
    return {
      action: 'create',
      text: input.text,
      scope: input.scope,
      scenarioId: input.scenarioId ?? null,
      kind,
      roles: [...(input.roles ?? [])],
      ruleKey: input.ruleKey ?? null,
      ruleValue: (input.ruleValue ?? null) as CreateSpec['ruleValue'],
      suspendsId: input.suspendsId ?? null,
      replacesId: input.replacesId ?? null,
      timezone: input.timezone ?? this.#options.settings.timezone,
      validity: input.validity ?? {},
    };
  }

  /** Validates a create spec against the store and the rule keys; gives the row and its clashes. */
  async #checkCreate(
    spec: CreateSpec,
    now: number,
  ): Promise<{ row: NewDirective; conflicts: readonly string[] }> {
    const { directives } = this.#options.store;
    if (spec.text.trim() === '') refuse('invalid_input', 'The order needs a text.');
    if (!isKnownTimezone(spec.timezone)) {
      refuse(
        'invalid_input',
        `"${spec.timezone}" is not a time zone (use America/Sao_Paulo, say).`,
      );
    }
    if (spec.scope === 'local' && spec.scenarioId === null) {
      refuse('invalid_input', 'A local order needs the scenario it is for.');
    }
    if (spec.scope === 'global' && spec.scenarioId !== null) {
      refuse('invalid_input', 'A global order has no scenario.');
    }
    let ruleValue: unknown = null;
    if (spec.kind === 'rule') {
      if (spec.ruleKey === null) refuse('invalid_input', 'A rule needs the key it overrides.');
      const entry = this.#options.ruleKeys.get(spec.ruleKey);
      if (entry === undefined) {
        refuse(
          'unknown_rule_key',
          `"${spec.ruleKey}" is not a key a rule can override. The keys are: ${this.#options.ruleKeys.keys().join(', ')}.`,
        );
      }
      const parsed = entry.value.safeParse(spec.ruleValue);
      if (!parsed.success) {
        refuse(
          'invalid_rule_value',
          `The value for "${spec.ruleKey}" is not valid: ${parsed.error.issues.map((i) => i.message).join('; ')}.`,
        );
      }
      ruleValue = parsed.data;
    } else if (spec.ruleKey !== null || spec.ruleValue !== null) {
      refuse('invalid_input', 'Only a rule carries a key and a value.');
    }
    if (spec.kind === 'suspension') {
      if (spec.scope !== 'local') refuse('invalid_input', 'A suspension is a local order.');
      if (spec.suspendsId === null)
        refuse('invalid_input', 'A suspension names the global order it suspends.');
      const target = await directives.get(spec.suspendsId);
      if (target === undefined) refuse('not_found', `There is no order ${spec.suspendsId}.`);
      if (target.scope !== 'global' || target.kind === 'suspension') {
        refuse(
          'invalid_input',
          `${target.id} is not a global order; only a global order can be suspended.`,
        );
      }
      if (target.state === 'revoked' || target.state === 'expired') {
        refuse('conflict', `${target.id} is already ${target.state}; there is nothing to suspend.`);
      }
    } else if (spec.suspendsId !== null) {
      refuse('invalid_input', 'Only a suspension names an order it suspends.');
    }
    if (spec.replacesId !== null) {
      const old = await directives.get(spec.replacesId);
      if (old === undefined) refuse('not_found', `There is no order ${spec.replacesId}.`);
      if (old.state === 'revoked')
        refuse('conflict', `${old.id} was revoked; it cannot be replaced.`);
    }
    const validity = resolveValidity(spec.validity, spec.timezone, now);
    const row: NewDirective = {
      scope: spec.scope,
      scenarioId: spec.scenarioId,
      kind: spec.kind,
      text: spec.text.trim(),
      ruleKey: spec.ruleKey,
      ruleValue: ruleValue as NewDirective['ruleValue'],
      suspendsId: spec.suspendsId,
      roles: spec.roles,
      startsAt: validity.startsAt,
      endsAt: validity.endsAt,
      timezone: spec.timezone,
      origin: 'chat',
      replacesId: spec.replacesId,
    };
    const conflicts = await this.#conflictsOf({ ...row, id: undefined }, validity);
    return { row, conflicts };
  }

  /**
   * The orders a rule would clash with (5.17): another `rule` on the same key, in the same
   * scope and scenario, for the same role, whose validity overlaps and whose value differs. The
   * order it replaces, and itself, do not count. [proposta] Two rules that say the same thing do
   * not clash; for a key whose value names a role (`roles.executors`), only rules about the same
   * role do.
   */
  async #conflictsOf(
    subject: {
      readonly id: string | undefined;
      readonly scope: DirectiveRecord['scope'];
      readonly scenarioId?: string | null | undefined;
      readonly kind: DirectiveRecord['kind'];
      readonly ruleKey?: string | null | undefined;
      readonly ruleValue?: unknown;
      readonly roles?: readonly string[] | undefined;
      readonly replacesId?: string | null | undefined;
    },
    validity: ResolvedValidity,
  ): Promise<readonly string[]> {
    if (subject.kind !== 'rule' || subject.ruleKey === null || subject.ruleKey === undefined)
      return [];
    const others = await this.#options.store.directives.list({
      kinds: ['rule'],
      states: ['scheduled', 'active'],
    });
    const mine = JSON.stringify(subject.ruleValue ?? null);
    const about = ruleSubject(subject.ruleValue);
    return others
      .filter(
        (o) =>
          o.id !== subject.id &&
          o.id !== subject.replacesId &&
          o.ruleKey === subject.ruleKey &&
          o.scope === subject.scope &&
          (o.scenarioId ?? null) === (subject.scenarioId ?? null) &&
          rolesIntersect(o.roles, subject.roles ?? []) &&
          ruleSubject(o.ruleValue) === about &&
          validitiesOverlap(o, validity) &&
          JSON.stringify(o.ruleValue ?? null) !== mine,
      )
      .map((o) => o.id);
  }

  async #createNow(
    spec: CreateSpec,
    origin: DirectiveOrigin,
  ): Promise<{ record: DirectiveRecord }> {
    const { directives, events } = this.#options.store;
    const { row, conflicts } = await this.#checkCreate(spec, this.#now);
    if (conflicts.length > 0) {
      refuse(
        'conflict',
        `The rule for "${spec.ruleKey ?? ''}" clashes with ${conflicts.join(', ')}, which is in force at the same time. Replace or revoke it first.`,
        { conflicts },
      );
    }
    const record = await directives.create({ ...row, origin });
    await events.append(
      this.#event(record, 'directive.created', {
        scope: record.scope,
        scenarioId: record.scenarioId,
        kind: record.kind,
        roles: [...record.roles],
        startsAt: record.startsAt,
        endsAt: record.endsAt,
        timezone: record.timezone,
        state: record.state,
        origin: record.origin,
        ruleKey: record.ruleKey,
        suspendsId: record.suspendsId,
        replacesId: record.replacesId,
        order: record,
      }),
    );
    if (record.kind === 'suspension' && record.state === 'active') {
      await events.append(this.#suspended(record));
    }
    if (record.replacesId !== null) {
      await this.#revokeNow(record.replacesId, `Replaced by ${record.id}.`);
    }
    this.#poke();
    return { record };
  }

  async #extendNow(id: string, validity: ValidityText): Promise<DirectiveRecord> {
    const { directives, events } = this.#options.store;
    const before = await this.#need(id);
    if (before.state === 'revoked') refuse('conflict', `The order ${id} was revoked.`);
    const next = resolveValidity(validity, before.timezone, this.#now, before);
    const conflicts = await this.#conflictsOf(before, next);
    if (conflicts.length > 0) {
      refuse('conflict', `The new validity of ${id} clashes with ${conflicts.join(', ')}.`, {
        conflicts,
      });
    }
    const after = await directives.extend(id, next);
    await events.append(
      this.#event(after, 'directive.validity_changed', {
        startsAt: after.startsAt,
        endsAt: after.endsAt,
        previousStartsAt: before.startsAt,
        previousEndsAt: before.endsAt,
      }),
    );
    if (after.state !== before.state) {
      if (after.state === 'active') {
        await events.append(this.#event(after, 'directive.activated', { effectiveAt: this.#now }));
        if (after.kind === 'suspension' && after.suspendsId !== null) {
          await events.append(this.#suspended(after));
        }
      } else if (after.state === 'expired') {
        await events.append(this.#event(after, 'directive.expired', { effectiveAt: this.#now }));
      }
    }
    this.#poke();
    return after;
  }

  async #revokeNow(id: string, reason: string): Promise<DirectiveRecord> {
    if (reason.trim() === '') refuse('invalid_input', 'A revocation needs a reason.');
    const record = await this.#options.store.directives.revoke(id, reason.trim());
    await this.#options.store.events.append(
      this.#event(record, 'directive.revoked', {
        reason: record.revokeReason ?? reason.trim(),
        revokedAt: record.revokedAt ?? this.#now,
      }),
    );
    this.#poke();
    return record;
  }

  async #need(id: string): Promise<DirectiveRecord> {
    const record = await this.#options.store.directives.get(id);
    if (record === undefined) refuse('not_found', `There is no order ${id}.`);
    return record;
  }

  // ---- drafts ----

  async #saveDraft(
    spec: DraftSpec,
    context: DraftContext,
    conflicts: readonly string[],
  ): Promise<DraftView> {
    const decision = await this.#options.store.decisions.create({
      id: `draft-${randomUUID().slice(0, 12)}`,
      scenarioId: context.scenarioId,
      ...(context.playId === undefined ? {} : { playId: context.playId }),
      kind: DRAFT_DECISION_KIND,
      input: { spec: spec as unknown as Record<string, never>, conflicts: [...conflicts] },
    });
    return this.#viewOf(decision);
  }

  #specFrom(decision: DecisionRecord): DraftSpec {
    return DraftSpecSchema.parse(decision.input.spec);
  }

  async #viewOf(decision: DecisionRecord): Promise<DraftView> {
    const spec = this.#specFrom(decision);
    const conflicts = Array.isArray(decision.input.conflicts)
      ? decision.input.conflicts.filter((c): c is string => typeof c === 'string')
      : [];
    return {
      draftId: decision.id,
      scenarioId: decision.scenarioId,
      preview: await this.#preview(spec),
      conflicts,
      createdAt: decision.createdAt,
    };
  }

  /** What the Producer sees before confirming: the order with its dates already written out. */
  async #preview(spec: DraftSpec): Promise<Record<string, unknown>> {
    const now = this.#now;
    if (spec.action === 'create') {
      const v = resolveValidity(spec.validity, spec.timezone, now);
      return {
        action: 'create',
        text: spec.text,
        scope: spec.scope,
        scenarioId: spec.scenarioId,
        kind: spec.kind,
        roles: spec.roles,
        ruleKey: spec.ruleKey,
        ruleValue: spec.ruleValue,
        suspendsId: spec.suspendsId,
        replacesId: spec.replacesId,
        timezone: spec.timezone,
        startsAt: v.startsAt,
        endsAt: v.endsAt,
        from: formatInTimezone(v.startsAt, spec.timezone),
        until: v.endsAt === null ? null : formatInTimezone(v.endsAt, spec.timezone),
      };
    }
    const target = await this.#options.store.directives.get(spec.directiveId);
    if (target === undefined) return { action: spec.action, directiveId: spec.directiveId };
    if (spec.action === 'revoke') {
      return { action: 'revoke', directiveId: target.id, text: target.text, reason: spec.reason };
    }
    const v = resolveValidity(spec.validity, target.timezone, now, target);
    return {
      action: 'extend',
      directiveId: target.id,
      text: target.text,
      timezone: target.timezone,
      startsAt: v.startsAt,
      endsAt: v.endsAt,
      from: formatInTimezone(v.startsAt, target.timezone),
      until: v.endsAt === null ? null : formatInTimezone(v.endsAt, target.timezone),
      previousFrom: formatInTimezone(target.startsAt, target.timezone),
      previousUntil:
        target.endsAt === null ? null : formatInTimezone(target.endsAt, target.timezone),
    };
  }

  async #pendingDraft(draftId: string): Promise<DecisionRecord> {
    const decision = await this.#options.store.decisions.get(draftId);
    if (decision?.kind !== DRAFT_DECISION_KIND)
      refuse('not_found', `There is no draft ${draftId}.`);
    if (decision.state !== 'pending') {
      refuse('conflict', `The draft ${draftId} is already ${decision.state}.`);
    }
    return decision;
  }

  #edited(spec: DraftSpec, edits: DraftEdits | undefined): DraftSpec {
    if (edits === undefined) return spec;
    if (spec.action === 'revoke') return spec;
    const validity = edits.validity ?? spec.validity;
    if (spec.action === 'extend') return { ...spec, validity };
    return { ...spec, text: edits.text ?? spec.text, validity };
  }

  // ---- events ----

  #event(
    d: DirectiveRecord,
    type:
      | 'directive.created'
      | 'directive.activated'
      | 'directive.validity_changed'
      | 'directive.expiring'
      | 'directive.expired'
      | 'directive.revoked',
    fields: Record<string, unknown>,
  ): NewEvent {
    const event = buildDaemonEvent(type, { directiveId: d.id, ...fields } as never);
    return d.scenarioId === null ? event : { ...event, scenarioId: d.scenarioId };
  }

  #suspended(d: DirectiveRecord): NewEvent {
    const event = buildDaemonEvent('directive.suspended', {
      directiveId: d.id,
      suspendsId: d.suspendsId ?? '',
      scenarioId: d.scenarioId ?? '',
    });
    return d.scenarioId === null ? event : { ...event, scenarioId: d.scenarioId };
  }
}
