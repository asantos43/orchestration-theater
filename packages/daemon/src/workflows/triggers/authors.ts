// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '@otheater/core';
import type { WorkflowTriggersSettings } from './config.js';
import type { CollaboratorCheck } from './types.js';

/**
 * Who may start a run from an issue or a pull request (docs/24 section 9; plan of Phase 11b, P6).
 * The text of the item is written by a third party and reaches an agent, so the default is the
 * closed one: `workflows.triggers.authors: allowlist` with the logins of `authors_list`
 * (an empty list allows nobody).
 *
 * - `allowlist`: the login is in `authors_list` (the comparison ignores the case: GitHub logins
 *   are not case sensitive).
 * - `collaborators`: the code host says the login has a role in the repository
 *   ({@link CollaboratorCheck}). One question per login, kept for {@link COLLABORATOR_TTL_MS} so
 *   a busy repository does not cost a call per item. [proposta] A login of `authors_list` is
 *   allowed too in this mode (a bot account the Producer trusts, with no role in the repository).
 *   Without a way to ask, this mode allows only that list.
 * - `any`: anybody.
 */

/** How long the answer about a collaborator is kept (10 minutes). [proposta] */
export const COLLABORATOR_TTL_MS = 600_000;

export type AuthorVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly detail: string };

export interface AuthorGateDeps {
  readonly clock: Pick<Clock, 'now'>;
  readonly settings: () => Pick<WorkflowTriggersSettings, 'authors' | 'authors_list'>;
  readonly collaborators?: CollaboratorCheck | undefined;
}

export class AuthorGate {
  readonly #deps: AuthorGateDeps;
  readonly #cache = new Map<string, { readonly allowed: boolean; readonly until: number }>();

  constructor(deps: AuthorGateDeps) {
    this.#deps = deps;
  }

  /**
   * Whether `login` may start a run for an item of `repo`. A failure of the question to the code
   * host is thrown (the look fails and follows `poll.on_error`); it is never read as a "no".
   */
  async check(repo: string, login: string): Promise<AuthorVerdict> {
    const { authors, authors_list } = this.#deps.settings();
    if (authors === 'any') return { allowed: true };
    const lower = login.toLowerCase();
    if (authors_list.some((entry) => entry.toLowerCase() === lower)) return { allowed: true };
    if (authors === 'allowlist') {
      return {
        allowed: false,
        detail: `${login} is not in workflows.triggers.authors_list (authors: allowlist)`,
      };
    }
    const { collaborators } = this.#deps;
    if (collaborators === undefined) {
      return {
        allowed: false,
        detail: `${login} is not in workflows.triggers.authors_list and the code host cannot say who the collaborators are`,
      };
    }
    const cacheKey = `${repo}\u0000${lower}`;
    const now = this.#deps.clock.now();
    const cached = this.#cache.get(cacheKey);
    let allowed: boolean;
    if (cached !== undefined && cached.until > now) {
      allowed = cached.allowed;
    } else {
      allowed = await collaborators.isCollaborator({ repo, login });
      this.#cache.set(cacheKey, { allowed, until: now + COLLABORATOR_TTL_MS });
    }
    return allowed
      ? { allowed: true }
      : {
          allowed: false,
          detail: `${login} has no role in the repository (authors: collaborators)`,
        };
  }
}
