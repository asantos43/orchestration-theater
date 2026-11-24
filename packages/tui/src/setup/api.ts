// SPDX-License-Identifier: MPL-2.0
import type { ApiClient } from '@otheater/client';
import {
  API_ROUTES,
  type AddProfileBody,
  type AddProfileResult,
  type SetupOverview,
  type SetupRunView,
  type SetupStepSubmission,
  type StartProfileLoginResult,
} from '@otheater/protocol';
import { randomUUID } from 'node:crypto';
import { apiOf } from '../tabs/settings/api.js';

/** The three flows the daemon's assistant has (P4). */
export type SetupFlow = SetupOverview['flows'][number]['flow'];

/**
 * What the step that adds an account asks of the daemon (N274, 2026-11-22): the same routes the
 * tab Settings uses to add an account and to log in to it. [proposta] It is part of {@link SetupApi}
 * and optional: an API without it (a test of the other steps) has no such step.
 */
export interface SetupAccounts {
  addProfile(body: AddProfileBody): Promise<AddProfileResult>;
  startLogin(profileId: string): Promise<StartProfileLoginResult>;
  cancelLogin(profileId: string): Promise<void>;
  /**
   * Runs a command in the terminal of the person, with it handed over (default: the command as the
   * tab Settings runs it). Tests put a fake in its place: no client is ever run by a test.
   */
  runLocal?: ((command: string) => Promise<number | null>) | undefined;
}

/**
 * What the setup screen asks of the daemon (P17 of Phase 7): the thin, typed face of the six
 * routes of the assistant (P4), so a test can put a fake in its place and the screen never sees
 * the client. [proposta] Every command carries its own `Idempotency-Key`: a retry of one call does
 * not repeat the effect, and two presses of a key are two commands.
 */
export interface SetupApi {
  /** Whether a first run is needed, and the run to resume in each flow. */
  overview(): Promise<SetupOverview>;
  start(flow: SetupFlow): Promise<SetupRunView>;
  submit(runId: string, body: SetupStepSubmission): Promise<SetupRunView>;
  back(runId: string): Promise<SetupRunView>;
  confirm(runId: string): Promise<SetupRunView>;
  cancel(runId: string): Promise<SetupRunView>;
  /** The step that adds an account (first run only); without it the screen has no such step. */
  readonly accounts?: SetupAccounts | undefined;
}

function key(): { readonly 'idempotency-key': string } {
  return { 'idempotency-key': randomUUID() };
}

/** The setup API over the typed client of the daemon. */
export function setupApiOf(client: ApiClient): SetupApi {
  const settings = apiOf(client);
  return {
    accounts: {
      addProfile: (body) => settings.addProfile(body),
      startLogin: (profileId) => settings.startLogin(profileId),
      cancelLogin: (profileId) => settings.cancelLogin(profileId),
    },
    overview: () => client.call(API_ROUTES.getSetup, {}),
    start: (flow) => client.call(API_ROUTES.startSetup, { params: { flow }, headers: key() }),
    submit: (runId, body) =>
      client.call(API_ROUTES.submitSetupStep, { params: { runId }, body, headers: key() }),
    back: (runId) => client.call(API_ROUTES.backSetup, { params: { runId }, headers: key() }),
    confirm: (runId) => client.call(API_ROUTES.confirmSetup, { params: { runId }, headers: key() }),
    cancel: (runId) => client.call(API_ROUTES.cancelSetup, { params: { runId }, headers: key() }),
  };
}
