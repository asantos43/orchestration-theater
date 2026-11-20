// SPDX-License-Identifier: MPL-2.0
import { Secret } from '@otheater/core';
import type { CommandRegistrar } from './command.js';
import type { CommandRouteDeps } from './deps.js';

/**
 * The commands on profiles (P6 of docs/17): register, drain and remove. The login of a subscription
 * stays at the terminal (it is interactive). A key of an `api` profile becomes a `Secret` here and
 * goes to the vault; nothing that is answered, recorded or logged holds it. The service writes the
 * events (`profile.*`).
 */
export function registerProfileCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  const { profiles } = deps;

  register('addProfile', async ({ body }) => {
    const result = await profiles.add({
      client: body.client,
      name: body.name,
      kind: body.kind,
      provider: body.provider,
      ...(body.apiKey === undefined ? {} : { apiKey: new Secret(body.apiKey) }),
      ...(body.acceptNotice === undefined ? {} : { acceptNotice: body.acceptNotice }),
    });
    if (result.status === 'needs_notice') {
      return { status: 'needs_notice' as const, notice: noticeOf(result.notice) };
    }
    return {
      status: 'added' as const,
      profile: result.profile,
      hasSecret: result.hasSecret,
      secretBackend: result.secretBackend,
      login: result.login,
      notice: result.notice === null ? null : noticeOf(result.notice),
    };
  });

  register('drainProfile', async ({ params, body, signal }) => {
    const result = await profiles.drain(`${params.client}/${params.name}`, {
      signal,
      ...(body?.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
    });
    return { profile: result.profile, outcome: result.outcome, sessions: result.sessions };
  });

  register('removeProfile', async ({ params, query, signal }) => {
    const result = await profiles.remove(`${params.client}/${params.name}`, {
      signal,
      ...(query.timeoutMs === undefined ? {} : { timeoutMs: query.timeoutMs }),
    });
    return {
      profile: result.profile,
      drain:
        result.drain === null
          ? null
          : {
              profile: result.drain.profile,
              outcome: result.drain.outcome,
              sessions: result.drain.sessions,
            },
      loggedOut: result.loggedOut,
      dir: result.dir,
      secretDeleted: result.secretDeleted,
      executorsInvalidated: [...result.executorsInvalidated],
    };
  });
}

function noticeOf(notice: {
  readonly provider: string;
  readonly existing: readonly string[];
  readonly mode: 'once' | 'always';
}): { provider: string; existing: string[]; mode: 'once' | 'always' } {
  return { provider: notice.provider, existing: [...notice.existing], mode: notice.mode };
}
