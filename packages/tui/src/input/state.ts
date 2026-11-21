// SPDX-License-Identifier: MPL-2.0
import type { UiText } from '@otheater/client';
import {
  draftsInText,
  markerFor,
  nextMarkerNumber,
  type AttachmentDraft,
  type ProducerMessage,
} from './attachments.js';
import type { ClipboardImageResult } from './clipboard-image.js';
import {
  atomRanges,
  createEditor,
  deleteBackward,
  deleteForward,
  insert,
  killToLineEnd,
  killToLineStart,
  killWordBackward,
  killWordForward,
  moveDown,
  moveLeft,
  moveRight,
  moveToLineEnd,
  moveToLineStart,
  moveUp,
  moveWordLeft,
  moveWordRight,
  onFirstLine,
  onLastLine,
  previousBoundary,
  yank,
  type EditorState,
} from './editor.js';
import {
  createHistoryNav,
  historyNewer,
  historyOlder,
  pushEntry,
  searchHistory,
  type HistoryEntry,
  type HistoryNav,
} from './history.js';
import {
  baseName,
  classifyPaste,
  isImagePath,
  normalizeNewlines,
  parsePastedPaths,
  sanitizeForBox,
} from './paste.js';
import type { InputSettings } from './settings.js';

/**
 * The state of the text box and what it does with each event, as a pure function: the component
 * only turns keys into events and runs the effects the function asks for (the clipboard, the
 * editor, the files, the owner's `onSubmit`). That keeps every key testable without a terminal.
 */

const ONE_MB = 1024 * 1024;

export interface SearchState {
  /** What the Producer typed after Ctrl+R. */
  readonly query: string;
  /** Which of the matches the box shows: 0 is the newest. */
  readonly position: number;
  /** How many messages match `query`. */
  readonly matches: number;
  /** What the box held when the search began; Esc brings it back. */
  readonly original: HistoryEntry & { readonly cursor: number };
}

export interface BoxState {
  readonly editor: EditorState;
  readonly nav: HistoryNav;
  readonly search: SearchState | undefined;
  readonly drafts: readonly AttachmentDraft[];
  /** The last number used in a marker. */
  readonly sequence: number;
  /** The line under the box (a result, a warning); cleared by the next key. */
  readonly status: UiText | undefined;
  /** A slow job the box waits for: the image of the clipboard, or the external editor. */
  readonly busy: 'image' | 'editor' | undefined;
}

export interface BoxContext {
  readonly settings: InputSettings;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
}

export type BoxEvent =
  /** An action of the keymap (`input.submit`...). */
  | { readonly type: 'action'; readonly id: string }
  /** Characters typed. */
  | { readonly type: 'text'; readonly value: string }
  /** A paste (bracketed, or several characters at once). */
  | { readonly type: 'paste'; readonly text: string }
  | { readonly type: 'imageRead'; readonly result: ClipboardImageResult }
  /** The answer of `resolvePaths`: `files` is set when every path is a file that exists. */
  | {
      readonly type: 'pathsResolved';
      readonly raw: string;
      readonly files: readonly string[] | undefined;
    }
  | {
      readonly type: 'editorDone';
      readonly result:
        | { readonly kind: 'edited'; readonly text: string }
        | { readonly kind: 'off' }
        | { readonly kind: 'missing' }
        | { readonly kind: 'failed'; readonly message: string };
    }
  /** The owner sets the text (a completion), with the cursor at its end. */
  | { readonly type: 'replace'; readonly text: string }
  | { readonly type: 'historyLoaded'; readonly texts: readonly string[] }
  | { readonly type: 'historyFailed'; readonly message: string }
  /** The owner's `onSubmit` refused the message: it goes back to the box when the box is empty. */
  | { readonly type: 'submitFailed'; readonly message: string; readonly sent: HistoryEntry };

export type BoxEffect =
  | { readonly type: 'submit'; readonly message: ProducerMessage }
  | { readonly type: 'saveHistory'; readonly text: string }
  | { readonly type: 'readImage' }
  | { readonly type: 'editExternally'; readonly text: string }
  | { readonly type: 'resolvePaths'; readonly paths: readonly string[]; readonly raw: string };

export interface BoxStep {
  readonly state: BoxState;
  readonly effects: readonly BoxEffect[];
}

export function createBoxState(history: readonly string[] = []): BoxState {
  return {
    editor: createEditor(),
    nav: createHistoryNav(history.map((text) => ({ text, drafts: [] }))),
    search: undefined,
    drafts: [],
    sequence: 0,
    status: undefined,
    busy: undefined,
  };
}

function step(state: BoxState, ...effects: BoxEffect[]): BoxStep {
  return { state, effects };
}

function atomsOf(state: BoxState): ReturnType<typeof atomRanges> {
  return atomRanges(
    state.editor.text,
    state.drafts.map((draft) => draft.marker),
  );
}

function withEditor(state: BoxState, editor: EditorState): BoxState {
  return { ...state, editor };
}

function say(state: BoxState, key: string, params?: Record<string, string | number>): BoxState {
  return { ...state, status: { key: `input.status.${key}`, params } };
}

function entryOf(state: BoxState): HistoryEntry {
  return { text: state.editor.text, drafts: state.drafts };
}

/** Puts a message of the history (or the draft) in the box, the cursor at its end. */
function load(state: BoxState, entry: HistoryEntry, nav: HistoryNav): BoxState {
  return {
    ...state,
    nav,
    editor: { ...createEditor(entry.text), killed: state.editor.killed },
    drafts: entry.drafts,
    sequence: nextMarkerNumber(state.sequence, entry.drafts) - 1,
  };
}

// ---- Search (Ctrl+R) -------------------------------------------------------------------------

function matchesOf(state: BoxState, query: string): readonly number[] {
  return searchHistory(state.nav.entries, query);
}

function showMatch(state: BoxState, search: Omit<SearchState, 'matches'>): BoxState {
  const matches = matchesOf(state, search.query);
  const position = Math.min(Math.max(search.position, 0), Math.max(matches.length - 1, 0));
  const found = matches[position];
  const base: BoxState = { ...state, search: { ...search, position, matches: matches.length } };
  if (found === undefined) {
    const { original } = search;
    return {
      ...base,
      editor: {
        ...createEditor(original.text),
        cursor: original.cursor,
        killed: state.editor.killed,
      },
      drafts: original.drafts,
    };
  }
  const entry = state.nav.entries[found];
  if (entry === undefined) return base;
  return {
    ...base,
    editor: { ...createEditor(entry.text), killed: state.editor.killed },
    drafts: entry.drafts,
    sequence: nextMarkerNumber(state.sequence, entry.drafts) - 1,
  };
}

function startSearch(state: BoxState): BoxState {
  const original = { ...entryOf(state), cursor: state.editor.cursor };
  return showMatch(state, { query: '', position: 0, original });
}

/** Leaves the search keeping the message it showed; the arrows continue from there. */
function acceptSearch(state: BoxState): BoxState {
  const { search } = state;
  if (search === undefined) return state;
  const found = matchesOf(state, search.query)[search.position];
  const nav: HistoryNav =
    found === undefined
      ? state.nav
      : { ...state.nav, index: found, draft: state.nav.draft ?? search.original };
  return { ...state, search: undefined, nav };
}

function cancelSearch(state: BoxState): BoxState {
  const { search } = state;
  if (search === undefined) return state;
  const { original } = search;
  return {
    ...state,
    search: undefined,
    editor: {
      ...createEditor(original.text),
      cursor: original.cursor,
      killed: state.editor.killed,
    },
    drafts: original.drafts,
  };
}

function reduceSearch(state: BoxState, search: SearchState, event: BoxEvent): BoxStep | undefined {
  if (event.type === 'text' || event.type === 'paste') {
    const typed = event.type === 'text' ? event.value : event.text;
    const query = search.query + typed.replace(/[\r\n]+/g, ' ');
    return step(showMatch(state, { ...search, query, position: 0 }));
  }
  if (event.type !== 'action') return undefined;
  switch (event.id) {
    case 'input.historySearch':
    case 'input.up':
      return step(showMatch(state, { ...search, position: search.position + 1 }));
    case 'input.down':
      return step(showMatch(state, { ...search, position: search.position - 1 }));
    case 'input.backspace': {
      const query = search.query.slice(0, previousBoundary(search.query, search.query.length));
      return step(showMatch(state, { ...search, query, position: 0 }));
    }
    case 'input.cancel':
      return step(cancelSearch(state));
    case 'input.submit':
      return step(acceptSearch(state));
    default:
      return undefined;
  }
}

// ---- Attachments -----------------------------------------------------------------------------

/** Writes the marker of a new draft at the cursor. */
function attach(
  state: BoxState,
  kind: AttachmentDraft['kind'],
  body: AttachmentDraft['body'],
  temporaryPath?: string,
  separator = '',
): { readonly state: BoxState; readonly marker: string } {
  const number = nextMarkerNumber(state.sequence, state.drafts);
  const marker = markerFor(kind, number);
  const draft: AttachmentDraft = { marker, number, kind, body, temporaryPath };
  const next = withEditor(state, insert(state.editor, separator + marker));
  return { state: { ...next, drafts: [...state.drafts, draft], sequence: number }, marker };
}

/** The text of a paste (not a path): a marker plus an attachment when it is long, else as typed. */
function pasteText(state: BoxState, raw: string, ctx: BoxContext): BoxState {
  const text = normalizeNewlines(raw);
  if (classifyPaste(text, ctx.settings.paste) === 'marker') {
    const number = nextMarkerNumber(state.sequence, state.drafts);
    return attach(state, 'text', { text, name: `pasted-text-${String(number)}.txt` }).state;
  }
  return withEditor(state, insert(state.editor, sanitizeForBox(text)));
}

const IMAGE_STATUS = (result: Exclude<ClipboardImageResult, { kind: 'image' }>): UiText => {
  switch (result.kind) {
    case 'no_image':
      return { key: 'input.status.noImage' };
    case 'off':
      return { key: 'input.status.imageOff' };
    case 'tool_missing':
      return { key: 'input.status.toolMissing', params: { tools: result.tried.join(', ') } };
    case 'timeout':
      return {
        key: 'input.status.toolTimeout',
        params: { tool: result.tool, seconds: Math.max(1, Math.round(result.ms / 1000)) },
      };
    case 'too_big':
      return {
        key: 'input.status.imageTooBig',
        params: { limit: Math.max(1, Math.round(result.limit / ONE_MB)) },
      };
    case 'failed':
      return {
        key: 'input.status.toolFailed',
        params: { tool: result.tool, message: result.message },
      };
  }
};

// ---- The reducer -----------------------------------------------------------------------------

function submit(state: BoxState, ctx: BoxContext): BoxStep {
  if (state.editor.text.trim() === '') return step(state);
  const used = draftsInText(state.editor.text, state.drafts);
  const message: ProducerMessage = { text: state.editor.text, attachments: used };
  const entries = pushEntry(
    state.nav.entries,
    { text: message.text, drafts: used },
    ctx.settings.history.size,
  );
  const next: BoxState = {
    ...state,
    editor: { ...createEditor(), killed: state.editor.killed },
    nav: createHistoryNav(entries),
    drafts: [],
    status: undefined,
  };
  return step(next, { type: 'submit', message }, { type: 'saveHistory', text: message.text });
}

function up(state: BoxState): BoxState {
  if (!onFirstLine(state.editor)) return withEditor(state, moveUp(state.editor, atomsOf(state)));
  const older = historyOlder(state.nav, entryOf(state));
  return older === undefined ? state : load(state, older.entry, older.nav);
}

function down(state: BoxState): BoxState {
  if (!onLastLine(state.editor)) return withEditor(state, moveDown(state.editor, atomsOf(state)));
  const newer = historyNewer(state.nav);
  return newer === undefined ? state : load(state, newer.entry, newer.nav);
}

function runAction(state: BoxState, id: string, ctx: BoxContext): BoxStep {
  const atoms = atomsOf(state);
  const e = state.editor;
  switch (id) {
    case 'input.submit':
      return submit(state, ctx);
    case 'input.newline':
      return step(withEditor(state, insert(e, '\n')));
    case 'input.left':
      return step(withEditor(state, moveLeft(e, atoms)));
    case 'input.right':
      return step(withEditor(state, moveRight(e, atoms)));
    case 'input.wordLeft':
      return step(withEditor(state, moveWordLeft(e, atoms)));
    case 'input.wordRight':
      return step(withEditor(state, moveWordRight(e, atoms)));
    case 'input.lineStart':
      return step(withEditor(state, moveToLineStart(e)));
    case 'input.lineEnd':
      return step(withEditor(state, moveToLineEnd(e)));
    case 'input.up':
      return step(up(state));
    case 'input.down':
      return step(down(state));
    case 'input.backspace':
      return step(withEditor(state, deleteBackward(e, atoms)));
    case 'input.delete':
      return step(withEditor(state, deleteForward(e, atoms)));
    case 'input.killToEnd':
      return step(withEditor(state, killToLineEnd(e)));
    case 'input.killToStart':
      return step(withEditor(state, killToLineStart(e)));
    case 'input.killWordBack':
      return step(withEditor(state, killWordBackward(e, atoms)));
    case 'input.killWordForward':
      return step(withEditor(state, killWordForward(e, atoms)));
    case 'input.yank':
      return step(withEditor(state, yank(e)));
    case 'input.historySearch':
      return step(startSearch(state));
    case 'input.externalEditor':
      if (state.busy !== undefined) return step(state);
      return step({ ...state, busy: 'editor' }, { type: 'editExternally', text: e.text });
    case 'input.pasteImage':
      // A second Ctrl+V while the tool answers does nothing: one read at a time.
      if (state.busy !== undefined) return step(state);
      return step({ ...say(state, 'readingImage'), busy: 'image' }, { type: 'readImage' });
    default:
      // `input.cancel` outside the search, or an action this box does not know.
      return step(state);
  }
}

function reducePaste(state: BoxState, raw: string, ctx: BoxContext): BoxStep {
  if (ctx.settings.dropPaths === 'attach') {
    const paths = parsePastedPaths(raw, { homedir: ctx.homedir, platform: ctx.platform });
    if (paths !== undefined) return step(state, { type: 'resolvePaths', paths, raw });
  }
  return step(pasteText(state, raw, ctx));
}

export function reduceBox(state: BoxState, event: BoxEvent, ctx: BoxContext): BoxStep {
  // Results that come from outside do not clear the status; what the Producer does does.
  const fromProducer = event.type === 'action' || event.type === 'text' || event.type === 'paste';
  let current =
    fromProducer && state.status !== undefined ? { ...state, status: undefined } : state;

  if (fromProducer && current.search !== undefined) {
    const handled = reduceSearch(current, current.search, event);
    if (handled !== undefined) return handled;
    current = acceptSearch(current);
  }

  switch (event.type) {
    case 'action':
      return runAction(current, event.id, ctx);
    case 'text':
      return step(withEditor(current, insert(current.editor, sanitizeForBox(event.value))));
    case 'paste':
      return reducePaste(current, event.text, ctx);
    case 'replace':
      return step(
        withEditor(current, { ...createEditor(event.text), killed: current.editor.killed }),
      );
    case 'imageRead': {
      const { result } = event;
      const free: BoxState = { ...current, busy: undefined };
      if (result.kind !== 'image') return step({ ...free, status: IMAGE_STATUS(result) });
      const added = attach(free, 'image', { path: result.path, mode: 'copy' }, result.path);
      return step(say(added.state, 'imageAdded', { marker: added.marker }));
    }
    case 'pathsResolved': {
      if (event.files === undefined) return step(pasteText(current, event.raw, ctx));
      let next = current;
      let separator = '';
      for (const path of event.files) {
        const body = { path, mode: 'copy' as const };
        next = attach(next, isImagePath(path) ? 'image' : 'file', body, undefined, separator).state;
        separator = ' ';
      }
      const names = event.files.map(baseName).join(', ');
      return step(say(next, 'filesAdded', { names }));
    }
    case 'editorDone': {
      const free: BoxState = { ...current, busy: undefined };
      const { result } = event;
      switch (result.kind) {
        case 'edited':
          return step({
            ...free,
            editor: { ...createEditor(result.text), killed: free.editor.killed },
          });
        case 'off':
          return step(say(free, 'editorOff'));
        case 'missing':
          return step(say(free, 'editorMissing'));
        case 'failed':
          return step(say(free, 'editorFailed', { message: result.message }));
      }
      break;
    }
    case 'historyLoaded': {
      // What was sent before the file was read goes after what was already saved.
      const loaded = event.texts.map((text): HistoryEntry => ({ text, drafts: [] }));
      const nav = { ...current.nav, entries: [...loaded, ...current.nav.entries] };
      return step({
        ...current,
        nav: { ...nav, index: nav.index === null ? null : nav.index + loaded.length },
      });
    }
    case 'historyFailed':
      return step(say(current, 'historyFailed', { message: event.message }));
    case 'submitFailed': {
      const restored: BoxState =
        current.editor.text === ''
          ? {
              ...current,
              editor: { ...createEditor(event.sent.text), killed: current.editor.killed },
              drafts: event.sent.drafts,
              sequence: nextMarkerNumber(current.sequence, event.sent.drafts) - 1,
            }
          : current;
      return step(say(restored, 'submitFailed', { message: event.message }));
    }
  }
  return step(current);
}
