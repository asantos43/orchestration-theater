// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/** [proposta] Default service name under which the entries live in the OS keyring. */
export const DEFAULT_SERVICE = 'otheater';

/** Configuration of the keyring vault (`adapters.vault: keyring`). */
export const KeyringVaultConfigSchema = z.strictObject({
  /**
   * Service name of the entries in the OS keyring (the "application" label in Keychain, Secret
   * Service and Credential Manager). Each key of the vault is one entry (account) under it.
   */
  service: z.string().trim().min(1).max(255).default(DEFAULT_SERVICE),
  /**
   * [proposta] Linux only. `secret-service` (default) requires the Secret Service (GNOME Keyring,
   * KWallet): without it the vault reports `AdapterUnavailable` and the daemon can fall back to
   * the encrypted file. `auto` lets the library fall back to the kernel keyring (keyutils), which
   * needs no desktop session but is **volatile**: its entries vanish on reboot. Ignored on
   * macOS and Windows.
   */
  linuxStore: z.enum(['secret-service', 'auto']).default('secret-service'),
});

export type KeyringVaultConfigInput = z.input<typeof KeyringVaultConfigSchema>;
export type KeyringVaultConfig = z.output<typeof KeyringVaultConfigSchema>;
