// SPDX-License-Identifier: MPL-2.0
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../commands.js';
import { editConfigFile } from '../config-edit.js';
import { DaemonConfigSchema, loadConfig, VAULT_ADAPTER_IDS, type DaemonConfig } from '../config.js';
import { dataPaths, ensureDataDir } from '../paths.js';

/**
 * `ot vault status|use <keyring|encrypted-file|auto>` (Phase 11b, N322; [proposta] the name): the
 * vault of the secrets, the key `adapters.vault` of `<data>/config.yaml`. The installers (MSI and
 * install.sh) ask the choice and write it through `use`, so they never edit the YAML themselves.
 * `use` keeps the comments and the rest of the file (`editConfigFile`) and moves no secret: one
 * saved in the other vault stays there.
 */

export const VAULT_ACTIONS = ['status', 'use'] as const;
export type VaultAction = (typeof VAULT_ACTIONS)[number];
export type VaultMode = (typeof VAULT_ADAPTER_IDS)[number];

export function isVaultAction(name: string): name is VaultAction {
  return (VAULT_ACTIONS as readonly string[]).includes(name);
}

export function isVaultMode(name: string): name is VaultMode {
  return (VAULT_ADAPTER_IDS as readonly string[]).includes(name);
}

export interface VaultOptions {
  readonly json: boolean;
  /** `use`: the vault to write. */
  readonly mode?: VaultMode | undefined;
}

async function currentConfig(dataDir: string): Promise<{ config: DaemonConfig; problem?: string }> {
  try {
    return { config: await loadConfig(dataPaths(dataDir).config) };
  } catch (error) {
    return {
      config: DaemonConfigSchema.parse({}),
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runVaultCommand(
  context: CommandContext,
  action: VaultAction,
  options: VaultOptions,
): Promise<number> {
  const { t } = context;
  if (action === 'status') {
    const { config, problem } = await currentConfig(context.dataDir);
    if (problem !== undefined) {
      context.err(t('vault.configProblem', { reason: problem }));
      return EXIT_FAILED;
    }
    const mode = config.adapters.vault;
    context.out(
      options.json
        ? JSON.stringify({ vault: mode })
        : t('vault.status', { mode, modes: VAULT_ADAPTER_IDS.join(', ') }),
    );
    return EXIT_OK;
  }

  const mode = options.mode;
  if (mode === undefined) return EXIT_FAILED;
  const path = dataPaths(context.dataDir).config;
  let before: VaultMode;
  try {
    before = (await currentConfig(context.dataDir)).config.adapters.vault;
    // A first install writes the choice before the daemon ever ran: the folder may not exist yet.
    await ensureDataDir(context.dataDir);
    await editConfigFile(path, (editor) => {
      editor.set(['adapters', 'vault'], mode);
    });
  } catch (error) {
    context.err(
      t('vault.writeFailed', {
        path,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return EXIT_FAILED;
  }
  if (before === mode) {
    context.out(t('vault.unchanged', { mode }));
    return EXIT_OK;
  }
  context.out(t('vault.changed', { before, mode, path }));
  context.out(t('vault.restartHint'));
  return EXIT_OK;
}
