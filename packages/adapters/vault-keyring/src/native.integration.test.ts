// SPDX-License-Identifier: MPL-2.0
// Runs against the REAL operating-system keyring. It is skipped unless OT_TEST_KEYRING=1, because
// it creates (and deletes) entries in the user's keyring: Secret Service on Linux, Keychain on
// macOS, Credential Manager on Windows. It uses a service name that is unique to each run and
// removes every entry it made, even when a test fails. On Linux a locked keyring may show an
// unlock prompt.
import { randomBytes } from 'node:crypto';
import { describe } from 'vitest';
import { describeSecretVaultConformance } from '@otheater/sdk';
import { KeyringVault } from './index.js';

describe.skipIf(process.env.OT_TEST_KEYRING !== '1')('KeyringVault on the real keyring', () => {
  const service = `otheater-test-${randomBytes(6).toString('hex')}`;

  describeSecretVaultConformance('KeyringVault (OS keyring)', () => {
    const vault = new KeyringVault({ service });
    return {
      vault,
      // The OS keyring cannot be locked on demand: the VAULT_LOCKED tests are skipped by omission.
      dispose: async () => {
        for (const key of await vault.list()) await vault.delete(key);
      },
    };
  });
});
