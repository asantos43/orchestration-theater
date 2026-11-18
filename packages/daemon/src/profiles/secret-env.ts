// SPDX-License-Identifier: MPL-2.0
import type { Profile, SecretVault, Store } from '@otheater/core';
import type { Logger } from '../logger.js';

/**
 * Environment variable that carries the API key of each provider when the config says nothing
 * (`profiles.api_key_env`). [proposta] The names are the ones the providers' own SDKs and CLIs
 * document; whether each real client reads them is [N] (the real rounds are N122).
 */
export const DEFAULT_API_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  minimax: 'MINIMAX_API_KEY',
};

/**
 * The variable that carries the key of `provider`: the config first, then
 * {@link DEFAULT_API_KEY_ENV}, then `<PROVIDER>_API_KEY` (upper case, anything that is not a
 * letter or digit becomes `_`).
 */
export function apiKeyEnvName(
  provider: string,
  configured: Readonly<Record<string, string>> = {},
): string {
  const own = Object.hasOwn(configured, provider) ? configured[provider] : undefined;
  if (own !== undefined) return own;
  const known = Object.hasOwn(DEFAULT_API_KEY_ENV, provider)
    ? DEFAULT_API_KEY_ENV[provider]
    : undefined;
  return known ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/** Where the vault keeps the key of an API profile. The key name is not secret; the value is. */
export function apiKeyRefOf(client: string, name: string): string {
  return `profile/${client}/${name}/api-key`;
}

export interface SecretEnvOptions {
  readonly store: Pick<Store, 'profiles'>;
  readonly vault: SecretVault;
  /** `profiles.api_key_env`. */
  readonly apiKeyEnv?: Readonly<Record<string, string>>;
  readonly logger?: Pick<Logger, 'warn'>;
}

/**
 * The `ClientAdapterOptions.secretEnv` of the daemon (Phase 5, P2). Asked once per launch of an
 * Executor process, with the profile that process is for: it returns the key of THAT profile only,
 * as the single variable of its provider, and nothing for a subscription profile, a profile with
 * no key or a `removed` one. The base adapter adds it as the last layer of the environment of that
 * one process, so the key is in no file, in no other profile's environment and in no log.
 * A locked vault rejects with `VaultLocked`, which stops the launch.
 */
export function profileSecretEnv(
  options: SecretEnvOptions,
): (profile: Profile) => Promise<Readonly<Record<string, string>>> {
  return async (profile) => {
    const record = await options.store.profiles.get(profile.id);
    if (record === undefined || record.state === 'removed' || record.secretRef === null) return {};
    const secret = await options.vault.get(record.secretRef);
    if (secret === undefined) {
      options.logger?.warn(
        { profile: record.id },
        'the API key of the profile is not in the vault',
      );
      return {};
    }
    return { [apiKeyEnvName(record.provider, options.apiKeyEnv)]: secret.reveal() };
  };
}
