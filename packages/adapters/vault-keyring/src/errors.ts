// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  InvalidInput,
  isOTheaterError,
  VaultLocked,
  type OTheaterError,
} from '@otheater/core';

/** The store is there but closed: Secret Service collection locked, unlock prompt dismissed. */
const LOCKED = /object locked|\blocked\b|dismissed|cancel+ed by (the )?user/i;
/** The value (or account) does not fit the platform's limits. */
const TOO_LONG = /too ?long|exceeds? .*limit/i;
/** The store itself cannot be reached. */
const UNREACHABLE =
  /no (dbus session|secret service)|dbus|storage access|platform secure storage|no default store|not supported by (the )?store|secret service/i;

/**
 * Turns whatever the keyring library threw into the port's typed errors.
 *
 * [proposta] The classification reads the library's message, because the napi binding gives every
 * failure the same `GenericFailure` code. The strings come from the Rust crates behind
 * `@napi-rs/keyring` 2.1.2 (`strings` on the Linux binary: "Secret Service: object locked", "unlock
 * prompt was dismissed", "No DBus session or Secret Service provider found", `NoStorageAccess`,
 * `PlatformFailure`, `TooLong`...) and are not verified against a real keyring on every platform.
 * Anything unrecognised becomes `AdapterUnavailable`, the safe reading for the daemon (it may fall
 * back to the encrypted file). The message of the original error stays in `cause`; ours never
 * repeats it, so no value can leak through it.
 */
export function mapKeyringError(error: unknown): OTheaterError {
  if (isOTheaterError(error)) return error;
  const text = error instanceof Error ? error.message : String(error);
  if (LOCKED.test(text)) {
    return new VaultLocked(
      'The system keyring is locked (or its unlock prompt was dismissed). Unlock it and retry.',
      { cause: error },
    );
  }
  if (TOO_LONG.test(text)) {
    return new InvalidInput('The value does not fit the limits of the system keyring', {
      cause: error,
    });
  }
  if (UNREACHABLE.test(text)) {
    return new AdapterUnavailable(
      'The system keyring is not available (no Secret Service / D-Bus session, or no access to the store). Use the encrypted-file vault.',
      { cause: error },
    );
  }
  return new AdapterUnavailable('The system keyring failed; see the cause for details.', {
    cause: error,
  });
}
