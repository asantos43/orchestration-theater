// SPDX-License-Identifier: MPL-2.0
import { SECRET_VAULT_PORT_VERSION, type Adapter } from '@otheater/core';

export {
  DEFAULT_SCRYPT,
  EncryptedFileVaultConfigSchema,
  MAX_SCRYPT_N,
  MIN_SCRYPT_N,
  ScryptParamsSchema,
  type EncryptedFileVaultConfig,
  type EncryptedFileVaultConfigInput,
  type ScryptParams,
} from './config.js';
export { FILE_FORMAT, FILE_VERSION } from './format.js';
export { EncryptedFileVault } from './vault.js';

/** Identity of this adapter for the composition point (`adapters.vault: encrypted-file`). */
export const encryptedFileVaultAdapter: Adapter = {
  id: 'encrypted-file',
  implements: { port: 'SecretVault', range: `^${SECRET_VAULT_PORT_VERSION}` },
};
