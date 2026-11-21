// SPDX-License-Identifier: MPL-2.0
import type { ChatWait, ScenarioSystemMessagePayload } from '@otheater/protocol';
import type { ChatMessage } from '../layout/chat.js';
import type { ChatEntry, EntryBody } from './model.js';

/**
 * From the entries of the chat state to the messages the layout draws. Every text of the screen is
 * under `layout.chat.entry` in the catalog `tui`; the daemon's own texts (the answer of a command,
 * an error) are shown as it sent them, which are already in the language of the Producer.
 */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

const ROOT = 'layout.chat.entry';

/** `HH:MM` of the machine's own clock. */
export function clockOf(at: number): string {
  const date = new Date(at);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

function whenOf(t: Translate, at: number | null): string {
  return at === null ? t(`${ROOT}.sometime`) : clockOf(at);
}

function profiles(on: readonly { profile: string }[]): string {
  return [...new Set(on.map((item) => item.profile))].join(', ');
}

/** The reasons a wait names, as the words the catalog has (`quota`, `budget`...), or the raw reason. */
export function waitReason(t: Translate, wait: Pick<ChatWait, 'on'>): string {
  const reasons = [...new Set(wait.on.map((item) => item.reason))];
  return reasons
    .map((reason) =>
      t(`${ROOT}.waitReason.${reason}`, { defaultValue: reason, profiles: profiles(wait.on) }),
    )
    .join('; ');
}

function noticeText(t: Translate, notice: ScenarioSystemMessagePayload): string {
  switch (notice.kind) {
    case 'handoff':
      return t(`${ROOT}.handoff`, {
        attemptId: notice.attemptId,
        from: notice.fromExecutor,
        to: notice.toExecutor,
        cause: notice.cause,
      });
    case 'selection_wait':
      return t(`${ROOT}.selectionWait`, {
        role: notice.role,
        on: notice.on.map((item) => `${item.profile} (${item.reason})`).join(', '),
        until: whenOf(t, notice.until),
      });
    case 'reset_wait':
      return t(`${ROOT}.resetWait`, {
        attemptId: notice.attemptId,
        executor: notice.executor,
        until: whenOf(t, notice.resetsAt),
      });
    case 'director_failover':
      return t(`${ROOT}.failover.${notice.outcome}`, {
        from: notice.fromExecutor ?? '?',
        to: notice.toExecutor ?? '?',
        cause: notice.cause,
        until: whenOf(t, notice.resetsAt),
      });
    case 'recovery':
      return t(`${ROOT}.recovery`, {
        resumed: notice.resumed.length,
        settled: notice.settled.length,
        waiting: notice.waiting.length,
      });
  }
}

function bodyText(t: Translate, body: EntryBody): string {
  switch (body.kind) {
    case 'text':
      return body.text;
    case 'generated': {
      if (body.tools.length === 0) return t(`${ROOT}.generatedNone`);
      const tools = body.tools
        .map((tool) =>
          tool.status === 'failed' ? t(`${ROOT}.toolFailed`, { name: tool.name }) : tool.name,
        )
        .join(', ');
      return t(`${ROOT}.generatedTools`, {
        tools,
        play:
          body.playId === undefined ? '' : ` ${t(`${ROOT}.generatedPlay`, { id: body.playId })}`,
      });
    }
    case 'system':
      return noticeText(t, body.notice);
    case 'held':
      return t(`${ROOT}.held`, {
        what: t(`${ROOT}.heldWhat.${body.held.cause}`, {
          defaultValue: body.held.cause,
          playId: body.held.playId ?? '',
        }),
        reason: body.held.reason,
      });
    case 'play':
      return t(`${ROOT}.play`, { id: body.playId, state: body.state });
    case 'shellStarted':
      return t(`${ROOT}.shellStarted`, {
        command: body.command.command,
        place: body.command.place,
      });
    case 'shellFinished': {
      const { result } = body;
      const head = t(`${ROOT}.shell.${result.outcome}`, {
        code: result.exitCode ?? '?',
        seconds: Math.round(result.durationMs / 1000),
        error: result.error ?? '',
      });
      const cut =
        result.shownLines < result.totalLines
          ? t(`${ROOT}.shellCut.${result.keep}`, {
              shown: result.shownLines,
              total: result.totalLines,
            })
          : '';
      const asked = result.askedInput ? t(`${ROOT}.shellAskedInput`) : '';
      return [body.snippet.trimEnd(), cut, head, asked].filter((part) => part !== '').join('\n');
    }
    case 'command':
      return body.result.text;
    case 'error':
      return t(`${ROOT}.error`, { message: body.error.message });
    case 'local':
      return t(`${ROOT}.local.${body.key}`, body.params);
  }
}

/** The entry as the layout draws it. */
export function messageOf(t: Translate, entry: ChatEntry): ChatMessage {
  let text = bodyText(t, entry.body);
  if (entry.queued === true) text = `${text} ${t(`${ROOT}.queued`)}`;
  if (entry.partial === true) text = `${text} …`;
  return { id: entry.id, who: entry.who, at: clockOf(entry.at), text };
}

export function messagesOf(t: Translate, entries: readonly ChatEntry[]): ChatMessage[] {
  return entries.map((entry) => messageOf(t, entry));
}
