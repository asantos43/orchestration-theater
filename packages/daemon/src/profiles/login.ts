// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  Cancelled,
  Conflict,
  NotFound,
  PermissionDenied,
  type ClientAdapterContract,
  type Clock,
  type LoginFlow,
  type Profile,
  type Store,
} from '@otheater/core';
import { buildDaemonEvent, type ProfileLoginFailedPayload } from '@otheater/protocol';
import type { Logger } from '../logger.js';

/** The part of a client adapter the login service calls (through the port, never a client file). */
export type LoginAdapter = Pick<ClientAdapterContract, 'login' | 'loginMode'>;

export interface ProfileLoginServiceOptions {
  readonly store: Pick<Store, 'profiles' | 'events'>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The adapter of a client, or `undefined` when none is built (client not installed). */
  readonly adapters: (client: string) => LoginAdapter | undefined;
}

/** What opening a login answers. */
export type StartLoginResult =
  | {
      readonly status: 'started';
      readonly profileId: string;
      readonly mode: 'browser' | 'device_code';
      readonly url: string | null;
      readonly code: string | null;
      readonly takesCode: boolean;
    }
  | {
      readonly status: 'local';
      readonly profileId: string;
      readonly mode: 'terminal';
      readonly command: string;
    };

interface OpenLogin {
  readonly flow: LoginFlow;
  readonly mode: 'browser' | 'device_code';
  /** Resolves once the end of the login was recorded (the event written). */
  readonly settled: Promise<void>;
}

/**
 * The official login of a subscription profile, opened from an interface (Phase 7, P5, N186;
 * architecture 5.6, N158). The login runs in the client's own tool, in the profile directory; the
 * daemon never reads the token. [proposta] The rules of this class:
 * - one login per profile at a time; a second opening is a `Conflict`;
 * - the URL and the code the client prints are in the answer of {@link start} and nowhere else: not
 *   in the events (`profile.login.*`), not in the log, not in an error message (a failure is told
 *   by its class only);
 * - a client whose login needs a terminal (`terminal` mode: OpenCode) is not run here: the answer
 *   is `local`, with the command the person runs at a terminal (`ot profile exec ... login`);
 * - the end of the login, however it came (done, cancelled, refused, failed), is one event.
 */
export class ProfileLoginService {
  readonly #o: ProfileLoginServiceOptions;
  readonly #open = new Map<string, OpenLogin>();

  constructor(options: ProfileLoginServiceOptions) {
    this.#o = options;
  }

  /** Whether a login of the profile is open now. */
  isOpen(profileId: string): boolean {
    return this.#open.has(profileId);
  }

  async start(profileId: string): Promise<StartLoginResult> {
    const { store, clock, logger } = this.#o;
    const record = await store.profiles.get(profileId);
    if (record === undefined) throw new NotFound(`Profile ${profileId} does not exist`);
    if (record.kind !== 'token_plan') {
      throw new Conflict(`Profile ${profileId} uses an API key: it has no login`);
    }
    if (record.state !== 'active') {
      throw new Conflict(`Profile ${profileId} is ${record.state}: it takes no login`);
    }
    if (this.#open.has(profileId)) {
      throw new Conflict(`A login of ${profileId} is already open: finish or cancel it first`);
    }
    const adapter = this.#o.adapters(record.client);
    if (adapter === undefined) {
      throw new AdapterUnavailable(`The client ${record.client} is not available in this daemon`);
    }
    const local = (): StartLoginResult => ({
      status: 'local',
      profileId,
      mode: 'terminal',
      command: `ot profile exec ${profileId} login`,
    });
    // A `terminal` login needs a real terminal that the daemon cannot hand over: nothing is run.
    if (adapter.loginMode?.() === 'terminal') return local();

    const profile: Profile = {
      client: record.client,
      profile: record.name,
      id: profileId,
      dir: record.dir,
    };
    const startedAt = clock.now();
    let flow: LoginFlow;
    try {
      flow = await adapter.login(profile);
    } catch (error) {
      const reason = failureOf(error);
      await this.#recordFailed(profileId, null, reason, clock.now() - startedAt);
      logger.warn({ profile: profileId, reason }, 'official login could not be opened');
      throw error;
    }
    if (flow.mode === 'terminal') {
      // The adapter could not say the mode before it started: end what it started and send the
      // person to the terminal.
      await flow.cancel().catch(() => undefined);
      flow.complete().catch(() => undefined);
      return local();
    }
    const mode = flow.mode;
    try {
      await store.events.append(
        buildDaemonEvent('profile.login.started', {
          profileId,
          mode,
          takesCode: flow.submitCode !== undefined,
        }),
      );
    } catch (error) {
      await flow.cancel().catch(() => undefined);
      throw error;
    }
    this.#open.set(profileId, {
      flow,
      mode,
      settled: this.#watch(profileId, flow, mode, startedAt),
    });
    logger.info({ profile: profileId, mode }, 'official login opened');
    return {
      status: 'started',
      profileId,
      mode,
      url: flow.url ?? null,
      code: flow.code ?? null,
      takesCode: flow.submitCode !== undefined,
    };
  }

  /** Hands the open login the code the browser shows. The code is not logged or kept. */
  async submitCode(profileId: string, code: string): Promise<void> {
    const { flow } = await this.#mustBeOpen(profileId);
    if (flow.submitCode === undefined) {
      throw new Conflict(`The login of ${profileId} takes no code`);
    }
    await flow.submitCode(code);
  }

  /**
   * Cancels the open login and ends its process. Resolves with `false` when no login was open (it
   * had ended). Resolves after `profile.login.failed` (`cancelled`) was written.
   */
  async cancel(profileId: string): Promise<boolean> {
    const profile = await this.#o.store.profiles.get(profileId);
    if (profile === undefined) throw new NotFound(`Profile ${profileId} does not exist`);
    const open = this.#open.get(profileId);
    if (open === undefined) return false;
    await open.flow.cancel();
    await open.settled;
    return true;
  }

  /** Ends every open login (the daemon is stopping). */
  async stop(): Promise<void> {
    const opens = [...this.#open.values()];
    await Promise.all(opens.map((open) => open.flow.cancel().catch(() => undefined)));
    await Promise.all(opens.map((open) => open.settled));
  }

  async #mustBeOpen(profileId: string): Promise<OpenLogin> {
    const profile = await this.#o.store.profiles.get(profileId);
    if (profile === undefined) throw new NotFound(`Profile ${profileId} does not exist`);
    const open = this.#open.get(profileId);
    if (open === undefined) throw new Conflict(`No login of ${profileId} is open`);
    return open;
  }

  /** Waits for the end of the login and records it. Never rejects. */
  async #watch(
    profileId: string,
    flow: LoginFlow,
    mode: 'browser' | 'device_code',
    startedAt: number,
  ): Promise<void> {
    const { clock, logger } = this.#o;
    let reason: ProfileLoginFailedPayload['reason'] | null = null;
    try {
      await flow.complete();
    } catch (error) {
      reason = failureOf(error);
    }
    this.#open.delete(profileId);
    const durationMs = Math.max(0, clock.now() - startedAt);
    if (reason === null) {
      logger.info({ profile: profileId, mode }, 'official login completed');
      await this.#append(
        buildDaemonEvent('profile.login.completed', { profileId, mode, durationMs }),
      );
      return;
    }
    logger.warn({ profile: profileId, mode, reason }, 'official login did not complete');
    await this.#recordFailed(profileId, mode, reason, durationMs);
  }

  async #recordFailed(
    profileId: string,
    mode: 'browser' | 'device_code' | null,
    reason: ProfileLoginFailedPayload['reason'],
    durationMs: number,
  ): Promise<void> {
    await this.#append(
      buildDaemonEvent('profile.login.failed', { profileId, mode, reason, durationMs }),
    );
  }

  async #append(event: ReturnType<typeof buildDaemonEvent>): Promise<void> {
    try {
      await this.#o.store.events.append(event);
    } catch (error) {
      this.#o.logger.error(
        { err: error instanceof Error ? error.name : 'unknown' },
        'a login event could not be written',
      );
    }
  }
}

/** How a login ended badly, by the class of the error only (its message may hold what the client printed). */
function failureOf(error: unknown): ProfileLoginFailedPayload['reason'] {
  if (error instanceof Cancelled) return 'cancelled';
  if (error instanceof PermissionDenied) return 'refused';
  if (error instanceof AdapterUnavailable) return 'unavailable';
  return 'error';
}
