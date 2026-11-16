// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '../errors.js';

/**
 * Shared vocabulary of the Executor layer (architecture 5.2, 5.6, 5.7): who a profile is and what
 * an Executor is. Not a port. It sits in its own file so `ModelCatalog`, `QuotaProbe` and
 * `ClientAdapter` can all use it without importing each other (no circular dependencies).
 */

/** Client ids the daemon ships adapters for. The id of a client is an open string (a new client is a new adapter). */
export const KNOWN_CLIENT_IDS = ['claude-code', 'codex', 'opencode', 'gemini'] as const;

/** Names of clients and profiles: lowercase alphanumerics with `-` and `_`, starting alphanumeric. [proposta] */
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Points at a profile without carrying its directory: the client and the profile name. */
export interface ProfileRef {
  /** Client id: `claude-code`, `codex`, `opencode`... */
  readonly client: string;
  /** Profile name, unique within the client (`empresa`, `conta-1`, `local`). */
  readonly profile: string;
}

/**
 * A subscription profile (architecture 5.6): an isolated directory per client and name. Carries no
 * secret: tokens and keys live in the `SecretVault` or in the client's own files under `dir`.
 */
export interface Profile extends ProfileRef {
  /** Complete id `<client>/<profile>`, as used in configuration keys and event payloads. */
  readonly id: string;
  /** Absolute path of the profile directory (`<data>/profiles/<client>/<profile>/`). */
  readonly dir: string;
}

/** What is chosen for a session besides the profile: model, effort and mode (architecture 5.2). */
export interface ExecutorConfig {
  /** Model id as the client's catalog lists it. */
  readonly model: string;
  /** Effort/thought level id as the client accepts it (`low`, `high`...). */
  readonly effort?: string;
  /** Mode id (`default`, `plan`, `workspace-write`...). */
  readonly mode?: string;
}

/** Executor = client + subscription profile + model + effort (architecture 5.2). */
export interface Executor extends ExecutorConfig {
  readonly profile: ProfileRef;
}

/** `<client>/<profile>` for a {@link ProfileRef}. Throws `InvalidInput` for a malformed name. */
export function formatProfileId(ref: ProfileRef): string {
  for (const part of [ref.client, ref.profile]) {
    if (!PROFILE_NAME_PATTERN.test(part)) {
      throw new InvalidInput(`Invalid client or profile name: ${JSON.stringify(part)}`);
    }
  }
  return `${ref.client}/${ref.profile}`;
}

/** Inverse of {@link formatProfileId}. Throws `InvalidInput` unless the id is exactly `<client>/<profile>`. */
export function parseProfileId(id: string): ProfileRef {
  const parts = id.split('/');
  const [client, profile] = parts;
  if (
    parts.length !== 2 ||
    client === undefined ||
    profile === undefined ||
    !PROFILE_NAME_PATTERN.test(client) ||
    !PROFILE_NAME_PATTERN.test(profile)
  ) {
    throw new InvalidInput(
      `Invalid profile id (expected <client>/<profile>): ${JSON.stringify(id)}`,
    );
  }
  return { client, profile };
}
