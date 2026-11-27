// SPDX-License-Identifier: MPL-2.0
import {
  NeedsInitDetailsSchema,
  type ApiErrorBody,
  type ApiErrorCode,
  type ApiIssue,
  type DaemonId,
  type NeedsInitDetails,
} from '@otheater/protocol';

/**
 * The typed errors of the client (plan docs/17 P9). A call to a daemon ends in a value of the
 * route's response schema or in one of these; nothing else escapes, so a caller branches on the
 * class and on `code`, never on a message. None of them ever carries the token.
 */

/** Where the failure happened, as far as the client knows. */
export interface ApiErrorContext {
  /** The daemon the client was told it talks to (the one in the list), when known. */
  readonly daemonId?: DaemonId | undefined;
  /** Id of the route of the call (`getStatus`), when the failure belongs to one. */
  readonly routeId?: string | undefined;
}

/** Base of every failure of a call to a daemon. */
export class ApiClientError extends Error {
  override name = 'ApiClientError';
  readonly daemonId: DaemonId | undefined;
  readonly routeId: string | undefined;

  constructor(message: string, context: ApiErrorContext = {}, options?: ErrorOptions) {
    super(message, options);
    this.daemonId = context.daemonId;
    this.routeId = context.routeId;
  }
}

/**
 * The daemon answered with an error in the API shape (`{ error: { code, message, details? } }`).
 * `code` is the contract's code and `status` the HTTP status that came with it.
 */
export class ApiRequestError extends ApiClientError {
  override name = 'ApiRequestError';
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: ApiErrorBody['details'];
  /** `Retry-After` in seconds, when the answer had one (`recovering`, `unavailable`). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    input: {
      readonly status: number;
      readonly body: ApiErrorBody;
      readonly retryAfterSeconds?: number | undefined;
    },
    context: ApiErrorContext = {},
  ) {
    super(
      `${context.routeId ?? 'request'}: ${input.body.code} (HTTP ${String(input.status)}): ${input.body.message}`,
      context,
    );
    this.code = input.body.code;
    this.status = input.status;
    this.details = input.body.details;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

/**
 * The choices a daemon asks the Producer to make when a project is opened on a folder with files
 * and no git repository (N332, `projects.init.mode: ask`): the `details` of that `invalid_input`.
 * `undefined` for any other failure. [proposta]
 */
export function needsInitOf(error: unknown): NeedsInitDetails | undefined {
  if (!(error instanceof ApiRequestError) || error.code !== 'invalid_input') return undefined;
  const parsed = NeedsInitDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : undefined;
}

export const API_PROTOCOL_REASONS = [
  /** The body is not JSON. */
  'invalid_json',
  /** A success answer that does not fit the response schema of the route. */
  'invalid_response',
  /** A non-success answer whose body is not the error shape (a proxy page, a crash, a redirect). */
  'invalid_error_body',
  /**
   * An event stream or a chat socket that does not follow the contract: the answer is not a
   * `text/event-stream`, or a frame of the socket is not text. [proposta] (P10)
   */
  'invalid_stream',
] as const;
export type ApiProtocolReason = (typeof API_PROTOCOL_REASONS)[number];

/**
 * The daemon answered, but not in the contract: never a loose exception from a parse. `status` is
 * the HTTP status, `issues` says which fields of a JSON body did not fit.
 */
export class ApiProtocolError extends ApiClientError {
  override name = 'ApiProtocolError';
  readonly reason: ApiProtocolReason;
  readonly status: number;
  readonly issues: readonly ApiIssue[];

  constructor(
    input: {
      readonly reason: ApiProtocolReason;
      readonly status: number;
      readonly issues?: readonly ApiIssue[] | undefined;
    },
    context: ApiErrorContext = {},
  ) {
    const issues = input.issues ?? [];
    const where = issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    super(
      `${context.routeId ?? 'request'}: the answer (HTTP ${String(input.status)}) is outside the contract: ${input.reason}${where === '' ? '' : ` (${where})`}`,
      context,
    );
    this.reason = input.reason;
    this.status = input.status;
    this.issues = issues;
  }
}

export const API_NETWORK_REASONS = [
  /** No answer: the connection was refused, reset or never made. */
  'connection',
  /** The deadline of the call passed (`timeoutMs`). */
  'timeout',
  /** The caller's `AbortSignal` fired. */
  'aborted',
] as const;
export type ApiNetworkReason = (typeof API_NETWORK_REASONS)[number];

/** There was no answer at all. The original failure is `cause`. */
export class ApiNetworkError extends ApiClientError {
  override name = 'ApiNetworkError';
  readonly reason: ApiNetworkReason;

  constructor(
    input: { readonly reason: ApiNetworkReason; readonly origin: string; readonly detail?: string },
    context: ApiErrorContext = {},
    options?: ErrorOptions,
  ) {
    const what =
      input.reason === 'timeout'
        ? 'timed out waiting for'
        : input.reason === 'aborted'
          ? 'was aborted while talking to'
          : 'could not reach';
    super(
      `${context.routeId ?? 'request'}: ${what} the daemon at ${input.origin}${input.detail === undefined ? '' : ` (${input.detail})`}`,
      context,
      options,
    );
    this.reason = input.reason;
  }
}

/**
 * A chat message was sent while the socket was not open (connecting, retrying or closed).
 * Nothing was sent, and nothing is queued: the caller decides whether to try again.
 */
export class ChatNotOpenError extends ApiClientError {
  override name = 'ChatNotOpenError';
  readonly state: string;

  constructor(state: string, context: ApiErrorContext = {}) {
    super(`The chat socket is ${state}: the message was not sent`, context);
    this.state = state;
  }
}

/** The caller's own input does not fit the route: nothing was sent. */
export class ApiInputError extends ApiClientError {
  override name = 'ApiInputError';
  readonly part: 'params' | 'query' | 'headers' | 'body';
  readonly issues: readonly ApiIssue[];

  constructor(
    input: {
      readonly part: 'params' | 'query' | 'headers' | 'body';
      readonly issues: readonly ApiIssue[];
    },
    context: ApiErrorContext = {},
  ) {
    const where = input.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    super(`${context.routeId ?? 'request'}: invalid ${input.part}: ${where}`, context);
    this.part = input.part;
    this.issues = input.issues;
  }
}

/**
 * The daemon at the address is not the one the list says (N168): another `daemonId` came back from
 * `GET /v1/status`. Nothing else is trusted from such a connection.
 */
export class DaemonIdMismatchError extends ApiClientError {
  override name = 'DaemonIdMismatchError';
  readonly expected: DaemonId;
  readonly actual: DaemonId;

  constructor(input: { readonly expected: DaemonId; readonly actual: DaemonId }, origin: string) {
    super(
      `The daemon at ${origin} is ${input.actual}, not the ${input.expected} the list expects`,
      { daemonId: input.expected, routeId: 'getStatus' },
    );
    this.expected = input.expected;
    this.actual = input.actual;
  }
}

/** The daemon speaks an API version this client does not (`isSupportedApiVersion`). */
export class ApiVersionError extends ApiClientError {
  override name = 'ApiVersionError';
  readonly apiVersion: number;

  constructor(apiVersion: number, context: ApiErrorContext = {}) {
    super(`The daemon speaks API version ${String(apiVersion)}, which this client does not`, {
      ...context,
      routeId: 'getStatus',
    });
    this.apiVersion = apiVersion;
  }
}

export const DAEMON_DIRECTORY_ERROR_CODES = [
  /** A field of an entry does not fit (name, URL, token, id). */
  'invalid_entry',
  'duplicate_name',
  /** Another entry already holds this `daemonId`. */
  'duplicate_daemon',
  'not_found',
  /** The entry is the local daemon, found by discovery and never saved. */
  'read_only',
  /** The `local` name belongs to the discovered daemon. */
  'reserved_name',
  /** The list file exists but is not a valid list; it is never overwritten. */
  'unreadable_file',
] as const;
export type DaemonDirectoryErrorCode = (typeof DAEMON_DIRECTORY_ERROR_CODES)[number];

/** A failure of the list of daemons (not of a call to one). */
export class DaemonDirectoryError extends Error {
  override name = 'DaemonDirectoryError';
  readonly code: DaemonDirectoryErrorCode;

  constructor(code: DaemonDirectoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}
