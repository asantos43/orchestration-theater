// SPDX-License-Identifier: MPL-2.0

/**
 * Typed errors are part of the contract of every port (architecture 5.18, rule 4).
 * Selection, resume policy and the daemon decide by `code` (or by class), never by message text.
 *
 * Every error carries a stable, upper-snake-case English `code`. Codes are API: once published
 * they are never renamed or reused for another meaning.
 */

/**
 * Brand put on every OTheater error. `Symbol.for` makes it survive duplicated copies of this
 * module (two installs of `@otheater/core`), where `instanceof` would give a false negative.
 */
export const OTHEATER_ERROR_BRAND: unique symbol = Symbol.for('otheater.error');

/** Every code defined by `@otheater/core`. Adapters may add their own subclasses and codes. */
export const ERROR_CODES = {
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  ADAPTER_UNAVAILABLE: 'ADAPTER_UNAVAILABLE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TRANSIENT: 'TRANSIENT',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VAULT_LOCKED: 'VAULT_LOCKED',
  CANCELLED: 'CANCELLED',
  INVALID_INPUT: 'INVALID_INPUT',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export abstract class OTheaterError<C extends string = string> extends Error {
  readonly [OTHEATER_ERROR_BRAND] = true;
  /** Stable machine-readable code. Branch on this, never on `message`. */
  readonly code: C;

  protected constructor(code: C, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The provider/profile has no quota (or spending cap) left. Selection moves on or waits. */
export class QuotaExhausted extends OTheaterError<'QUOTA_EXHAUSTED'> {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODES.QUOTA_EXHAUSTED, message, options);
  }
}

/** An adapter (or the thing behind it) cannot be used right now: missing, stopped, closed. */
export class AdapterUnavailable extends OTheaterError<'ADAPTER_UNAVAILABLE'> {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODES.ADAPTER_UNAVAILABLE, message, options);
  }
}

/** The operation was refused by a permission layer. Retrying without a policy change is futile. */
export class PermissionDenied extends OTheaterError<'PERMISSION_DENIED'> {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODES.PERMISSION_DENIED, message, options);
  }
}

/** A failure expected to go away by itself; the caller may retry with backoff. */
export class Transient extends OTheaterError<'TRANSIENT'> {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODES.TRANSIENT, message, options);
  }
}

/** The addressed entity does not exist. */
export class NotFound extends OTheaterError<'NOT_FOUND'> {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODES.NOT_FOUND, message, options);
  }
}

/** The operation clashes with the current state (stale write, finished transaction, duplicate). */
export class Conflict extends OTheaterError<'CONFLICT'> {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODES.CONFLICT, message, options);
  }
}

/** The secret vault is locked and needs an unlock the daemon cannot do by itself. */
export class VaultLocked extends OTheaterError<'VAULT_LOCKED'> {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODES.VAULT_LOCKED, message, options);
  }
}

/** The caller aborted the operation (`AbortSignal`). `cause` is the signal's reason. */
export class Cancelled extends OTheaterError<'CANCELLED'> {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODES.CANCELLED, message, options);
  }
}

/** The caller passed an invalid argument or a value that fails its schema. A programming error. */
export class InvalidInput extends OTheaterError<'INVALID_INPUT'> {
  constructor(message: string, options?: ErrorOptions) {
    super(ERROR_CODES.INVALID_INPUT, message, options);
  }
}

/** All errors defined here, discriminated by `code`: `switch (e.code)` narrows each case. */
export type KnownOTheaterError =
  | QuotaExhausted
  | AdapterUnavailable
  | PermissionDenied
  | Transient
  | NotFound
  | Conflict
  | VaultLocked
  | Cancelled
  | InvalidInput;

/** True for any OTheater error, including subclasses defined by adapters. */
export function isOTheaterError(value: unknown): value is OTheaterError {
  return (
    value instanceof Error &&
    (value as Partial<Record<typeof OTHEATER_ERROR_BRAND, unknown>>)[OTHEATER_ERROR_BRAND] ===
      true &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

/** True when `value` is an OTheater error with exactly this `code`. */
export function hasErrorCode<C extends string>(value: unknown, code: C): value is OTheaterError<C> {
  return isOTheaterError(value) && value.code === code;
}
