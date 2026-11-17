// SPDX-License-Identifier: MPL-2.0
import type { ToolDefinition } from '@otheater/core';
import { buildDaemonEvent } from '@otheater/protocol';
import { z } from 'zod';
import type { GrantRecord, SubmitCounter } from './tokens.js';

/** The `submit` tool and the `submit_*` of the roles (architecture 5.3). */
const SUBMIT_TOOL = /^submit(_|$)/;

export function isSubmitTool(name: string): boolean {
  return SUBMIT_TOOL.test(name);
}

/** What a tool call answers: `ok: false` is an error result the client sees (`isError`). */
export interface ToolReply {
  readonly ok: boolean;
  readonly value: unknown;
  /** An image to show the model beside the value (`ToolWithImage`); base64 data. */
  readonly image?: { readonly mimeType: string; readonly data: string };
}

/** Longest validation error the event keeps (the schema of `attempt.submit_failed`). */
const MAX_ERROR_CHARS = 3900;

function counterOf(record: GrantRecord, tool: string): SubmitCounter {
  let counter = record.submits.get(tool);
  if (counter === undefined) {
    counter = { calls: 0, invalid: 0, failed: false };
    record.submits.set(tool, counter);
  }
  return counter;
}

/** The text of a validation error, short enough for the model and for the event. */
export function describeIssues(error: z.ZodError): string {
  return z.prettifyError(error).slice(0, MAX_ERROR_CHARS);
}

/**
 * One call of a `submit*` tool (architecture 5.3). The output is validated with the zod schema of
 * the tool:
 * - valid: `attempt.submitted` is written to the log of the attempt and the call is accepted;
 * - invalid: the validation error goes back to the Executor, who may call again, up to
 *   `retries` (`limits.submit_retries`) times; the call after that (the N+1-th invalid one)
 *   counts as the failure of the attempt: `attempt.submit_failed` is written and the tool closes
 *   for this grant. [proposta] The tool answers with an error result and never with a protocol
 *   error, so the Executor reads it as text and not as a broken server.
 *
 * The SDK does not validate this input itself (the server hands it a schema that defers to this
 * function), because an input the SDK refused would never reach the counter.
 */
export async function runSubmit(
  record: GrantRecord,
  tool: ToolDefinition,
  args: unknown,
  retries: number,
): Promise<ToolReply> {
  const counter = counterOf(record, tool.name);
  if (counter.failed) {
    return {
      ok: false,
      value: {
        error: 'submit_closed',
        message: `${tool.name} already failed validation ${String(retries + 1)} times for this attempt; stop and end the turn.`,
      },
    };
  }
  counter.calls += 1;
  const parsed = tool.input.safeParse(args ?? {});
  const { correlation } = record.input;
  if (parsed.success) {
    counter.invalid = 0;
    await record.input.record(
      buildDaemonEvent('attempt.submitted', {
        tool: tool.name,
        role: record.input.role,
        output: z.json().parse(parsed.data),
        calls: counter.calls,
        ...correlation,
      }),
    );
    return { ok: true, value: { accepted: true } };
  }
  counter.invalid += 1;
  const message = describeIssues(parsed.error);
  if (counter.invalid > retries) {
    counter.failed = true;
    await record.input.record(
      buildDaemonEvent('attempt.submit_failed', {
        tool: tool.name,
        role: record.input.role,
        errors: message,
        calls: counter.invalid,
        ...correlation,
      }),
    );
    return {
      ok: false,
      value: {
        error: 'submit_failed',
        message: `${tool.name} failed validation ${String(counter.invalid)} times; the attempt counts as failed.\n${message}`,
      },
    };
  }
  const left = retries - counter.invalid + 1;
  return {
    ok: false,
    value: {
      error: 'invalid_output',
      message: `${tool.name}: the output does not match the schema. Fix it and call ${tool.name} again (${String(left)} ${left === 1 ? 'try' : 'tries'} left).\n${message}`,
    },
  };
}
