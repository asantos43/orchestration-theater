// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import type { SetupDetectedClient, SetupDetectedProfile } from '@otheater/protocol';
import { CLIENT_IDS } from '../config.js';
import type { ProfileService, ProfileSummary } from '../profiles/service.js';

/**
 * What the first step of the assistant detects (architecture 5.7, "Primeira execução", step 1):
 * the clients installed, and the accounts the daemon already knows with their state (a key in the
 * vault or not, logged in or not). [proposta] Only state is read: the content of a credential
 * never is, and the assistant takes no key (the Producer puts it in the vault with `ot profile`).
 */

/** Which clients can run on this machine; the daemon answers from its adapters. */
export type InstalledClients = () => ReadonlySet<string>;

export function detectClients(installed: InstalledClients): SetupDetectedClient[] {
  const have = installed();
  return CLIENT_IDS.map((client) => ({ client, installed: have.has(client) }));
}

/**
 * An account as the steps show it. `usable`: active, and an API key present (for an API account)
 * or the login not known to be gone (for a subscription one).
 */
export function detectedProfileOf(summary: ProfileSummary): SetupDetectedProfile {
  const { profile } = summary;
  const login = summary.login === undefined ? (profile.kind === 'api' ? null : 'unknown') : summary.login;
  const usable =
    profile.state === 'active' &&
    (profile.kind === 'api' ? summary.hasSecret : login !== 'logged_out');
  return {
    profileId: profile.id,
    client: profile.client,
    kind: profile.kind,
    state: profile.state,
    hasSecret: summary.hasSecret,
    login,
    usable,
  };
}

/** The accounts the daemon knows (not the removed ones), in the order of the store. */
export async function detectProfiles(
  profiles: Pick<ProfileService, 'list'>,
  options: { readonly checkLogin: boolean },
): Promise<SetupDetectedProfile[]> {
  const summaries = await profiles.list({ checkLogin: options.checkLogin });
  return summaries.map(detectedProfileOf);
}

/**
 * The accounts the Producer confirms. `requested` absent: every usable one, in the order of the
 * store. Given: each must be known and active, with no repeat; the order is the Producer's, and it
 * is the order the lists of the roles take the accounts.
 */
export function confirmAccounts(
  known: readonly SetupDetectedProfile[],
  requested: readonly string[] | undefined,
): string[] {
  if (requested === undefined) return known.filter((p) => p.usable).map((p) => p.profileId);
  const byId = new Map(known.map((p) => [p.profileId, p]));
  const seen = new Set<string>();
  for (const id of requested) {
    const found = byId.get(id);
    if (found === undefined) throw new InvalidInput(`Account ${id} is not registered`);
    if (found.state !== 'active') {
      throw new InvalidInput(`Account ${id} is ${found.state}: only an active account takes part`);
    }
    if (seen.has(id)) throw new InvalidInput(`Account ${id} is listed twice`);
    seen.add(id);
  }
  return [...requested];
}
