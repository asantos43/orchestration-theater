// SPDX-License-Identifier: MPL-2.0
import type { EventEnvelope, Script } from '@otheater/core';
import type { SupervisionSignal } from '@otheater/protocol';
import type { SupervisionSettings } from './config.js';

/**
 * The deterministic signals of the Director's supervision (N309; plan of Phase 11b, P14). They
 * come from what the daemon already sees, with no model: the permissions an Actor asks and the
 * files its tool calls touch, the tests it runs, the contracts of the script and the time it has
 * spent. [proposta] The rules of each signal are below; the Director is called only when one fires.
 */

/** An attempt the supervision follows: what is needed to judge its events. */
export interface WatchedAttempt {
  readonly attemptId: string;
  readonly playId: string;
  readonly demandId: string;
  /** Absolute path of the worktree of the attempt. */
  readonly worktree: string;
  /** Epoch ms when the supervision first saw the attempt. */
  readonly startedAt: number;
  /** `expectedFiles` of the demand (a trailing "/" is a directory; `*` and `**` are globs). */
  readonly expectedFiles: readonly string[];
  /** The contracts the demand cites, as inputs and as outputs. */
  readonly contracts: readonly string[];
  /** The time of the demand, in ms (`timeoutMin` or `limits.demand_timeout`). */
  readonly timeoutMs: number;
}

/** A signal that fired. `key` is what it is deduplicated by, per attempt (or per play). */
export interface DetectedSignal {
  readonly signal: SupervisionSignal;
  readonly playId: string;
  readonly demandId: string | null;
  /** The attempts it is about (more than one only for `contract_changed`). */
  readonly attemptIds: readonly string[];
  readonly detail: string;
  readonly key: string;
}

/** The kinds of permission request that change a file. */
const EDIT_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move']);

/** Paths the signal never looks at: the repository's own data and installed packages. */
const IGNORED_PREFIXES = ['.git/', 'node_modules/'];

/** How many paths one `outside_demand` signal lists. */
const DETAIL_PATHS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slashes(path: string): string {
  return path.replaceAll('\\', '/');
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

/**
 * `path` relative to `worktree` with forward slashes, or `undefined` when it is outside the
 * worktree (the permission layer owns that, it is not a deviation from the demand) or is one of
 * the ignored places. A relative path is taken as already relative to the worktree.
 */
export function worktreeRelative(path: string, worktree: string): string | undefined {
  const flat = slashes(path);
  const root = slashes(worktree).replace(/\/+$/, '');
  let relative: string;
  if (isAbsolute(flat)) {
    const same = flat.toLowerCase().startsWith(`${root.toLowerCase()}/`);
    if (!same) return undefined;
    relative = flat.slice(root.length + 1);
  } else {
    relative = flat.replace(/^(\.\/)+/, '');
  }
  if (relative === '' || relative === '..' || relative.startsWith('../')) return undefined;
  if (IGNORED_PREFIXES.some((prefix) => `${relative}/`.startsWith(prefix))) return undefined;
  return relative;
}

function globRegex(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    if (char === '*') {
      if (pattern.charAt(i + 1) === '*') {
        i += 1;
        if (pattern.charAt(i + 1) === '/') i += 1;
        source += '(?:.*/)?';
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Whether `relative` (a path inside the worktree) is one of the demand's `expectedFiles`: the
 * same file, a file under a directory entry ("src/" or "src"), or a match of a glob entry.
 * [proposta] A demand with no `expectedFiles` says nothing, so nothing is outside it.
 */
export function isExpectedFile(relative: string, expectedFiles: readonly string[]): boolean {
  if (expectedFiles.length === 0) return true;
  for (const raw of expectedFiles) {
    const entry = slashes(raw).replace(/^(\.\/)+/, '');
    if (entry === '') continue;
    if (entry.endsWith('/')) {
      if (relative.startsWith(entry)) return true;
    } else if (/[*?]/.test(entry)) {
      if (globRegex(entry).test(relative)) return true;
    } else if (relative === entry || relative.startsWith(`${entry}/`)) {
      return true;
    }
  }
  return false;
}

/** The ids of the contracts of `after` that are new, gone or changed against `before`. */
export function changedContracts(before: Script | undefined, after: Script): readonly string[] {
  if (before === undefined) return [];
  const was = new Map(before.contracts.map((contract) => [contract.id, contract]));
  const now = new Map(after.contracts.map((contract) => [contract.id, contract]));
  const changed = new Set<string>();
  for (const [id, contract] of now) {
    const old = was.get(id);
    if (
      old?.title !== contract.title ||
      old.description !== contract.description ||
      old.kind !== contract.kind
    ) {
      changed.add(id);
    }
  }
  for (const id of was.keys()) {
    if (!now.has(id)) changed.add(id);
  }
  return [...changed].sort();
}

/** The paths an event says an Actor is about to change, relative to its worktree. */
function editedPaths(event: EventEnvelope, watched: WatchedAttempt): readonly string[] {
  const payload: unknown = event.payload;
  if (!isRecord(payload)) return [];
  let raw: readonly unknown[] = [];
  if (event.type === 'permission.asked') {
    if (typeof payload.kind === 'string' && EDIT_KINDS.has(payload.kind)) {
      raw = Array.isArray(payload.paths) ? payload.paths : [];
    }
  } else if (event.type === 'session.update') {
    const update = payload.update;
    if (
      isRecord(update) &&
      (update.kind === 'tool_call' || update.kind === 'tool_call_update') &&
      typeof update.toolKind === 'string' &&
      EDIT_KINDS.has(update.toolKind) &&
      Array.isArray(update.locations)
    ) {
      raw = update.locations.map((location: unknown) =>
        isRecord(location) ? location.path : undefined,
      );
    }
  }
  const found: string[] = [];
  for (const path of raw) {
    if (typeof path !== 'string') continue;
    const relative = worktreeRelative(path, watched.worktree);
    if (relative !== undefined) found.push(relative);
  }
  return found;
}

/** The streak of one attempt in `run_tests`: the same call (by its summary) failing in a row. */
interface TestStreak {
  summary: string;
  count: number;
}

/** What the detector keeps for one attempt. */
interface AttemptState {
  readonly watched: WatchedAttempt;
  readonly seenPaths: Set<string>;
  readonly summaries: Map<string, string>;
  readonly fired: Set<string>;
  streak: TestStreak | undefined;
}

/**
 * Looks at the events of the attempts that are running and says which signals fired. It holds no
 * clock and no store: the service feeds it the attempts ({@link add}), the events ({@link inspect})
 * and the time ({@link elapsed}). A signal fires once per attempt and subject (a path, a test, the
 * budget): [proposta] repeating it would only spend the limit of the Director.
 */
export class SignalDetector {
  readonly #settings: () => SupervisionSettings;
  readonly #attempts = new Map<string, AttemptState>();

  constructor(settings: () => SupervisionSettings) {
    this.#settings = settings;
  }

  add(watched: WatchedAttempt): void {
    if (this.#attempts.has(watched.attemptId)) return;
    this.#attempts.set(watched.attemptId, {
      watched,
      seenPaths: new Set(),
      summaries: new Map(),
      fired: new Set(),
      streak: undefined,
    });
  }

  remove(attemptId: string): void {
    this.#attempts.delete(attemptId);
  }

  has(attemptId: string): boolean {
    return this.#attempts.has(attemptId);
  }

  watched(attemptId: string): WatchedAttempt | undefined {
    return this.#attempts.get(attemptId)?.watched;
  }

  /** The attempts followed now, optionally only the ones of one play. */
  attempts(playId?: string): readonly WatchedAttempt[] {
    const all = [...this.#attempts.values()].map((state) => state.watched);
    return playId === undefined ? all : all.filter((watched) => watched.playId === playId);
  }

  /** The signals one event of an attempt makes fire: `outside_demand` and `test_loop`. */
  inspect(event: EventEnvelope): readonly DetectedSignal[] {
    const { attemptId } = event;
    const state = attemptId === undefined ? undefined : this.#attempts.get(attemptId);
    if (state === undefined) return [];
    const { triggers } = this.#settings();
    const signals: DetectedSignal[] = [];
    if (triggers.outside_demand === 'on') {
      const fresh: string[] = [];
      for (const path of editedPaths(event, state.watched)) {
        if (state.seenPaths.has(path)) continue;
        state.seenPaths.add(path);
        if (!isExpectedFile(path, state.watched.expectedFiles)) fresh.push(path);
      }
      if (fresh.length > 0) {
        const listed = fresh.slice(0, DETAIL_PATHS).join(', ');
        const more =
          fresh.length > DETAIL_PATHS ? ` and ${String(fresh.length - DETAIL_PATHS)} more` : '';
        signals.push(
          this.#signal(
            state,
            'outside_demand',
            `edited outside the demand: ${listed}${more}`,
            `outside:${fresh.join('|')}`,
          ),
        );
      }
    }
    if (triggers.test_loop !== 'off') {
      const loop = this.#testLoop(state, event, triggers.test_loop);
      if (loop !== undefined) signals.push(loop);
    }
    return signals.filter((signal) => this.#once(state, signal.key));
  }

  /** `budget_fraction`: the attempts that have spent the fraction of their time, once each. */
  elapsed(now: number): readonly DetectedSignal[] {
    const { triggers } = this.#settings();
    if (triggers.budget_fraction === 'off') return [];
    const signals: DetectedSignal[] = [];
    for (const state of this.#attempts.values()) {
      const { watched } = state;
      if (watched.timeoutMs <= 0) continue;
      const spent = (now - watched.startedAt) / watched.timeoutMs;
      if (spent < triggers.budget_fraction) continue;
      const signal = this.#signal(
        state,
        'budget_fraction',
        `${String(Math.round(spent * 100))}% of the time of the demand is spent (the limit is ${String(Math.round(triggers.budget_fraction * 100))}%)`,
        'budget',
      );
      if (this.#once(state, signal.key)) signals.push(signal);
    }
    return signals;
  }

  /**
   * `contract_changed`: the running attempts of `playId` whose demand cites one of `changed`. One
   * signal per play and set of contracts, with every affected attempt; none when no one depends on
   * them. Dedup is the caller's: the same change is not announced twice.
   */
  contractChanged(playId: string, changed: readonly string[]): DetectedSignal | undefined {
    if (changed.length === 0 || this.#settings().triggers.contract_changed !== 'on')
      return undefined;
    const affected = this.attempts(playId).filter((watched) =>
      watched.contracts.some((contract) => changed.includes(contract)),
    );
    if (affected.length === 0) return undefined;
    return {
      signal: 'contract_changed',
      playId,
      demandId: affected.length === 1 ? (affected[0]?.demandId ?? null) : null,
      attemptIds: affected.map((watched) => watched.attemptId),
      detail: `the contract ${changed.join(', ')} changed in the script`,
      key: `contract:${changed.join('|')}`,
    };
  }

  #testLoop(state: AttemptState, event: EventEnvelope, limit: number): DetectedSignal | undefined {
    if (event.type !== 'tool.called' && event.type !== 'tool.finished') return undefined;
    const payload: unknown = event.payload;
    if (!isRecord(payload) || payload.tool !== 'run_tests' || typeof payload.callId !== 'string') {
      return undefined;
    }
    if (event.type === 'tool.called') {
      state.summaries.set(
        payload.callId,
        typeof payload.summary === 'string' ? payload.summary : 'run_tests',
      );
      return undefined;
    }
    const summary = state.summaries.get(payload.callId) ?? 'run_tests';
    state.summaries.delete(payload.callId);
    if (payload.outcome !== 'failed') {
      state.streak = undefined;
      return undefined;
    }
    const streak = state.streak?.summary === summary ? state.streak : { summary, count: 0 };
    streak.count += 1;
    state.streak = streak;
    if (streak.count !== limit) return undefined;
    return this.#signal(
      state,
      'test_loop',
      `${summary} failed ${String(limit)} times in a row`,
      `tests:${summary}`,
    );
  }

  #signal(
    state: AttemptState,
    signal: SupervisionSignal,
    detail: string,
    key: string,
  ): DetectedSignal {
    const { watched } = state;
    return {
      signal,
      playId: watched.playId,
      demandId: watched.demandId,
      attemptIds: [watched.attemptId],
      detail,
      key,
    };
  }

  #once(state: AttemptState, key: string): boolean {
    if (state.fired.has(key)) return false;
    state.fired.add(key);
    return true;
  }
}
