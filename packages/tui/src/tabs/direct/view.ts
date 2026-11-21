// SPDX-License-Identifier: MPL-2.0
import type { ApiDirectItem, ApiDirectSession, DirectWorkspace } from '@otheater/protocol';
import { wrapText } from '../../layout/text.js';

/**
 * What the tab Direct session draws, as pure functions: the lines of the conversation and the
 * state of the new-session form. [proposta] Nothing here reads the daemon or the keyboard.
 */

export type Say = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export type Tone = 'plain' | 'producer' | 'actor' | 'dim' | 'ok' | 'warn' | 'error';

export interface ViewLine {
  readonly text: string;
  readonly tone: Tone;
}

const TOOL_MARK: Readonly<Record<string, string>> = {
  pending: '…',
  in_progress: '…',
  completed: '✓',
  failed: '✗',
};

/** The cursor drawn at the end of the text the Actor is still writing. */
const STREAMING_MARK = ' ▌';

/** One item of the conversation as lines that fit `width` (the continuation lines are indented). */
export function itemLines(item: ApiDirectItem, width: number, say: Say): ViewLine[] {
  const room = Math.max(10, width);
  switch (item.kind) {
    case 'message': {
      const head = `${say(item.from === 'producer' ? 'direct.who.producer' : 'direct.who.actor')} › `;
      const body = item.text + (item.streaming ? STREAMING_MARK : '');
      const indent = ' '.repeat(Array.from(head).length);
      const tone: Tone = item.from === 'producer' ? 'producer' : 'actor';
      return wrapText(body === '' ? ' ' : body, Math.max(10, room - indent.length)).map(
        (line, index) => ({ text: `${index === 0 ? head : indent}${line}`, tone }),
      );
    }
    case 'tool':
      return [
        {
          text: `  ${TOOL_MARK[item.status] ?? '·'} ${say('direct.item.tool', { title: item.title })}`,
          tone: item.status === 'failed' ? 'error' : 'dim',
        },
      ];
    case 'decision': {
      const text = say(`direct.item.decision.${item.answered}`, {
        title: item.title,
        rule: item.rule,
        reason: item.reason,
      });
      return wrapText(`  ⛨ ${text}`, room).map((line) => ({
        text: line,
        tone: item.answered === 'allow' ? 'dim' : 'warn',
      }));
    }
    case 'command':
      return [{ text: `  / ${item.command}`, tone: 'dim' }];
    case 'notice':
      return wrapText(`  ! ${item.text}`, room).map((line) => ({
        text: line,
        tone: item.level === 'error' ? 'error' : 'warn',
      }));
  }
}

/** The whole conversation as lines, oldest first. */
export function conversationLines(
  items: readonly ApiDirectItem[],
  width: number,
  say: Say,
): ViewLine[] {
  return items.flatMap((item) => itemLines(item, width, say));
}

/** The last `rows` lines: a conversation follows its end, like a chat. */
export function tailLines<T>(lines: readonly T[], rows: number): T[] {
  return rows <= 0 ? [] : lines.slice(Math.max(0, lines.length - rows));
}

/** The last message of the Actor (what a promotion sends when no text is given). */
export function lastActorText(items: readonly ApiDirectItem[]): string | undefined {
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at];
    if (item?.kind === 'message' && item.from === 'actor' && item.text.trim() !== '') {
      return item.text;
    }
  }
  return undefined;
}

// ---- the form that opens a session ----

/** The fields of the form, top to bottom. */
export type NewField = 'executor' | 'workspace';

export interface NewState {
  /** The ids of the valid Executors. */
  readonly executors: readonly string[];
  /** `-1`: the first Executor that can take it. */
  readonly executorAt: number;
  /** Index in {@link WORKSPACE_CHOICES}; `0` is the configured one. */
  readonly workspaceAt: number;
  readonly field: NewField;
}

/** `undefined` is "the one `direct_session.workspace` says". */
export const WORKSPACE_CHOICES: readonly (DirectWorkspace | undefined)[] = [
  undefined,
  'worktree',
  'readonly',
  'scenario',
];

export function openNew(executors: readonly string[]): NewState {
  return { executors, executorAt: -1, workspaceAt: 0, field: 'executor' };
}

export function chosenExecutor(state: NewState): string | undefined {
  return state.executorAt < 0 ? undefined : state.executors[state.executorAt];
}

export function chosenWorkspace(state: NewState): DirectWorkspace | undefined {
  return WORKSPACE_CHOICES[state.workspaceAt];
}

/** The body of the request that opens the session. */
export function openBody(
  state: NewState,
  confirm = false,
): {
  executor?: string;
  workspace?: DirectWorkspace;
  confirm?: boolean;
} {
  const executor = chosenExecutor(state);
  const workspace = chosenWorkspace(state);
  return {
    ...(executor === undefined ? {} : { executor }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(confirm ? { confirm: true } : {}),
  };
}

function ring(at: number, step: number, size: number): number {
  return (((at + step) % size) + size) % size;
}

/** One key in the form: Up/Down/Tab move the field, Left/Right change its choice; Enter and Esc are the caller's. */
export function editNew(state: NewState, combo: string | undefined): NewState {
  switch (combo) {
    case 'Tab':
    case 'Shift+Tab':
    case 'Down':
    case 'Up':
      return { ...state, field: state.field === 'executor' ? 'workspace' : 'executor' };
    case 'Left':
    case 'Right': {
      const step = combo === 'Right' ? 1 : -1;
      if (state.field === 'executor') {
        // -1 (the first that can take it) and every Executor: a ring of `executors.length + 1`.
        return {
          ...state,
          executorAt: ring(state.executorAt + 1, step, state.executors.length + 1) - 1,
        };
      }
      return { ...state, workspaceAt: ring(state.workspaceAt, step, WORKSPACE_CHOICES.length) };
    }
    default:
      return state;
  }
}

/** A session in one line: `d1 · fake/one · worktree · idle`. */
export function sessionLine(session: ApiDirectSession, say: Say): string {
  return [
    session.id,
    session.profile,
    say(`direct.workspace.${session.workspace}`),
    say(`direct.state.${session.state}`),
  ].join(' · ');
}
