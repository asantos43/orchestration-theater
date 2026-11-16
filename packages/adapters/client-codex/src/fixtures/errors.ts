// SPDX-License-Identifier: MPL-2.0

/**
 * HAND-BUILT, not a capture. The shapes follow what Phase 0 saw (`spikes/acp-codex`, items 6 and
 * 7) [V]: the JSON-RPC code, `data.codexErrorInfo` and the wording of the messages. The message of
 * the quota error keeps the clock time and the missing date; nothing else of a real log is kept.
 */

/** `session/prompt` after the usage limit: `-32603`, `codexErrorInfo: usageLimitExceeded`, no date. */
export const QUOTA_EXHAUSTED = {
  code: -32603,
  message: "You've hit your usage limit. Try again at 9:31 AM.",
  data: { codexErrorInfo: 'usageLimitExceeded' },
} as const;

/** The same with a reset time in the data. [N] Not seen in Phase 0: it exercises the parsing only. */
export const QUOTA_EXHAUSTED_WITH_RESET = {
  code: -32603,
  message: 'usage limit',
  data: { codexErrorInfo: 'usageLimitExceeded', resetsAt: '2026-11-20T12:31:00.000Z' },
} as const;

/** `session/new` on a `CODEX_HOME` with no login. */
export const AUTHENTICATION_REQUIRED = {
  code: -32000,
  message: 'Authentication required',
} as const;

/** `data.codexErrorInfo` of the app-server that are not the quota. [S] */
export const TRANSIENT = {
  code: -32603,
  message: 'stream disconnected before completion',
  data: { codexErrorInfo: 'responseStreamDisconnected' },
} as const;
