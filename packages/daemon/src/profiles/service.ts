// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  InvalidInput,
  NotFound,
  PROFILE_NAME_PATTERN,
  PROFILE_KINDS,
  formatProfileId,
  type ClientAdapterContract,
  type Clock,
  type LoginState,
  type Profile,
  type ProfileKind,
  type ProfileRecord,
  type RolePolicy,
  type Secret,
  type SecretVault,
  type SessionTransport,
  type Store,
} from '@otheater/core';
import { buildDaemonEvent, type ProfileWarningKind } from '@otheater/protocol';
import { CLIENT_IDS, type DaemonConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { DataPaths } from '../paths.js';
import { detailOf, type SituationSink } from '../situations.js';
import { createProfileDir, removeProfileDir, type DirRemoval } from './dirs.js';
import { apiKeyRefOf } from './secret-env.js';

/** The `profiles.*` keys of the config (`config.ts`), as the service reads them. */
export interface ProfileSettings {
  readonly sameProviderNotice: DaemonConfig['profiles']['same_provider_notice'];
  readonly drain: {
    readonly timeoutMs: number;
    readonly onTimeout: DaemonConfig['profiles']['drain']['on_timeout'];
    readonly removedDir: DaemonConfig['profiles']['drain']['removed_dir'];
    readonly director: DaemonConfig['profiles']['drain']['director'];
  };
}

export function profileSettingsOf(config: Pick<DaemonConfig, 'profiles'>): ProfileSettings {
  const { profiles } = config;
  return {
    sameProviderNotice: profiles.same_provider_notice,
    drain: {
      timeoutMs: profiles.drain.timeout,
      onTimeout: profiles.drain.on_timeout,
      removedDir: profiles.drain.removed_dir,
      director: profiles.drain.director,
    },
  };
}

/** The part of a client adapter the profile service calls (through the port, never a client file). */
export type ProfileAdapter = Pick<ClientAdapterContract, 'logout' | 'probeLogin' | 'setUpProfile'>;

/**
 * What the service needs to know about the live sessions of a profile, and to do to them when the
 * drain gives up waiting. [proposta] The default ({@link storeProfileSessions}) reads and writes
 * the `sessions` rows only; the daemon hands the service {@link liveProfileSessions}
 * (`live-sessions.ts`, P21), which counts and releases what the pool and the attempt runner hold.
 */
export interface ProfileSessions {
  /** Sessions of the profile that are running now. */
  count(profileId: string): Promise<number>;
  /**
   * `handoff`: puts the running sessions back in the queue to be resumed elsewhere; `force`:
   * closes them. Returns how many were touched.
   */
  release(profileId: string, how: 'handoff' | 'force'): Promise<number>;
  /**
   * [proposta] (P21b, N153) Called when the drain starts, with `profiles.drain.director: failover`:
   * moves what stands on the profile without working (the session of a Director) to another
   * Executor, so the drain does not wait for it. Resolves with how many were moved, once they
   * have let go of the profile. Optional.
   */
  releaseStanding?(profileId: string): Promise<number>;
  /**
   * Called by the removal once no session is left and before the logout: ends what a client may
   * still have running for the profile (an idle process the pool keeps). Optional.
   */
  settle?(profileId: string): Promise<void>;
}

/** The list of the Executors of one role, as the removal needs it to see a role left empty. */
export interface RoleListFact {
  readonly role: string;
  /** Each Executor of the list: the profile it runs under and whether it can be selected. */
  readonly executors: readonly { readonly profileId: string; readonly valid: boolean }[];
}

/** {@link ProfileSessions} over the `sessions` table. Limits: see the interface. */
export function storeProfileSessions(store: Pick<Store, 'sessions'>): ProfileSessions {
  const running = (profileId: string) =>
    store.sessions.list({ profile: profileId, states: ['active', 'resuming'] });
  return {
    count: async (profileId) => (await running(profileId)).length,
    release: async (profileId, how) => {
      const sessions = await running(profileId);
      for (const session of sessions) {
        await store.sessions.update(session.id, {
          state: how === 'handoff' ? 'awaiting_resume' : 'closed',
        });
      }
      return sessions.length;
    },
  };
}

/**
 * The policy of the profile set-up: it only prepares the directory (`prepareProfile`), so every
 * field is as closed as it goes. Nothing runs under it.
 */
export const PROFILE_SETUP_POLICY: RolePolicy = {
  nativeTools: [],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

export interface ProfileServiceOptions {
  readonly store: Store;
  readonly vault: SecretVault;
  /** Which vault backend holds the keys (`keyring`, `encrypted-file`...), as the config names it. */
  readonly vaultBackend: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly paths: Pick<DataPaths, 'profiles'>;
  readonly settings: ProfileSettings;
  /** The adapter of a client, or `undefined` when none is built (client not installed). */
  readonly adapters: (client: string) => ProfileAdapter | undefined;
  /** The wire the login probe goes through; none means the probe answers `unknown`. */
  readonly transport?: () => SessionTransport | undefined;
  /** Default: {@link storeProfileSessions}. */
  readonly sessions?: ProfileSessions;
  /** How often a drain looks at the sessions, in ms. Default 1000. */
  readonly pollMs?: number;
  /**
   * The lists of the roles as they are after a removal (P21): the daemon resolves them with the
   * profiles already read from the store. Absent, no list is checked.
   */
  readonly roleLists?: () => Promise<readonly RoleListFact[]>;
  /** Where the warnings of the log are also written as `profile.warning` (P24, N146). */
  readonly situations?: SituationSink | undefined;
  /**
   * Looks for the clients again before an account is created (P18, N321), so a client installed
   * after the start has its adapter. It never throws (a failure is the daemon's to log).
   */
  readonly redetect?: (() => Promise<void>) | undefined;
}

export interface AddProfileInput {
  readonly client: string;
  readonly name: string;
  readonly kind: ProfileKind;
  /** Provider of the account (`anthropic`, `openai`...). */
  readonly provider: string;
  /** Required for `api`, refused for `token_plan`. Goes to the vault and nowhere else. */
  readonly apiKey?: Secret | undefined;
  /** The Producer saw the second-subscription notice and goes on. */
  readonly acceptNotice?: boolean;
}

/** The notice of a second subscription of the same provider (N127). */
export interface SameProviderNotice {
  readonly provider: string;
  /** The subscription profiles of that provider that already exist. */
  readonly existing: readonly string[];
  readonly mode: 'once' | 'always';
}

export type AddProfileResult =
  | {
      readonly status: 'added';
      readonly profile: ProfileRecord;
      readonly hasSecret: boolean;
      readonly secretBackend: string | null;
      /** `null` for an API profile (no login). */
      readonly login: LoginState | null;
      /** The notice that applied and was accepted, or `null`. */
      readonly notice: SameProviderNotice | null;
    }
  | { readonly status: 'needs_notice'; readonly notice: SameProviderNotice };

export interface ProfileSummary {
  readonly profile: ProfileRecord;
  readonly hasSecret: boolean;
  /** Only when asked for (`checkLogin`): the probe is a call to the client. `null` for an API profile. */
  readonly login?: LoginState | null;
  readonly executors: { readonly valid: number; readonly invalid: number };
}

export interface ListProfilesOptions {
  readonly client?: string;
  /** Also the `removed` ones (they stay in the table: a name is not reused). */
  readonly includeRemoved?: boolean;
  readonly checkLogin?: boolean;
}

export interface DrainOptions {
  /** Replaces `profiles.drain.timeout` (a caller that knows nothing is running passes 0). */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DrainResult {
  readonly profile: ProfileRecord;
  /** See `profile.drained`. */
  readonly outcome: 'finished' | 'handoff' | 'forced' | 'still_running';
  /** Sessions handed back to the queue or closed. */
  readonly sessions: number;
}

export interface RemoveResult {
  readonly profile: ProfileRecord;
  readonly drain: DrainResult | null;
  readonly loggedOut: boolean;
  readonly dir: DirRemoval;
  readonly secretDeleted: boolean;
  readonly executorsInvalidated: readonly string[];
}

/**
 * The profiles of the daemon (architecture 5.6, Phase 5 P2): register, list, drain and remove.
 * Credentials never pass through here: the service learns only "has a login or not" from the login
 * probe, and an API key goes straight from the caller's `Secret` to the vault.
 */
export class ProfileService {
  readonly #o: ProfileServiceOptions;
  readonly #sessions: ProfileSessions;

  constructor(options: ProfileServiceOptions) {
    this.#o = options;
    this.#sessions = options.sessions ?? storeProfileSessions(options.store);
  }

  /** The vault backend the keys go to, for the user to see. */
  get vaultBackend(): string {
    return this.#o.vaultBackend;
  }

  /**
   * The client is one the daemon can run (N326): one of {@link CLIENT_IDS}, or one whose adapter is
   * registered (a test client). An account of any other client could never run, so it is refused.
   */
  knowsClient(client: string): boolean {
    return (
      (CLIENT_IDS as readonly string[]).includes(client) || this.#o.adapters(client) !== undefined
    );
  }

  /** The availability hook of the pool: a profile takes new sessions only while it is `active`. */
  async acceptsSessions(profileId: string): Promise<boolean> {
    return (await this.#o.store.profiles.get(profileId))?.state === 'active';
  }

  /**
   * Registers a profile: the isolated directory (prepared by the adapter), the key in the vault
   * (API only) and the row, in that order; whatever was made is undone if a later step fails.
   * A second subscription of a provider needs `acceptNotice` (per `profiles.same_provider_notice`):
   * without it nothing is made and the result is `needs_notice`. An API profile never needs it.
   */
  async add(input: AddProfileInput): Promise<AddProfileResult> {
    const { store, vault, clock } = this.#o;
    const given = validateAdd(input);
    if (!this.knowsClient(given.client)) {
      throw new InvalidInput(
        `Unknown client ${JSON.stringify(given.client)}: ${CLIENT_IDS.join(', ')}`,
      );
    }
    await this.#o.redetect?.();
    const id = formatProfileId({ client: given.client, profile: given.name });
    if ((await store.profiles.get(id)) !== undefined) {
      throw new Conflict(`Profile ${id} already exists (a name is not reused, even after removal)`);
    }
    const notice = await this.#noticeFor(given);
    if (notice !== null && input.acceptNotice !== true) return { status: 'needs_notice', notice };

    const { dir, created } = await createProfileDir(this.#o.paths, {
      client: given.client,
      profile: given.name,
    });
    const profile: Profile = { client: given.client, profile: given.name, id, dir };
    const secretRef = input.apiKey === undefined ? null : apiKeyRefOf(given.client, given.name);
    let stored = false;
    let record: ProfileRecord;
    let login: LoginState | null = null;
    try {
      await this.#o.adapters(given.client)?.setUpProfile?.(profile, PROFILE_SETUP_POLICY);
      if (secretRef !== null && input.apiKey !== undefined) {
        await vault.set(secretRef, input.apiKey);
        stored = true;
      }
      if (given.kind === 'token_plan') login = await this.#probe(profile);
      record = await store.profiles.create({
        client: given.client,
        name: given.name,
        kind: given.kind,
        provider: given.provider,
        dir,
        secretRef,
      });
      if (notice !== null) {
        record = await store.profiles.update(id, { noticeAcceptedAt: clock.now() });
      }
    } catch (error) {
      await this.#undoAdd(id, profile, { created, secretRef: stored ? secretRef : null });
      throw error;
    }

    await store.events.append(
      buildDaemonEvent('profile.added', {
        profileId: id,
        client: given.client,
        name: given.name,
        kind: given.kind,
        provider: given.provider,
        hasSecret: secretRef !== null,
        secretBackend: secretRef === null ? null : this.#o.vaultBackend,
        login,
        sameProviderNotice: notice !== null,
      }),
    );
    if (notice !== null) {
      await store.events.append(
        buildDaemonEvent('profile.notice_accepted', {
          profileId: id,
          provider: given.provider,
          sameProvider: [...notice.existing],
          mode: notice.mode,
        }),
      );
    }
    this.#o.logger.info(
      { profile: id, kind: given.kind, hasSecret: secretRef !== null },
      'profile registered',
    );
    return {
      status: 'added',
      profile: record,
      hasSecret: secretRef !== null,
      secretBackend: secretRef === null ? null : this.#o.vaultBackend,
      login,
      notice,
    };
  }

  /** The profiles (not the `removed` ones, unless asked), with their key flag and Executor counts. */
  async list(options: ListProfilesOptions = {}): Promise<readonly ProfileSummary[]> {
    const { store } = this.#o;
    const records = await store.profiles.list({
      ...(options.client === undefined ? {} : { client: options.client }),
      ...(options.includeRemoved === true ? {} : { states: ['active', 'draining'] as const }),
    });
    // [proposta] The probes run side by side: each one opens a session of the client, and one
    // after the other they could outlast the 30 s a client of the API waits (2026-11-26).
    return Promise.all(
      records.map(async (record): Promise<ProfileSummary> => {
        const executors = await store.executors.list({ profileId: record.id });
        const base: ProfileSummary = {
          profile: record,
          hasSecret: record.secretRef !== null,
          executors: {
            valid: executors.filter((e) => e.validity === 'valid').length,
            invalid: executors.filter((e) => e.validity === 'invalid').length,
          },
        };
        if (options.checkLogin !== true) return base;
        const login =
          record.kind === 'api' || record.state === 'removed'
            ? null
            : await this.#probe({
                client: record.client,
                profile: record.name,
                id: record.id,
                dir: record.dir,
              });
        return { ...base, login };
      }),
    );
  }

  /**
   * `active` → `draining`: no new session from now on. Waits for the running ones up to the
   * timeout, then does what `profiles.drain.on_timeout` says: `handoff` hands them back to the
   * queue, `force` closes them, `wait` leaves them running and the profile `draining` (the result
   * is `still_running`; call again to wait more). A profile already `draining` is waited on again.
   */
  async drain(id: string, options: DrainOptions = {}): Promise<DrainResult> {
    const { store, clock, settings } = this.#o;
    let profile = await this.#mustHave(id);
    if (profile.state === 'removed') throw new Conflict(`Profile ${id} was removed`);
    const timeoutMs = options.timeoutMs ?? settings.drain.timeoutMs;
    if (profile.state === 'active') {
      profile = await store.profiles.update(id, { state: 'draining' });
      await store.events.append(
        buildDaemonEvent('profile.draining', {
          profileId: id,
          activeSessions: await this.#sessions.count(id),
          onTimeout: settings.drain.onTimeout,
          timeoutMs,
        }),
      );
    }

    if (settings.drain.director === 'failover') await this.#leaveStanding(id);

    const deadline = clock.now() + timeoutMs;
    const poll = this.#o.pollMs ?? 1000;
    let left = await this.#sessions.count(id);
    while (left > 0 && clock.now() < deadline) {
      await clock.sleep(Math.max(1, Math.min(poll, deadline - clock.now())), options.signal);
      // A Director that was opening its session when the drain began shows up here (P21b).
      if (settings.drain.director === 'failover') await this.#leaveStanding(id);
      left = await this.#sessions.count(id);
    }

    let outcome: DrainResult['outcome'] = 'finished';
    let touched = 0;
    if (left > 0) {
      switch (settings.drain.onTimeout) {
        case 'handoff':
          touched = await this.#sessions.release(id, 'handoff');
          outcome = 'handoff';
          break;
        case 'force':
          touched = await this.#sessions.release(id, 'force');
          outcome = 'forced';
          break;
        case 'wait':
          outcome = 'still_running';
          break;
      }
    }
    await store.events.append(
      buildDaemonEvent('profile.drained', { profileId: id, outcome, sessions: touched }),
    );
    this.#o.logger.info({ profile: id, outcome, sessions: touched }, 'profile drained');
    return { profile, outcome, sessions: touched };
  }

  /** `profiles.drain.director: failover`: the Director standing on the profile moves away (P21b). */
  async #leaveStanding(id: string): Promise<void> {
    try {
      const moved = (await this.#sessions.releaseStanding?.(id)) ?? 0;
      if (moved > 0)
        this.#o.logger.info({ profile: id, moved }, 'Director sessions left the profile');
    } catch (error) {
      // The drain goes on: what did not move holds the profile until the timeout says what to do.
      this.#o.logger.warn({ err: error, profile: id }, 'the Director could not leave the profile');
    }
  }

  /**
   * Removes a profile: drains it (a profile already `draining` is waited on again), takes its key
   * out of the vault, logs the
   * client out (a subscription; a failure is logged and does not stop the removal), takes the
   * directory away (`profiles.drain.removed_dir`), makes its Executors `invalid` and marks it
   * `removed`. Every step is safe to repeat, so a failed removal is finished by calling it again.
   * Refuses while sessions are still running on it. A role whose list is left with no Executor to
   * select warns the Producer (`profile.warning`, `role_without_executor`; P21).
   */
  async remove(id: string, options: DrainOptions = {}): Promise<RemoveResult> {
    const { store, vault, clock, settings } = this.#o;
    let record = await this.#mustHave(id);
    if (record.state === 'removed') throw new Conflict(`Profile ${id} was already removed`);

    // The drain comes first, whatever the state: a profile left `draining` by `on_timeout: wait`
    // is waited on again, and the sessions of the timeout are put back before anything is taken.
    const drained: DrainResult = await this.drain(id, options);
    if ((await this.#sessions.count(id)) > 0) {
      throw new Conflict(`Profile ${id} still has running sessions; it stays draining`);
    }
    record = (await store.profiles.get(id)) ?? record;
    await this.#sessions.settle?.(id);
    const listsBefore = await this.#roleListsOf();

    // The vault first: a locked one stops the removal before anything is destroyed.
    let secretDeleted = false;
    if (record.secretRef !== null) secretDeleted = await vault.delete(record.secretRef);

    const profile: Profile = {
      client: record.client,
      profile: record.name,
      id: record.id,
      dir: record.dir,
    };
    const loggedOut = record.kind === 'token_plan' ? await this.#logout(profile) : false;
    const dir = await removeProfileDir({
      paths: this.#o.paths,
      names: { client: record.client, profile: record.name },
      recorded: record.dir,
      mode: settings.drain.removedDir,
      stamp: clock.now(),
    });

    const invalidated: string[] = [];
    for (const executor of await store.executors.list({ profileId: id, validity: 'valid' })) {
      await store.executors.update(executor.id, {
        validity: 'invalid',
        invalidReason: 'profile_removed',
      });
      invalidated.push(executor.id);
    }
    const removed = await store.profiles.update(id, { state: 'removed', secretRef: null });
    await store.events.append(
      buildDaemonEvent('profile.removed', {
        profileId: id,
        loggedOut,
        dir,
        secretDeleted,
        executorsInvalidated: invalidated,
      }),
    );
    this.#o.logger.info({ profile: id, dir, loggedOut, secretDeleted }, 'profile removed');
    await this.#warnEmptyRoles(id, listsBefore);
    return {
      profile: removed,
      drain: drained,
      loggedOut,
      dir,
      secretDeleted,
      executorsInvalidated: invalidated,
    };
  }

  /** The lists of the roles now, or none when the service has no hook or the hook fails. */
  async #roleListsOf(): Promise<readonly RoleListFact[]> {
    if (this.#o.roleLists === undefined) return [];
    try {
      return await this.#o.roleLists();
    } catch (error) {
      this.#o.logger.warn(
        { error: messageOf(error) },
        'the lists of the roles could not be read around a removal',
      );
      return [];
    }
  }

  /**
   * After a removal: a role that had an Executor of the profile it could select and has none left
   * (the list was only that profile, or the profile was what filled it) asks the Producer to name
   * another: log and `profile.warning` (`role_without_executor`). Never throws: the profile is
   * removed already.
   */
  async #warnEmptyRoles(id: string, before: readonly RoleListFact[]): Promise<void> {
    if (before.length === 0) return;
    const after = await this.#roleListsOf();
    for (const list of before) {
      const hadIt = list.executors.some((executor) => executor.profileId === id && executor.valid);
      if (!hadIt) continue;
      const now = after.find((candidate) => candidate.role === list.role);
      if (now?.executors.some((executor) => executor.valid) === true) continue;
      this.#o.logger.warn(
        { profile: id, role: list.role },
        'the role has no Executor left to select; the Producer must name another',
      );
      this.#warning(id, 'role_without_executor', `role ${list.role} has no valid Executor left`);
    }
  }

  async #mustHave(id: string): Promise<ProfileRecord> {
    const record = await this.#o.store.profiles.get(id);
    if (record === undefined) throw new NotFound(`Profile ${id} does not exist`);
    return record;
  }

  /** The notice that applies to a new subscription profile, or `null`. */
  async #noticeFor(given: ValidAdd): Promise<SameProviderNotice | null> {
    const mode = this.#o.settings.sameProviderNotice;
    if (mode === 'off' || given.kind !== 'token_plan') return null;
    const sameProvider = await this.#o.store.profiles.list({ provider: given.provider });
    const existing = sameProvider.filter((p) => p.kind === 'token_plan' && p.state !== 'removed');
    if (existing.length === 0) return null;
    if (mode === 'once' && sameProvider.some((p) => p.noticeAcceptedAt !== null)) return null;
    return { provider: given.provider, existing: existing.map((p) => p.id), mode };
  }

  /** What the client says about the login of a profile; any failure is `unknown`, never an error. */
  async #probe(profile: Profile): Promise<LoginState> {
    const adapter = this.#o.adapters(profile.client);
    const via = this.#o.transport?.();
    if (adapter?.probeLogin === undefined || via === undefined) return 'unknown';
    try {
      return (await adapter.probeLogin(profile, via)).state;
    } catch (error) {
      this.#o.logger.warn(
        { profile: profile.id, error: messageOf(error) },
        'login probe failed; the login state is unknown',
      );
      this.#warning(profile.id, 'login_probe_failed', error);
      return 'unknown';
    }
  }

  /** The warning of the log as an event too (`profile.warning`, P24). Never throws. */
  #warning(profileId: string, kind: ProfileWarningKind, error?: unknown): void {
    this.#o.situations?.record('profile.warning', {
      profileId,
      kind,
      ...(error === undefined ? {} : detailOf(error)),
    });
  }

  /** The official logout, skipped when the client has no login; never throws. */
  async #logout(profile: Profile): Promise<boolean> {
    const adapter = this.#o.adapters(profile.client);
    if (adapter === undefined) {
      this.#o.logger.warn({ profile: profile.id }, 'no adapter for the client; logout skipped');
      this.#warning(profile.id, 'logout_skipped');
      return false;
    }
    if ((await this.#probe(profile)) === 'logged_out') return false;
    try {
      await adapter.logout(profile);
      return true;
    } catch (error) {
      this.#o.logger.warn(
        { profile: profile.id, error: messageOf(error) },
        'logout failed; the profile is removed anyway',
      );
      this.#warning(profile.id, 'logout_failed', error);
      return false;
    }
  }

  async #undoAdd(
    id: string,
    profile: Profile,
    made: { created: boolean; secretRef: string | null },
  ): Promise<void> {
    if (made.secretRef !== null) {
      await this.#o.vault.delete(made.secretRef).catch(() => undefined);
    }
    if (made.created) {
      await removeProfileDir({
        paths: this.#o.paths,
        names: { client: profile.client, profile: profile.profile },
        recorded: profile.dir,
        mode: 'delete',
        stamp: this.#o.clock.now(),
      }).catch((error: unknown) => {
        this.#o.logger.warn(
          { profile: id, error: messageOf(error) },
          'could not undo the directory',
        );
        this.#warning(id, 'directory_undo_failed', error);
      });
    }
  }
}

/** The provider of an account: like a profile name, and a dot is allowed (`z.ai`). [proposta] */
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

interface ValidAdd {
  readonly client: string;
  readonly name: string;
  readonly kind: ProfileKind;
  readonly provider: string;
}

function validateAdd(input: AddProfileInput): ValidAdd {
  for (const [what, value, pattern] of [
    ['client', input.client, PROFILE_NAME_PATTERN],
    ['name', input.name, PROFILE_NAME_PATTERN],
    ['provider', input.provider, PROVIDER_PATTERN],
  ] as const) {
    if (!pattern.test(value)) {
      throw new InvalidInput(
        `Invalid profile ${what} ${JSON.stringify(value)}: lowercase letters, digits, "-" and "_" (a provider may also have "."), starting with a letter or digit`,
      );
    }
  }
  if (!(PROFILE_KINDS as readonly string[]).includes(input.kind)) {
    throw new InvalidInput(`Invalid profile kind ${JSON.stringify(input.kind)}`);
  }
  if (input.kind === 'api') {
    if (input.apiKey === undefined || input.apiKey.reveal().trim() === '') {
      throw new InvalidInput('An API profile needs its API key');
    }
  } else if (input.apiKey !== undefined) {
    throw new InvalidInput('A subscription (token_plan) profile takes no API key');
  }
  return { client: input.client, name: input.name, kind: input.kind, provider: input.provider };
}

/** A message safe for the log: the text of the error and nothing else. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
