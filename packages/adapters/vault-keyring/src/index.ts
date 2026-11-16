// SPDX-License-Identifier: MPL-2.0
import { SECRET_VAULT_PORT_VERSION, type Adapter } from '@otheater/core';

export type {
  KeyringBackend,
  NativeBackendOptions,
  NativeEntry,
  NativeKeyring,
} from './backend.js';
export { NativeKeyringBackend } from './backend.js';
export {
  DEFAULT_SERVICE,
  KeyringVaultConfigSchema,
  type KeyringVaultConfig,
  type KeyringVaultConfigInput,
} from './config.js';
export { mapKeyringError } from './errors.js';
export { KeyringVault, type KeyringVaultOptions } from './vault.js';

/** Identity of this adapter for the composition point (`adapters.vault: keyring`). */
export const keyringVaultAdapter: Adapter = {
  id: 'keyring',
  implements: { port: 'SecretVault', range: `^${SECRET_VAULT_PORT_VERSION}` },
};
