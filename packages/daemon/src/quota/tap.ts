// SPDX-License-Identifier: MPL-2.0
import type {
  AgentSession,
  ClientAdapterContract,
  ConfigValue,
  ContentBlock,
  Disposable,
  PromptOutcome,
  Profile,
  ProfileRef,
  SessionConfigOption,
  UpdateListener,
} from '@otheater/core';
import type { Logger } from '../logger.js';
import { limitHitOf, type QuotaService } from './service.js';

/** What the tap needs of the quota service; the service itself fits. */
export type QuotaSink = Pick<
  QuotaService,
  'bindSession' | 'unbindSession' | 'ingestUpdate' | 'ingestError' | 'ingestLimitHit'
>;

/**
 * The session a client hands out, with the quota service listening to it (P8, architecture 5.6):
 * every update of the stream (a `rate_limit` event, a `usage`) goes to the service, and a prompt
 * that fails with a limit error is taken in, with its reset time and its source, before the
 * error reaches the caller. It changes nothing for the caller: the same updates, the same
 * outcome, the same error. A failure of the service is logged and never reaches the session.
 */
export class QuotaTappedSession implements AgentSession {
  readonly #inner: AgentSession;
  readonly #quota: QuotaSink;
  readonly #logger: Pick<Logger, 'warn'>;
  readonly #subscription: Disposable;

  constructor(
    inner: AgentSession,
    profile: ProfileRef,
    quota: QuotaSink,
    logger: Pick<Logger, 'warn'>,
  ) {
    this.#inner = inner;
    this.#quota = quota;
    this.#logger = logger;
    quota.bindSession(inner.sessionId, profile);
    this.#subscription = inner.onUpdate((update) => {
      quota.ingestUpdate(inner.sessionId, update).catch((error: unknown) => {
        logger.warn(
          { err: error, sessionId: inner.sessionId },
          'the quota service missed an update',
        );
      });
    });
  }

  get sessionId(): string {
    return this.#inner.sessionId;
  }

  get canLoad(): boolean {
    return this.#inner.canLoad;
  }

  get configOptions(): readonly SessionConfigOption[] {
    return this.#inner.configOptions;
  }

  async prompt(blocks: readonly ContentBlock[]): Promise<PromptOutcome> {
    try {
      return await this.#inner.prompt(blocks);
    } catch (error) {
      await this.#quota.ingestError(this.#inner.sessionId, error).catch((failure: unknown) => {
        this.#logger.warn({ err: failure }, 'the quota service missed a limit error');
      });
      throw error;
    }
  }

  onUpdate(listener: UpdateListener): Disposable {
    return this.#inner.onUpdate(listener);
  }

  cancel(): Promise<void> {
    return this.#inner.cancel();
  }

  setConfig(id: string, value: ConfigValue): Promise<void> {
    return this.#inner.setConfig(id, value);
  }

  async close(): Promise<void> {
    try {
      this.#subscription.dispose();
    } catch {
      // The session is closing; a listener that cannot be removed is not worth a failure.
    }
    try {
      await this.#inner.close();
    } finally {
      this.#quota.unbindSession(this.#inner.sessionId);
    }
  }
}

/**
 * The client with its sessions tapped (see {@link QuotaTappedSession}). `openSession` and
 * `loadSession` are the only members that change; every other member is the client's own, bound
 * to the client, so a class with private fields keeps working. A `QuotaExhausted` of `openSession`
 * itself (the client refuses to start for lack of quota) is taken in too, as a limit hit of the
 * profile.
 */
export function tapClient<T extends ClientAdapterContract>(
  client: T,
  quota: QuotaSink,
  logger: Pick<Logger, 'warn'>,
): T {
  const takeIn = async (profile: Profile, error: unknown): Promise<void> => {
    const hit = limitHitOf(error);
    if (hit === undefined) return;
    await quota.ingestLimitHit(profile, hit).catch((failure: unknown) => {
      logger.warn({ err: failure }, 'the quota service missed a limit error');
    });
  };
  const tapped = {
    openSession: async (
      ...args: Parameters<ClientAdapterContract['openSession']>
    ): Promise<AgentSession> => {
      try {
        const session = await client.openSession(...args);
        return new QuotaTappedSession(session, args[0], quota, logger);
      } catch (error) {
        await takeIn(args[0], error);
        throw error;
      }
    },
    loadSession: async (
      ...args: Parameters<ClientAdapterContract['loadSession']>
    ): Promise<AgentSession> => {
      try {
        const session = await client.loadSession(...args);
        return new QuotaTappedSession(session, args[0], quota, logger);
      } catch (error) {
        await takeIn(args[0], error);
        throw error;
      }
    },
  };
  return new Proxy(client, {
    get(target, property) {
      if (property === 'openSession' || property === 'loadSession') return tapped[property];
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
