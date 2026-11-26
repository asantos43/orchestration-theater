// SPDX-License-Identifier: MPL-2.0
import type { ApiClient } from '@otheater/client';
import {
  API_ROUTES,
  type AddProfileBody,
  type AddProfileResult,
  type ApiConfig,
  type ApiExecutor,
  type ApiProfile,
  type ApiRoles,
  type ConfigEditBody,
  type ConfigEditResult,
  type RemoveProfileResult,
  type SetupDetectedClient,
  type StartProfileLoginResult,
} from '@otheater/protocol';
import { randomUUID } from 'node:crypto';

/**
 * What the tab Settings asks of the daemon (P16 of Phase 7). It is the thin, typed face of the
 * routes the tab uses, so a test can put a fake in its place and the screen never sees the
 * client. [proposta] Every command carries its own `Idempotency-Key`: a repeat of one call (a
 * retry of the client) does not repeat the effect, and two presses of the key are two commands.
 */
export interface SettingsApi {
  /** Every account, all the pages. */
  profiles(): Promise<readonly ApiProfile[]>;
  executors(): Promise<readonly ApiExecutor[]>;
  roles(): Promise<ApiRoles>;
  /** The effective configuration (what is held back is `[redacted]`). */
  config(): Promise<ApiConfig>;
  /** The keys a scenario overrides, with the values a secret could hold held back. */
  scenarioOverride(scenarioId: string): Promise<Readonly<Record<string, unknown>>>;
  /**
   * The clients and whether each is ready on the machine (N326): the form that adds an account
   * offers only the ready ones. It looks for the clients again first (`POST /v1/setup/redetect`),
   * so a client installed while the TUI is open is offered without a restart.
   */
  clients(): Promise<readonly SetupDetectedClient[]>;
  addProfile(body: AddProfileBody): Promise<AddProfileResult>;
  removeProfile(profileId: string): Promise<RemoveProfileResult>;
  putConfig(edit: ConfigEditBody): Promise<ConfigEditResult>;
  startLogin(profileId: string): Promise<StartProfileLoginResult>;
  submitLoginCode(profileId: string, code: string): Promise<void>;
  cancelLogin(profileId: string): Promise<void>;
}

/** `claude-code/main` to the two parts the routes take. */
export function profileParams(profileId: string): { client: string; name: string } {
  const at = profileId.indexOf('/');
  return at < 0
    ? { client: profileId, name: '' }
    : { client: profileId.slice(0, at), name: profileId.slice(at + 1) };
}

const PAGE = 200;

function key(): { readonly 'idempotency-key': string } {
  return { 'idempotency-key': randomUUID() };
}

/** The settings API over the typed client of the daemon. */
export function apiOf(client: ApiClient): SettingsApi {
  return {
    profiles: async () => {
      const found: ApiProfile[] = [];
      let after: string | undefined;
      do {
        const page = await client.call(API_ROUTES.listProfiles, {
          query: after === undefined ? { limit: PAGE } : { limit: PAGE, after },
        });
        found.push(...page.items);
        after = page.nextCursor ?? undefined;
      } while (after !== undefined);
      return found;
    },
    executors: async () => {
      const found: ApiExecutor[] = [];
      let after: string | undefined;
      do {
        const page = await client.call(API_ROUTES.listExecutors, {
          query: after === undefined ? { limit: PAGE } : { limit: PAGE, after },
        });
        found.push(...page.items);
        after = page.nextCursor ?? undefined;
      } while (after !== undefined);
      return found;
    },
    roles: () => client.call(API_ROUTES.listRoles, {}),
    config: () => client.call(API_ROUTES.getConfig, {}),
    scenarioOverride: async (scenarioId) =>
      (await client.call(API_ROUTES.getScenario, { params: { scenarioId } })).configOverride,
    clients: async () =>
      (await client.call(API_ROUTES.redetectSetupClients, { headers: key() })).clients,
    addProfile: (body) => client.call(API_ROUTES.addProfile, { body, headers: key() }),
    removeProfile: (profileId) =>
      client.call(API_ROUTES.removeProfile, {
        params: profileParams(profileId),
        query: {},
        headers: key(),
      }),
    putConfig: (edit) => client.call(API_ROUTES.putConfig, { body: edit, headers: key() }),
    startLogin: (profileId) =>
      client.call(API_ROUTES.startProfileLogin, {
        params: profileParams(profileId),
        headers: key(),
      }),
    submitLoginCode: async (profileId, code) => {
      await client.call(API_ROUTES.submitProfileLoginCode, {
        params: profileParams(profileId),
        body: { code },
        headers: key(),
      });
    },
    cancelLogin: async (profileId) => {
      await client.call(API_ROUTES.cancelProfileLogin, {
        params: profileParams(profileId),
        headers: key(),
      });
    },
  };
}
