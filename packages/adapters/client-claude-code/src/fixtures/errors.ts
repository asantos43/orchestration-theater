// SPDX-License-Identifier: MPL-2.0
import type { NormalizedError } from '@otheater/core';

/**
 * Hand-made errors of `claude-agent-acp`, not captured: Phase 0 could not provoke a quota or an
 * auth error without spending the plan. The message texts come from public sources [S] and are
 * marked per case; the JSON-RPC wrapping is the usual `{ code, message, data }` [N].
 */
export interface ErrorFixture {
  readonly name: string;
  readonly raw: unknown;
  readonly kind: NormalizedError['kind'];
  readonly resetsAt?: number;
}

export const ERROR_FIXTURES: readonly ErrorFixture[] = [
  {
    name: 'auth: the JSON-RPC code of the adapter [S]',
    raw: { code: -32000, message: 'Authentication required' },
    kind: 'auth_required',
  },
  {
    name: 'auth: the login prompt of Claude Code [S]',
    raw: new Error('Invalid API key. Please run /login'),
    kind: 'auth_required',
  },
  {
    name: 'quota: the limit message with the reset after a pipe, epoch seconds [S]',
    raw: { code: -32603, message: 'Claude AI usage limit reached|1800000000' },
    kind: 'quota_exhausted',
    resetsAt: 1_800_000_000_000,
  },
  {
    name: 'quota: the newer wording, no reset [S]',
    raw: { code: -32603, message: "You've hit your limit for the 5-hour window" },
    kind: 'quota_exhausted',
  },
  {
    name: 'quota: a reset in data, as an ISO string [N]',
    raw: {
      code: -32603,
      message: 'Weekly limit reached',
      data: { resetsAt: '2027-01-15T12:00:00.000Z' },
    },
    kind: 'quota_exhausted',
    resetsAt: Date.parse('2027-01-15T12:00:00.000Z'),
  },
  {
    name: 'transient: overloaded [S]',
    raw: {
      code: -32603,
      message: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    },
    kind: 'transient',
  },
  {
    name: 'transient: a network error [N]',
    raw: new Error('connect ETIMEDOUT 160.79.104.10:443'),
    kind: 'transient',
  },
  {
    name: 'client_crash: the connection closed under the request [N]',
    raw: new Error('ACP connection closed'),
    kind: 'client_crash',
  },
  {
    name: 'refusal: the model refused [N]',
    raw: { code: -32603, message: 'The request was refused by the model (stop_reason: refusal)' },
    kind: 'refusal',
  },
  {
    name: 'unknown: nothing matches',
    raw: { code: -32603, message: 'Internal error' },
    kind: 'unknown',
  },
  { name: 'unknown: a bare string', raw: 'something odd', kind: 'unknown' },
];
