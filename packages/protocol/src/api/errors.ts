// SPDX-License-Identifier: MPL-2.0
import { ERROR_CODES, isOTheaterError, type JsonValue } from '@otheater/core';
import { z } from 'zod';

/**
 * The single error shape of the daemon API (architecture 5.12, plan docs/17 P1): every non-2xx
 * answer of every route is `{ error: { code, message, details? } }`. The client branches on
 * `code`, never on `message`.
 */

/**
 * Every code of the API with its HTTP status. [proposta] The set is closed: a new code is a
 * change of the contract (and of `API_VERSION` when it breaks a client).
 */
export const API_ERROR_STATUS = {
  /** The request does not fit the schema of the route (`details.issues` says where). */
  invalid_input: 400,
  /** No token, or a wrong one. */
  unauthorized: 401,
  /** A token that is good but a `Host` or `Origin` that is not (DNS rebinding defence), or a refused action. */
  forbidden: 403,
  not_found: 404,
  /** The request clashes with the current state (stale write, duplicate, `Idempotency-Key` reused with another body). */
  conflict: 409,
  payload_too_large: 413,
  /** [proposta] The profile or the spending cap has no room left (`QuotaExhausted` of the core). */
  quota_exhausted: 429,
  /** The secret vault is locked and only the user can unlock it. */
  vault_locked: 503,
  /** An adapter or a limit of the daemon (open streams) cannot serve now; retrying later may work. */
  unavailable: 503,
  /** The reconciliation of the start-up has not ended (architecture 5.21). Answers carry `Retry-After`. */
  recovering: 503,
  /** A bug or an unexpected failure of the daemon. The message never carries internals. */
  internal: 500,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
export type ApiErrorStatus = (typeof API_ERROR_STATUS)[ApiErrorCode];

export const API_ERROR_CODES = Object.keys(API_ERROR_STATUS) as [ApiErrorCode, ...ApiErrorCode[]];

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

/** Extra data of an error, always a JSON object so fields can be added later. */
export const ApiErrorDetailsSchema = z.record(z.string(), z.json());

/** The `error` member of an error answer (also used by the error message of the chat socket). */
export const ApiErrorBodySchema = z.strictObject({
  code: ApiErrorCodeSchema,
  message: z.string(),
  details: ApiErrorDetailsSchema.optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/** What every error answer of the API looks like. */
export const ApiErrorSchema = z.strictObject({ error: ApiErrorBodySchema });
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Builds an error answer. `details` is left out when undefined (`exactOptionalPropertyTypes`). */
export function apiError(
  code: ApiErrorCode,
  message: string,
  details?: Readonly<Record<string, JsonValue>>,
): ApiError {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/** The HTTP status of a code. */
export function apiErrorStatus(code: ApiErrorCode): ApiErrorStatus {
  return API_ERROR_STATUS[code];
}

/**
 * The code an error of the core (or of an adapter) answers with. Pure, so the server (P3) and the
 * tests share one table; an error that is not an OTheater error, or has a code the table does not
 * know, is `internal`. [proposta] `Transient` and `Cancelled` are `unavailable`: both say "not now".
 */
export function apiErrorCodeOf(error: unknown): ApiErrorCode {
  if (!isOTheaterError(error)) return 'internal';
  switch (error.code) {
    case ERROR_CODES.INVALID_INPUT:
      return 'invalid_input';
    case ERROR_CODES.NOT_FOUND:
      return 'not_found';
    case ERROR_CODES.CONFLICT:
      return 'conflict';
    case ERROR_CODES.PERMISSION_DENIED:
      return 'forbidden';
    case ERROR_CODES.QUOTA_EXHAUSTED:
      return 'quota_exhausted';
    case ERROR_CODES.VAULT_LOCKED:
      return 'vault_locked';
    case ERROR_CODES.ADAPTER_UNAVAILABLE:
    case ERROR_CODES.TRANSIENT:
    case ERROR_CODES.CANCELLED:
      return 'unavailable';
    default:
      return 'internal';
  }
}

/** One wrong field of a request, as `details.issues` of an `invalid_input` lists it. */
export const ApiIssueSchema = z.strictObject({
  /** Path of the field in the body, the query or the parameters (`['attachments', 0]`). */
  path: z.array(z.union([z.string(), z.int()])),
  message: z.string(),
});
export type ApiIssue = z.infer<typeof ApiIssueSchema>;

/** The `details` of an `invalid_input` made from a `ZodError`: where each wrong field is. */
export function invalidInputDetails(error: z.ZodError): { issues: ApiIssue[] } {
  return {
    issues: error.issues.map((issue) => ({
      path: issue.path.map((part) => (typeof part === 'symbol' ? part.toString() : part)),
      message: issue.message,
    })),
  };
}
