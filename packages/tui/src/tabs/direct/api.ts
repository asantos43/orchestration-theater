// SPDX-License-Identifier: MPL-2.0
import type { ApiClient } from '@otheater/client';
import {
  API_ROUTES,
  type ApiDirectSession,
  type ApiDirectSessionDetail,
  type ApiExecutor,
  type DirectCancelResult,
  type DirectCloseResult,
  type DirectPromoteResult,
  type DirectTurnResult,
  type OpenDirectBody,
  type OpenDirectResult,
} from '@otheater/protocol';
import { randomUUID } from 'node:crypto';

/**
 * What the tab Direct session asks of the daemon (P19 of Phase 7). The thin, typed face of the
 * routes the tab uses, so a test can put a fake in its place and the screen never sees the client.
 * [proposta] Every command carries its own `Idempotency-Key`: a repeat of one call (a retry of the
 * client) does not repeat the effect, and two presses of the key are two commands.
 */
export interface DirectApi {
  /** The Executors that are valid now (the ones a session may be opened with). */
  executors(): Promise<readonly ApiExecutor[]>;
  list(scenarioId: string): Promise<readonly ApiDirectSession[]>;
  get(sessionId: string): Promise<ApiDirectSessionDetail>;
  open(scenarioId: string, body: OpenDirectBody): Promise<OpenDirectResult>;
  send(sessionId: string, text: string): Promise<DirectTurnResult>;
  command(sessionId: string, text: string): Promise<DirectTurnResult>;
  cancel(sessionId: string): Promise<DirectCancelResult>;
  close(sessionId: string): Promise<DirectCloseResult>;
  promote(sessionId: string, target: 'demand' | 'piece'): Promise<DirectPromoteResult>;
}

const PAGE = 200;

function control(): { readonly idempotencyKey: string } {
  return { idempotencyKey: randomUUID() };
}

/** The direct-session API over the typed client of the daemon. */
export function apiOf(client: ApiClient): DirectApi {
  return {
    executors: async () => {
      const found: ApiExecutor[] = [];
      let after: string | undefined;
      do {
        const page = await client.call(API_ROUTES.listExecutors, {
          query:
            after === undefined
              ? { limit: PAGE, validity: 'valid' }
              : { limit: PAGE, validity: 'valid', after },
        });
        found.push(...page.items);
        after = page.nextCursor ?? undefined;
      } while (after !== undefined);
      return found;
    },
    list: async (scenarioId) => (await client.listDirectSessions(scenarioId)).sessions,
    get: (sessionId) => client.getDirectSession(sessionId),
    open: (scenarioId, body) => client.openDirectSession(scenarioId, body, control()),
    send: (sessionId, text) => client.sendDirectMessage(sessionId, text, control()),
    command: (sessionId, text) => client.runDirectCommand(sessionId, text, control()),
    cancel: (sessionId) => client.cancelDirectTurn(sessionId, control()),
    close: (sessionId) => client.closeDirectSession(sessionId, control()),
    promote: (sessionId, target) => client.promoteDirectSession(sessionId, { target }, control()),
  };
}
