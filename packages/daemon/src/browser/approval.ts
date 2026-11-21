// SPDX-License-Identifier: MPL-2.0
import type { JsonValue } from '@otheater/core';
import { buildDaemonEvent, type BrowserAction } from '@otheater/protocol';
import { ToolFailure } from '../mcp/handlers.js';
import { ToolRefusal } from '../tools/context.js';

/** What `OrchestrationHandlers.openApproval` takes and gives back (the chat prompt queue). */
export interface ApprovalQuestion {
  question: string;
  options: { label: string; description: string }[];
  multi_select: boolean;
  open: boolean;
  recommended?: string;
}

export type AskApproval = (
  scenarioId: string,
  input: { questions: ApprovalQuestion[] },
) => Promise<{ readonly decisionId: string; readonly answer: Promise<JsonValue> } | undefined>;

export const APPROVE_LABEL = 'Allow';
export const DENY_LABEL = 'Deny';

type ApprovalEvent = ReturnType<typeof buildDaemonEvent>;

/** One write action waiting for the Producer. */
export interface ApprovalRequest {
  readonly mode: 'per_domain' | 'always';
  readonly action: BrowserAction;
  readonly scenarioId: string;
  readonly domain: string;
  /** Where the page is, as the agent sees it (`file:` for a served file). */
  readonly url: string;
  /** What the action does, in words, without what was typed: `click ref e12`, `type 14 characters`. */
  readonly what: string;
  readonly callId: string;
  readonly correlation: {
    readonly playId?: string | undefined;
    readonly demandId?: string | undefined;
    readonly attemptId?: string | undefined;
  };
  /** Writes a `browser.approval` event of the call. */
  readonly emit: (event: ApprovalEvent) => Promise<void>;
}

/**
 * Every string an answer carries, whatever shape the channel gave it: the answer to the question is
 * a string, `{selected: [...]}`, or `{answer: "..."}`; an array of those is an answer to several
 * questions. The shape of the answer is not pinned by the channel, so this reads all of them
 * and the caller trusts only an exact label.
 */
export function answersOf(value: JsonValue): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => answersOf(entry));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap((entry) => answersOf(entry));
  }
  return [];
}

/**
 * Whether an answer is a yes. [proposta] Only an exact `Allow` (case and edges of the text aside)
 * with no `Deny` next to it is a yes: free text, an empty answer, "ok" or both options all mean no,
 * because a click is not undone by asking again.
 */
export function isApproval(value: JsonValue): boolean {
  const given = answersOf(value).map((text) => text.trim().toLowerCase());
  return given.includes(APPROVE_LABEL.toLowerCase()) && !given.includes(DENY_LABEL.toLowerCase());
}

/**
 * `browser.write_approval` (architecture 5.19, N40): a write action of the agent (`click`,
 * `fill`, `press_key`) waits for the Producer, through the same prompt queue as `ask_producer`.
 *
 * - `always`: every write asks.
 * - `per_domain`: the first write on a domain asks; a yes holds for that domain for the rest of the
 *   scenario (and for the writes already waiting on it). A no does not stick: the next write asks
 *   again, because the Producer may have changed their mind and the agent has been told why it stopped.
 *
 * The call waits with no time limit (a person decides; the wait ends when they answer or the daemon
 * stops). Nobody to ask (the daemon has not started its orchestration) is a refusal, never a yes.
 */
export class WriteApprovals {
  readonly #ask: AskApproval | undefined;
  readonly #granted = new Set<string>();
  readonly #inFlight = new Map<string, Promise<boolean>>();

  constructor(ask: AskApproval | undefined) {
    this.#ask = ask;
  }

  /** Forgets what a scenario was allowed (it ended). */
  forget(scenarioId: string): void {
    for (const key of this.#granted) {
      if (key.startsWith(`${scenarioId}\0`)) this.#granted.delete(key);
    }
  }

  /** Resolves when the action may go on; throws a refusal when it may not. */
  async require(request: ApprovalRequest): Promise<void> {
    const key = `${request.scenarioId}\0${request.domain}`;
    const remembered = request.mode === 'per_domain' && this.#granted.has(key);
    if (remembered) {
      await this.#say(request, 'granted', { remembered: true });
      return;
    }
    // A write on a domain already being asked about waits for that answer instead of asking again.
    const waiting = request.mode === 'per_domain' ? this.#inFlight.get(key) : undefined;
    const decision = waiting ?? this.#start(request, key);
    const granted = await decision;
    if (waiting !== undefined) {
      await this.#say(request, granted ? 'granted' : 'denied', { remembered: granted });
    }
    if (!granted) {
      throw new ToolRefusal(
        'approval_denied',
        `The Producer did not approve this ${request.action} on ${request.domain}. Do not try it again unless the task needs it, and then say why.`,
      );
    }
  }

  #start(request: ApprovalRequest, key: string): Promise<boolean> {
    const run = this.#run(request, key);
    if (request.mode === 'per_domain') {
      this.#inFlight.set(key, run);
      const clear = (): void => {
        if (this.#inFlight.get(key) === run) this.#inFlight.delete(key);
      };
      run.then(clear, clear);
    }
    return run;
  }

  async #run(request: ApprovalRequest, key: string): Promise<boolean> {
    if (this.#ask === undefined) {
      throw new ToolRefusal(
        'approval_unavailable',
        'This action needs the Producer to approve it and nobody can be asked right now.',
      );
    }
    const scope =
      request.mode === 'per_domain'
        ? `Allowing also lets the agent act on ${request.domain} without asking again in this scenario.`
        : 'Every action of the agent in the browser asks first.';
    const opened = await this.#ask(request.scenarioId, {
      questions: [
        {
          question:
            `Allow the agent to ${request.what} on ${request.domain}? Page: ${request.url}`.slice(
              0,
              500,
            ),
          options: [
            { label: APPROVE_LABEL, description: scope },
            { label: DENY_LABEL, description: 'Do not do it; the agent is told it was refused.' },
          ],
          multi_select: false,
          open: false,
          recommended: DENY_LABEL,
        },
      ],
    });
    if (opened === undefined) {
      throw new ToolRefusal(
        'approval_unavailable',
        'This action needs the Producer to approve it and nobody can be asked right now.',
      );
    }
    await this.#say(request, 'requested', { decisionId: opened.decisionId });
    let answer: JsonValue;
    try {
      answer = await opened.answer;
    } catch (error) {
      throw new ToolFailure(
        'approval_cancelled',
        `The question to the Producer ended without an answer (${error instanceof Error ? error.message : 'cancelled'}).`,
      );
    }
    const granted = isApproval(answer);
    if (granted && request.mode === 'per_domain') this.#granted.add(key);
    await this.#say(request, granted ? 'granted' : 'denied', { decisionId: opened.decisionId });
    return granted;
  }

  async #say(
    request: ApprovalRequest,
    state: 'requested' | 'granted' | 'denied',
    extra: { decisionId?: string; remembered?: boolean },
  ): Promise<void> {
    await request.emit(
      buildDaemonEvent('browser.approval', {
        state,
        mode: request.mode,
        action: request.action,
        scenarioId: request.scenarioId,
        domain: request.domain,
        url: request.url,
        callId: request.callId,
        ...extra,
        ...request.correlation,
      }),
    );
  }
}
