// SPDX-License-Identifier: MPL-2.0
import { NotFound } from '@otheater/core';
import type { ApiProfile, ApiQuotaStatus } from '@otheater/protocol';
import type { ApiHandlers } from '../handlers.js';
import type { QuotaStatus } from '../../quota/index.js';
import { authorizes } from '../../quota/state.js';
import type { ProfileSummary } from '../../profiles/service.js';
import type { ReadRouteDeps } from './deps.js';
import { paginate } from './paging.js';

/** The quota state as the API gives it, with whether a new session may start on it. */
export function quotaOf(status: QuotaStatus): ApiQuotaStatus {
  return {
    profile: status.profile,
    state: status.state,
    cause: status.cause,
    untilReset: status.untilReset,
    windows: status.windows.map((window) => ({ ...window })),
    observedAt: status.observedAt,
    nearLimitWindow: status.nearLimitWindow === null ? null : { ...status.nearLimitWindow },
    reason: status.reason,
    authorizes: authorizes(status),
  };
}

export function registerProfileRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { quota, profiles } = deps;

  /** `profile.secretRef` is a reference into the vault, never the value: the vault is not read here. */
  async function viewOf(summary: ProfileSummary): Promise<ApiProfile> {
    return {
      profile: summary.profile,
      hasSecret: summary.hasSecret,
      executors: summary.executors,
      // A removed profile is no longer tracked: it has no state to show.
      quota:
        summary.profile.state === 'removed'
          ? null
          : quotaOf(await quota.statusOf(summary.profile.id)),
    };
  }

  handlers.register('listProfiles', async ({ query }) => {
    const all = await profiles.list({
      ...(query.client === undefined ? {} : { client: query.client }),
      includeRemoved: true,
    });
    const wanted = all.filter(
      ({ profile }) =>
        (query.kind === undefined || profile.kind === query.kind) &&
        (query.state === undefined || profile.state === query.state),
    );
    // The quota is read for the page only: it settles the profile, which a long list need not pay for.
    const page = paginate(wanted, ({ profile }) => [profile.createdAt, profile.id], query);
    return { items: await Promise.all(page.items.map(viewOf)), nextCursor: page.nextCursor };
  });

  handlers.register('getProfile', async ({ params }) => {
    const id = `${params.client}/${params.name}`;
    const found = (await profiles.list({ client: params.client, includeRemoved: true })).find(
      ({ profile }) => profile.id === id,
    );
    if (found === undefined) throw new NotFound(`There is no profile "${id}"`);
    return viewOf(found);
  });
}
