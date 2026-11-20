// SPDX-License-Identifier: MPL-2.0
import {
  BudgetExceededPayloadSchema,
  BudgetRestoredPayloadSchema,
  ProfileRemovedPayloadSchema,
  QuotaExhaustedPayloadSchema,
  QuotaNearLimitPayloadSchema,
  QuotaRestoredPayloadSchema,
  QuotaUpdatedPayloadSchema,
  type ApiQuotaStatus,
  type ApiQuotaWindow,
} from '@otheater/protocol';
import {
  clearStale,
  emptySync,
  markStale,
  payloadOf,
  without,
  type EventReducer,
  type SyncFields,
} from './core.js';

/**
 * The quota state of each account (profile id `<client>/<name>`), the one `GET /v1/profiles`
 * carries. The events say the state and the windows; they do not say `reason` and `authorizes`
 * (the daemon works those out), so every event about a profile applies what it says at once and
 * marks the profile to be read again, and the read has the last word. [proposta] A profile with
 * no quota reading is not in the store.
 */

export interface QuotasState extends SyncFields {
  readonly byProfile: Readonly<Record<string, ApiQuotaStatus>>;
}

export function initialQuotas(): QuotasState {
  return { ...emptySync(), byProfile: {} };
}

/** What a quota the store has never seen starts as, until the read comes. */
function blank(profile: string): ApiQuotaStatus {
  return {
    profile,
    state: 'unknown',
    cause: null,
    untilReset: null,
    windows: [],
    observedAt: null,
    nearLimitWindow: null,
    reason: '',
    authorizes: true,
  };
}

function put(state: QuotasState, status: ApiQuotaStatus): QuotasState {
  return markStale(
    { ...state, byProfile: { ...state.byProfile, [status.profile]: status } },
    status.profile,
  );
}

function mostUsed(windows: readonly ApiQuotaWindow[]): ApiQuotaWindow | null {
  let best: ApiQuotaWindow | null = null;
  for (const window of windows)
    if (best === null || window.usedPercent > best.usedPercent) best = window;
  return best;
}

export const reduceQuotas: EventReducer<QuotasState> = (state, event) => {
  switch (event.type) {
    case 'quota.updated': {
      const payload = payloadOf(QuotaUpdatedPayloadSchema, event);
      if (payload === undefined) return state;
      const known = state.byProfile[payload.profile] ?? blank(payload.profile);
      const windows: ApiQuotaWindow[] = payload.windows.map((window) => ({
        ...window,
        source: payload.source,
        fresh: true,
      }));
      const observed = windows.map((window) => window.observedAt);
      return put(state, {
        ...known,
        state: payload.state,
        // A reading that is not the end of the quota says the quota is not ended.
        cause: payload.state === 'exhausted' ? known.cause : null,
        untilReset: payload.state === 'exhausted' ? known.untilReset : null,
        windows,
        observedAt: observed.length === 0 ? known.observedAt : Math.max(...observed),
        nearLimitWindow: payload.state === 'near_limit' ? mostUsed(windows) : null,
        authorizes: payload.state !== 'exhausted',
      });
    }
    case 'quota.near_limit': {
      const payload = payloadOf(QuotaNearLimitPayloadSchema, event);
      if (payload === undefined) return state;
      const known = state.byProfile[payload.profile];
      if (known === undefined) return markStale(state, payload.profile);
      const reading = { usedPercent: payload.usedPercent, resetsAt: payload.resetsAt };
      const windows = known.windows.map((window) =>
        window.window === payload.window ? { ...window, ...reading } : window,
      );
      const nearLimitWindow = windows.find((window) => window.window === payload.window) ?? null;
      return put(state, {
        ...known,
        state: known.state === 'exhausted' ? known.state : 'near_limit',
        windows,
        nearLimitWindow,
      });
    }
    case 'quota.exhausted': {
      const payload = payloadOf(QuotaExhaustedPayloadSchema, event);
      if (payload === undefined) return state;
      const known = state.byProfile[payload.profile] ?? blank(payload.profile);
      return put(state, {
        ...known,
        state: 'exhausted',
        cause: payload.cause,
        untilReset: payload.untilReset,
        authorizes: false,
      });
    }
    case 'budget.exceeded': {
      const payload = payloadOf(BudgetExceededPayloadSchema, event);
      if (payload === undefined) return state;
      const known = state.byProfile[payload.profile] ?? blank(payload.profile);
      return put(state, {
        ...known,
        state: 'exhausted',
        cause: 'budget',
        untilReset: payload.endsAt,
        authorizes: false,
      });
    }
    case 'quota.restored':
    case 'budget.restored': {
      const payload =
        event.type === 'quota.restored'
          ? payloadOf(QuotaRestoredPayloadSchema, event)
          : payloadOf(BudgetRestoredPayloadSchema, event);
      if (payload === undefined) return state;
      const known = state.byProfile[payload.profile];
      if (known === undefined) return markStale(state, payload.profile);
      return put(state, {
        ...known,
        state: payload.state,
        cause: null,
        untilReset: null,
        authorizes: true,
      });
    }
    case 'profile.removed': {
      const payload = payloadOf(ProfileRemovedPayloadSchema, event);
      if (payload === undefined || !(payload.profileId in state.byProfile)) return state;
      return clearStale(
        { ...state, byProfile: without(state.byProfile, payload.profileId) },
        payload.profileId,
        state.stale[payload.profileId] ?? 0,
      );
    }
    default:
      return state;
  }
};

/** A snapshot: the quota of every account that has one, replacing what was there. */
export function installQuotas(quotas: readonly ApiQuotaStatus[], lastEventId: number): QuotasState {
  return {
    loaded: true,
    lastEventId,
    stale: {},
    byProfile: Object.fromEntries(quotas.map((quota) => [quota.profile, quota])),
  };
}

/** The answer of a read of one account: its quota, or `null` when it has none or is gone. */
export function settleQuota(
  state: QuotasState,
  profile: string,
  revision: number,
  quota: ApiQuotaStatus | null,
): QuotasState {
  const next: QuotasState =
    quota === null
      ? { ...state, byProfile: without(state.byProfile, profile) }
      : { ...state, byProfile: { ...state.byProfile, [profile]: quota } };
  return clearStale(next, profile, revision);
}

/** The accounts' quotas, by profile id. */
export function selectQuotas(state: QuotasState): ApiQuotaStatus[] {
  return Object.values(state.byProfile).sort((a, b) =>
    a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0,
  );
}
