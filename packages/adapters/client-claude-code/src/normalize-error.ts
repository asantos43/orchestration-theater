// SPDX-License-Identifier: MPL-2.0
import type { NormalizedError } from '@otheater/core';

/**
 * Turns an error of `claude-agent-acp` (a JSON-RPC error object, an `Error`, or a string) into a
 * `NormalizedError`. Phase 0 never got a quota or an auth error out of the real client (there was
 * no way to provoke one without spending the plan), so every pattern below comes from a source
 * other than a run:
 *
 * - [S] `Authentication required` / `Please run /login`: the messages of the adapter and of
 *   Claude Code when the profile has no login; the JSON-RPC code is `-32000` (`AUTH_REQUIRED` of
 *   the adapter).
 * - [S] `Claude AI usage limit reached|<epoch seconds>`: the format of the limit message in the
 *   transcript of Claude Code (the epoch after the pipe is the reset time).
 * - [S] `hit your limit`, `5-hour limit reached`, `weekly limit reached`: the same limits in the
 *   newer wording.
 * - [N] HTTP `529` / `overloaded_error`, `503`, `ETIMEDOUT`, `ECONNRESET`: the Anthropic API errors
 *   as the SDK passes them on; whether the adapter keeps the status in `data` is not confirmed.
 *
 * What none of them matches is `unknown`. The fixtures in `fixtures/errors.ts` are hand-made from
 * these patterns, not captured.
 */

/** The JSON-RPC code `claude-agent-acp` uses for "authentication required". [S] */
export const AUTH_REQUIRED_CODE = -32000;
/** A connection that closed under a request: the adapter process is gone. [N] */
const CONNECTION_CLOSED =
  /connection (closed|reset|lost)|stream closed|EPIPE|process (exited|exit)/iu;

const AUTH =
  /authentication required|please run \/login|not logged in|invalid api key|OAuth token has expired/iu;
const QUOTA =
  /usage limit reached|hit your (usage )?limit|(5-hour|five-hour|weekly|7-day) limit (reached|hit)|you've reached your .*limit|quota (exceeded|exhausted)/iu;
const TRANSIENT =
  /overloaded|\b(429|500|502|503|504|529)\b|rate_limit_error|ETIMEDOUT|ECONNRESET|ENOTFOUND|timed? ?out|temporarily unavailable/iu;
const REFUSAL = /\brefus(ed|al)\b|stop_reason.*refusal|violates? .*usage polic/iu;
const PERMISSION = /permission denied|not permitted|denied by (the )?(policy|permission)/iu;
const RESET_AFTER_PIPE = /usage limit reached\|(\d{9,13})/iu;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageOf(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const error = record(raw);
  if (typeof error?.message === 'string') return error.message;
  return raw instanceof Error ? raw.message : String(raw);
}

/** Text to match: the message plus the `data` detail, which is where the adapter puts the cause. */
function haystack(raw: unknown, message: string): string {
  const data = record(record(raw)?.data);
  const detail = data?.details ?? data?.detail ?? data?.error ?? data?.message;
  return typeof detail === 'string' ? `${message} ${detail}` : message;
}

/** Epoch seconds or ms to epoch ms; anything else is `undefined`. */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    return toEpochMs(Number(value));
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  // Below 1e11 it is seconds (the year 5138 in seconds, 1973 in ms).
  return Math.round(value < 1e11 ? value * 1000 : value);
}

function resetOf(raw: unknown, text: string): number | undefined {
  const data = record(record(raw)?.data);
  const fromData = toEpochMs(data?.resetsAt) ?? toEpochMs(data?.resetAt);
  if (fromData !== undefined) return fromData;
  const piped = RESET_AFTER_PIPE.exec(text)?.[1];
  return piped === undefined ? undefined : toEpochMs(Number(piped));
}

export function normalizeClaudeError(raw: unknown): NormalizedError {
  const message = messageOf(raw);
  const text = haystack(raw, message);
  const code = record(raw)?.code;
  if (code === AUTH_REQUIRED_CODE || AUTH.test(text)) {
    return { kind: 'auth_required', message, cause: raw };
  }
  if (QUOTA.test(text)) {
    const resetsAt = resetOf(raw, text);
    return {
      kind: 'quota_exhausted',
      message,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      limitSource: 'message',
      cause: raw,
    };
  }
  if (CONNECTION_CLOSED.test(text)) return { kind: 'client_crash', message, cause: raw };
  if (TRANSIENT.test(text)) return { kind: 'transient', message, cause: raw };
  if (REFUSAL.test(text)) return { kind: 'refusal', message, cause: raw };
  if (PERMISSION.test(text)) return { kind: 'permission', message, cause: raw };
  return { kind: 'unknown', message, cause: raw };
}
