// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, Secret, VaultLocked, type SecretVault } from '@otheater/core';
import type { Logger } from '../logger.js';
import { PluginCallError, type PluginPoolOptions } from './process-pool.js';
import type { PluginNoticeSink } from './runtime-config.js';

/**
 * The secrets of the plugins (architecture 5.14; Phase 9, P7; N239 (a)). They live in the
 * `SecretVault`, the same place as every other secret of the daemon, under the keys
 *
 * - `plugin/<id>/<NAME>`: the value for every project;
 * - `plugin/<id>/<project>/<NAME>`: the value for one project, which wins over the general one.
 *   [proposta]
 *
 * `NAME` is a name the manifest declares in `secrets` and the name of the environment variable the
 * server of the plugin gets. The value goes to that process and to nothing else: not to the
 * Executor, not to the log, not to an event. The telemetry redaction already knows it, because it
 * reads every value of the vault (`telemetry/vault-values.ts`), these keys included.
 */

/** The key of a secret of a plugin: general, or the one of a project. */
export function pluginSecretKey(id: string, name: string, project?: string): string {
  return project === undefined ? `plugin/${id}/${name}` : `plugin/${id}/${project}/${name}`;
}

/** What a read of the secrets of one plugin in one project found. */
export interface ResolvedPluginSecrets {
  /** `NAME` to the plain value, for the secrets that were found. */
  readonly env: Readonly<Record<string, string>>;
  /** The declared names that have no value, in the order of the manifest. */
  readonly missing: readonly string[];
}

/** Reads and writes the secrets of the plugins in a `SecretVault`. Never logs a value. */
export class PluginSecrets {
  readonly #vault: SecretVault;

  constructor(vault: SecretVault) {
    this.#vault = vault;
  }

  /**
   * Stores the value, for every project or for `project`. An empty value is refused: it would
   * count as missing, so the plugin would not start and nothing would say why.
   */
  async set(id: string, name: string, value: Secret, project?: string): Promise<void> {
    if (value.reveal() === '') throw new InvalidInput('A secret of a plugin cannot be empty');
    // The key is checked by the vault: a project name with a character the keys do not allow is
    // refused here, and never ends up in a different key.
    await this.#vault.set(pluginSecretKey(id, name, project), value);
  }

  /** Whether the vault holds the value (no value is returned). */
  async has(id: string, name: string, project?: string): Promise<boolean> {
    return (await this.#read(id, name, project)) !== undefined;
  }

  /**
   * The values of `names` for the plugin in the project: the one of the project when there is one,
   * else the general one. An empty value counts as missing. Rejects with `VaultLocked` when the
   * vault cannot be read now.
   */
  async resolve(
    id: string,
    names: readonly string[],
    project: string,
  ): Promise<ResolvedPluginSecrets> {
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of names) {
      const value =
        (await this.#readOfProject(id, name, project)) ?? (await this.#read(id, name, undefined));
      if (value === undefined) missing.push(name);
      else env[name] = value;
    }
    return { env, missing };
  }

  /** The value of the project; a project name that is not a valid key has none of its own. */
  async #readOfProject(id: string, name: string, project: string): Promise<string | undefined> {
    try {
      return await this.#read(id, name, project);
    } catch (error) {
      if (error instanceof InvalidInput) return undefined;
      throw error;
    }
  }

  async #read(id: string, name: string, project: string | undefined): Promise<string | undefined> {
    const secret = await this.#vault.get(pluginSecretKey(id, name, project));
    const value = secret?.reveal();
    return value === undefined || value === '' ? undefined : value;
  }
}

export interface PluginExtraEnvOptions {
  readonly vault: SecretVault;
  readonly logger: Logger;
  /** Where the `secret_missing` notice goes besides the log (P8 turns it into an event). */
  readonly onNotice?: PluginNoticeSink | undefined;
  /**
   * Runs once the secrets of a server are read and all have a value, before they are handed over:
   * the daemon makes the redaction of the telemetry read the vault again (`VaultValues.refresh`),
   * so a value set a moment ago is already masked when the server starts, instead of up to 30 s
   * later (N243, item 60). It must not reject; if it does, the start goes on and the log says so.
   */
  readonly refreshRedaction?: (() => Promise<void>) | undefined;
}

/**
 * The `extraEnv` of the process pool: the secrets the manifest declares, read from the vault when
 * the server is about to start. A plugin that declares none never touches the vault.
 *
 * - A declared secret with no value: the server does not start in that project. The call that
 *   needed it gets `unavailable`, the log gets a warning and the `secret_missing` notice goes out,
 *   once for each set of missing names (it goes out again if the set changes, or after the plugin
 *   started with all of them). This is not a failure of the process: it counts no restart, and
 *   the next use after `ot plugin secret set` starts it. [proposta]
 * - A vault that cannot be read now (locked): the same, with no notice. The daemon already says
 *   the vault is locked.
 * - The warning, the notice and the error carry the names, never a value.
 * - With all the values in hand, `refreshRedaction` runs before they are returned, so the
 *   redaction of the telemetry already knows them when the server starts (N243, item 60).
 */
export function pluginExtraEnv(
  options: PluginExtraEnvOptions,
): NonNullable<PluginPoolOptions['extraEnv']> {
  const secrets = new PluginSecrets(options.vault);
  const told = new Map<string, string>();
  return async (plugin, project) => {
    const names = plugin.manifest.secrets ?? [];
    if (names.length === 0) return {};
    const key = `${project}\u0000${plugin.id}`;
    let found: ResolvedPluginSecrets;
    try {
      found = await secrets.resolve(plugin.id, names, project);
    } catch (error) {
      if (error instanceof VaultLocked) {
        options.logger.warn(
          { plugin: plugin.id, project },
          'the secrets of the plugin cannot be read: the vault is locked; the server does not start',
        );
        throw new PluginCallError(
          'unavailable',
          'The server of the plugin needs secrets and the vault is locked.',
        );
      }
      throw error;
    }
    if (found.missing.length === 0) {
      told.delete(key);
      try {
        await options.refreshRedaction?.();
      } catch (error) {
        options.logger.warn(
          { err: error, plugin: plugin.id },
          'the redaction could not read the vault again before the server started',
        );
      }
      return found.env;
    }
    const list = found.missing.join(', ');
    if (told.get(key) !== list) {
      told.set(key, list);
      options.logger.warn(
        { plugin: plugin.id, project, secrets: found.missing },
        'the plugin declares secrets that have no value; the server does not start in this project',
      );
      try {
        options.onNotice?.({
          kind: 'secret_missing',
          plugin: plugin.id,
          project,
          secrets: found.missing,
        });
      } catch (error) {
        options.logger.warn({ err: error, kind: 'secret_missing' }, 'plugin notice sink failed');
      }
    }
    throw new PluginCallError(
      'unavailable',
      `The server of the plugin does not start: secrets without a value (${list}). Set them with "ot plugin secret set ${plugin.id} <NAME> [--project <project>]".`,
    );
  };
}
