// SPDX-License-Identifier: MPL-2.0
import type { Disposable } from './disposable.js';
import {
  AdapterUnavailable,
  Conflict,
  isOTheaterError,
  PermissionDenied,
  QuotaExhausted,
  Transient,
  type KnownOTheaterError,
  type OTheaterError,
} from './errors.js';
import type {
  ConfigValue,
  ContentBlock,
  NormalizedUpdate,
  StopReason,
} from './normalized-update.js';
import type {
  AgentSession,
  NormalizedError,
  PromptOutcome,
  RawUpdate,
  SessionNormalizer,
  UpdateListener,
} from './ports/agent-session.js';
import type { CancelOutcome, LaunchedProcess } from './ports/process-launcher.js';

/** Default wait for the client to end a cancelled turn by itself before its process tree is killed. [proposta] */
export const DEFAULT_CANCEL_GRACE_MS = 2000;

/**
 * Turns the normalized error of a client into the typed error of the ports (architecture 5.2,
 * "Casca de agente"; 5.18, rule 4). The `NormalizedError` stays in `cause`, so the reset time of a
 * quota (`resetsAt`) and the original error travel with the typed one. [proposta] mapping:
 * `quota_exhausted` to `QuotaExhausted`; `auth_required`, `permission` and `refusal` to
 * `PermissionDenied`; `transient`, `stuck` and `unknown` to `Transient`; `client_crash` to
 * `AdapterUnavailable`.
 */
export function typedErrorOf(error: NormalizedError): KnownOTheaterError {
  const options = { cause: error };
  switch (error.kind) {
    case 'quota_exhausted':
      return new QuotaExhausted(error.message, options);
    case 'auth_required':
    case 'permission':
    case 'refusal':
      return new PermissionDenied(error.message, options);
    case 'client_crash':
      return new AdapterUnavailable(error.message, options);
    case 'transient':
    case 'stuck':
    case 'unknown':
      return new Transient(error.message, options);
  }
}

/**
 * What a transport implements for {@link ManagedAgentSession}: the few calls that depend on the
 * wire (ACP, a headless client...). Everything the `AgentSession` contract asks beyond that
 * (one prompt at a time, listeners, cancel that ends the process tree, close) is written once in
 * the session. A driver may reject with a typed OTheater error, which goes through as it is; any
 * other rejection is turned into one by the `SessionNormalizer`.
 */
export interface SessionDriver {
  /** One prompt turn. Resolves with the stop reason of the client; the updates go to {@link ManagedAgentSession.deliver}. */
  runTurn(blocks: readonly ContentBlock[]): Promise<StopReason>;
  /** Asks the client to stop the running turn (ACP `session/cancel`). Best effort: a rejection is ignored. */
  requestCancel(): Promise<void>;
  /** Changes a session config option; rejects with `InvalidInput` for an id or value the client does not offer. */
  applyConfig(id: string, value: ConfigValue): Promise<void>;
  /** Drops the connection to the client without touching the process. Idempotent. */
  disconnect(): void;
}

/** Something the session swallowed so it would not break: a listener or the normalizer threw. */
export interface SessionWarning {
  readonly kind: 'listener_threw' | 'normalizer_threw';
  readonly error: unknown;
}

export interface ManagedSessionOptions {
  readonly sessionId: string;
  readonly canLoad: boolean;
  readonly driver: SessionDriver;
  /** The client process behind the session (one session per process). */
  readonly process: LaunchedProcess;
  readonly normalizer: SessionNormalizer;
  /** Wait after `session/cancel` before the tree is killed anyway. Default {@link DEFAULT_CANCEL_GRACE_MS}. */
  readonly cancelGraceMs?: number;
  /** Wait between the polite signal and the forced kill (`KillOptions.graceMs`). */
  readonly killGraceMs?: number;
  readonly onWarning?: (warning: SessionWarning) => void;
}

type EndedBy = 'close' | 'cancel' | 'exit';

/** Waits for `promise` to settle, at most `ms`; never rejects. Tells whether it settled in time. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function noop(): void {
  // Nothing to do.
}

/** A macrotask: whatever the wire already delivered has been handled when it passes. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * The `AgentSession` of a client that runs as a process of its own, whatever the transport
 * (architecture 5.2, "Casca de agente", and 5.18). It owns the parts of the contract that must be
 * the same for every client: `Conflict` for a second prompt, listeners that cannot break the
 * session, `cancel` that does not trust the client alone and ends the process tree, `close` that
 * releases the process, and `AdapterUnavailable` for every call after the end. A transport only
 * supplies a {@link SessionDriver} and feeds the raw updates to {@link deliver}.
 *
 * [proposta] This helper is not in the architecture text; it keeps the `AcpTransport` and the
 * future `HeadlessTransport` from writing the contract twice.
 */
export class ManagedAgentSession implements AgentSession {
  readonly sessionId: string;
  readonly canLoad: boolean;
  readonly #driver: SessionDriver;
  readonly #process: LaunchedProcess;
  readonly #normalizer: SessionNormalizer;
  readonly #cancelGraceMs: number;
  readonly #killGraceMs: number | undefined;
  readonly #onWarning: ((warning: SessionWarning) => void) | undefined;
  readonly #listeners = new Set<UpdateListener>();
  #endedBy: EndedBy | undefined;
  #turn: Promise<unknown> | undefined;
  #cancelRequested = false;
  #cancelling: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  /**
   * Settles when the session let go of its process. On a process shared with other sessions the
   * client's pending `session/prompt` request is not ended by that (the connection stays up for the
   * others), so a turn the client never answers would never return; `prompt` stops waiting for it.
   */
  #abandon: () => void = noop;
  readonly #abandoned = new Promise<void>((resolve) => {
    this.#abandon = resolve;
  });

  constructor(options: ManagedSessionOptions) {
    this.sessionId = options.sessionId;
    this.canLoad = options.canLoad;
    this.#driver = options.driver;
    this.#process = options.process;
    this.#normalizer = options.normalizer;
    this.#cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.#killGraceMs = options.killGraceMs;
    this.#onWarning = options.onWarning;
    void options.process.exited.then(() => {
      if (this.#endedBy === undefined) {
        this.#endedBy = 'exit';
        this.#driver.disconnect();
      }
    });
  }

  /**
   * Feeds one raw message of the client: it is normalized and handed to the listeners. A message
   * the normalizer swallows (`null`), or that makes it throw, reaches nobody.
   */
  deliver(raw: RawUpdate): void {
    let update: NormalizedUpdate | null;
    try {
      update = this.#normalizer.normalizeUpdate(raw);
    } catch (error) {
      this.#warn({ kind: 'normalizer_threw', error });
      return;
    }
    if (update === null) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(update);
      } catch (error) {
        this.#warn({ kind: 'listener_threw', error });
      }
    }
  }

  async prompt(blocks: readonly ContentBlock[]): Promise<PromptOutcome> {
    this.#assertOpen();
    if (this.#turn !== undefined) throw new Conflict('a prompt is already running in this session');
    const turn = this.#driver.runTurn(blocks);
    this.#turn = turn;
    try {
      const stopReason = await Promise.race([
        turn,
        this.#abandoned.then(() => {
          throw this.#unavailable();
        }),
      ]);
      return { stopReason };
    } catch (raw) {
      // A cancelled turn is not a failure (AgentSession contract), even when the cancel ended the
      // connection before the client answered.
      if (this.#cancelRequested) return { stopReason: 'cancelled' };
      throw this.#typed(raw);
    } finally {
      // The wire may still be handling the updates that came right before the answer.
      await macrotask();
      this.#turn = undefined;
    }
  }

  onUpdate(listener: UpdateListener): Disposable {
    this.#assertOpen();
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  cancel(): Promise<void> {
    if (this.#cancelling !== undefined) return this.#cancelling;
    if (this.#endedBy !== undefined) return Promise.reject(this.#unavailable());
    this.#cancelRequested = true;
    this.#cancelling = this.#runCancel();
    return this.#cancelling;
  }

  async setConfig(id: string, value: ConfigValue): Promise<void> {
    this.#assertOpen();
    try {
      await this.#driver.applyConfig(id, value);
    } catch (raw) {
      throw this.#typed(raw);
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#runClose();
    return this.#closing;
  }

  async #runCancel(): Promise<void> {
    const turn = this.#turn;
    await this.#driver.requestCancel().catch(noop);
    // The client usually ends the turn by itself and quickly; a short wait lets it do so before
    // the tree goes (architecture 5.2: a cancel that only the client honours can leave children).
    const honored = turn === undefined || (await settledWithin(turn, this.#cancelGraceMs));
    this.#endedBy = 'cancel';
    this.#driver.disconnect();
    // The outcome goes to the process: on a process shared with other sessions, a client that
    // ignored the cancel may cost the whole process (`shared_cancel`, see `endsSharedProcess`).
    try {
      await this.#reap(honored ? 'honored' : 'ignored');
    } finally {
      this.#abandon();
    }
  }

  async #runClose(): Promise<void> {
    this.#endedBy ??= 'close';
    this.#driver.disconnect();
    try {
      await this.#reap();
    } finally {
      this.#abandon();
    }
  }

  /** Ends the whole process tree and checks that nothing is left. `cancel` only when a cancel is the reason. */
  async #reap(cancel?: CancelOutcome): Promise<void> {
    const report = await this.#process.killTree({
      ...(this.#killGraceMs === undefined ? {} : { graceMs: this.#killGraceMs }),
      ...(cancel === undefined ? {} : { cancel }),
    });
    if (report.remaining.length > 0) {
      throw new AdapterUnavailable(
        `the client process tree was not ended: pids ${report.remaining.join(', ')} are still alive`,
      );
    }
  }

  #assertOpen(): void {
    if (this.#endedBy !== undefined || this.#cancelRequested) throw this.#unavailable();
  }

  #unavailable(): AdapterUnavailable {
    const how: Record<EndedBy, string> = {
      close: 'the session is closed',
      cancel: 'the session was ended by cancel',
      exit: 'the client process exited',
    };
    return new AdapterUnavailable(how[this.#endedBy ?? 'cancel']);
  }

  #typed(raw: unknown): OTheaterError {
    if (isOTheaterError(raw)) return raw;
    try {
      return typedErrorOf(this.#normalizer.normalizeError(raw));
    } catch (error) {
      this.#warn({ kind: 'normalizer_threw', error });
      return new AdapterUnavailable('the client failed and its error could not be normalized', {
        cause: raw,
      });
    }
  }

  #warn(warning: SessionWarning): void {
    try {
      this.#onWarning?.(warning);
    } catch {
      // The hook is not allowed to break the session either.
    }
  }
}
