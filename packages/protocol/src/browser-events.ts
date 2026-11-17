// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the `browser.*` events (architecture 5.19, "Proteções que ficam": every action of
 * the agent in the browser is an event with the URL and a screenshot). They are registered in
 * `DAEMON_EVENT_TYPES` (events.ts) at `schemaVersion` 1. Every payload is a strict object.
 * [proposta] The names and fields.
 *
 * The events never carry what a page showed (text, tree) nor what the agent typed: only the URL,
 * sizes and the path of the screenshot. `fill` says how long its value was, not the value, because
 * a field can hold a password. `callId` is the one of the `tool.called` / `tool.finished` pair.
 */

const id = z.string().min(1).max(256);

const correlation = {
  playId: id.optional(),
  demandId: id.optional(),
  attemptId: id.optional(),
};

/** The six tools, as the event names them. */
export const BROWSER_ACTIONS = [
  'open',
  'read',
  'screenshot',
  'click',
  'fill',
  'press_key',
] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export const BROWSER_ACTION_OUTCOMES = ['ok', 'refused', 'error'] as const;

/**
 * `browser.action`: a tool call ended. `url` is where the page was when it ended, or the URL the
 * call asked for when it never got there (`open` refused). `screenshot` is a path relative to the
 * data directory, set when the call took one. `idempotencyKey` is set on the write actions
 * (`click`, `fill`, `press_key`); `reused` says the effect of an earlier call with the same key
 * was found and nothing was done again.
 */
export const BrowserActionPayloadSchema = z.strictObject({
  action: z.enum(BROWSER_ACTIONS),
  role: id,
  callId: id,
  scenarioId: id,
  url: z.string().max(4096),
  title: z.string().max(500).optional(),
  outcome: z.enum(BROWSER_ACTION_OUTCOMES),
  errorCode: id.optional(),
  ref: z.string().max(64).optional(),
  key: z.string().max(64).optional(),
  valueChars: z.int().min(0).optional(),
  screenshot: z.string().max(1024).optional(),
  idempotencyKey: z.string().max(512).optional(),
  reused: z.boolean().optional(),
  durationMs: z.int().min(0),
  ...correlation,
});

/** What was refused: the call itself, or a request of the page (a redirect, a frame, an image). */
export const BROWSER_REFUSAL_KINDS = ['call', 'request'] as const;

/**
 * `browser.refused`: the rules of the scenario said no (domain, local URL, `file:` path, secret).
 * `code` is the stable code the agent got, `reason` the message.
 */
export const BrowserRefusedPayloadSchema = z.strictObject({
  kind: z.enum(BROWSER_REFUSAL_KINDS),
  scenarioId: id,
  url: z.string().max(4096),
  code: id,
  reason: z.string().max(1000),
  callId: id.optional(),
  ...correlation,
});

export const BROWSER_APPROVAL_STATES = ['requested', 'granted', 'denied'] as const;

/**
 * `browser.approval`: the Producer's approval of a write action (`browser.write_approval` is
 * `per_domain` or `always`). `requested` goes out when the question reaches the chat; `granted` or
 * `denied` when it is answered. `remembered` says the answer already held for the domain.
 */
export const BrowserApprovalPayloadSchema = z.strictObject({
  state: z.enum(BROWSER_APPROVAL_STATES),
  mode: z.enum(['per_domain', 'always']),
  action: z.enum(BROWSER_ACTIONS),
  scenarioId: id,
  domain: z.string().max(512),
  url: z.string().max(4096),
  decisionId: id.optional(),
  remembered: z.boolean().optional(),
  callId: id,
  ...correlation,
});
