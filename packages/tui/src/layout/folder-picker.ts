// SPDX-License-Identifier: MPL-2.0
import { basename, dirname, resolve } from 'node:path';

/**
 * The folder browser of "New scenario" (N332 item 1 and 4): the model and the transitions of its
 * state, with no Ink and no `node:fs` (the folders come through {@link FolderFs}, so a test gives
 * a fake one). One key press is one step of {@link pickerStep}, which answers the new state and,
 * when the person did something the prompt must act on, an effect (choose a folder, close, go
 * back to the path field, save the favorites). The keys are [proposta] where the owner fixed none:
 * - the owner's (N332): Up/Down walk, Enter goes into the folder, Left goes up to the parent,
 *   Space chooses the folder, `/` goes back to the field of the path, `.` shows or hides the
 *   hidden folders, `~` goes to the home folder, typing filters; Esc closes the prompt;
 * - [proposta] PageUp/PageDown/Home/End walk faster; Ctrl+R goes up to the root of the Git
 *   repository the folder is in; Ctrl+F marks or unmarks the folder as a favorite; Ctrl+U clears the
 *   filter. `r` and `f` are letters of the filter, so the two actions that would be natural on them
 *   are on Ctrl.
 */

/** What a folder says about Git: it has a `.git` (a folder, or a file in a worktree). */
export interface GitMark {
  /** The branch, the short hash of a detached HEAD, or `''` when HEAD could not be read. */
  readonly ref: string;
  readonly detached: boolean;
  /** `.git` is a file (`gitdir: ...`): a linked worktree or a submodule. */
  readonly worktree: boolean;
}

export type FolderListing =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly code: string };

/** What the browser needs of the disk. The real one is `nodeFolderFs`; a test gives a fake. */
export interface FolderFs {
  readonly home: string;
  isDirectory(path: string): boolean;
  /** The names of the subfolders of `dir` (not the files), in any order, or why it could not be read. */
  list(dir: string): FolderListing;
  /** The Git mark of `dir` itself, or `undefined` when it has no `.git`. */
  git(dir: string): GitMark | undefined;
  /** Windows: the roots of the drives that exist (`C:\`). Without it, the root of the disk has no parent to show. */
  drives?(): readonly string[];
}

/** `HEAD` of a repository: `ref: refs/heads/main` is a branch, a hash is a detached HEAD [proposta: 7 characters]. */
export function parseGitHead(content: string): { ref: string; detached: boolean } {
  const text = content.trim();
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
  if (branch !== null) return { ref: (branch[1] ?? '').trim(), detached: false };
  const other = /^ref:\s*(?:refs\/)?(.+)$/.exec(text);
  if (other !== null) return { ref: (other[1] ?? '').trim(), detached: false };
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(text)) return { ref: text.slice(0, 7), detached: true };
  return { ref: '', detached: false };
}

/** The folder a `.git` file points to (`gitdir: ../x/.git/worktrees/y`), or `undefined`. */
export function parseGitdirFile(content: string): string | undefined {
  const found = /^gitdir:\s*(.+)$/m.exec(content);
  const path = found?.[1]?.trim();
  return path === undefined || path === '' ? undefined : path;
}

export interface FolderEntry {
  readonly name: string;
  readonly path: string;
  readonly git: GitMark | undefined;
}

/** The text of a row of the list: what it stands for. */
export type PickerRow =
  | {
      readonly kind: 'header';
      readonly key: string;
      readonly section: 'shortcuts' | 'folders' | 'drives';
    }
  | {
      readonly kind: 'shortcut';
      readonly key: string;
      readonly path: string;
      readonly favorite: boolean;
      readonly project: boolean;
      readonly git: GitMark | undefined;
    }
  | {
      readonly kind: 'here';
      readonly key: string;
      readonly path: string;
      readonly favorite: boolean;
      readonly git: GitMark | undefined;
    }
  | {
      readonly kind: 'folder';
      readonly key: string;
      readonly path: string;
      readonly name: string;
      readonly favorite: boolean;
      readonly git: GitMark | undefined;
    }
  | { readonly kind: 'drive'; readonly key: string; readonly path: string };

export interface PickerState {
  readonly view: 'folders' | 'drives';
  /** The folder being read (in the view of the drives: the one the person left). */
  readonly dir: string;
  /** Its subfolders, hidden ones included, in alphabetical order without regard to case. */
  readonly entries: readonly FolderEntry[];
  /** The drives, in the view of the drives. */
  readonly drives: readonly string[];
  /** The code of why `dir` could not be read (`EACCES`), or `undefined`. */
  readonly unreadable: string | undefined;
  /** The Git mark of `dir` itself. */
  readonly here: GitMark | undefined;
  /** The root of the Git repository `dir` is inside of, when `dir` is not that root. */
  readonly root: string | undefined;
  readonly filter: string;
  readonly showHidden: boolean;
  /** The key of the row under the cursor; a key no row has anymore falls back to the first folder. */
  readonly selected: string;
}

/** What the steps need besides the state; they change from one key press to the next. */
export interface PickerContext {
  readonly fs: FolderFs;
  /** The folders of the projects already open (shortcuts). */
  readonly projects: readonly string[];
  /** The folders marked as favorite (`ui.newProject.favorites`). */
  readonly favorites: readonly string[];
  /** The rows the list shows: a page is that many minus one. */
  readonly height: number;
}

/** What the prompt must do after a key. */
export type PickerEffect =
  | { readonly type: 'choose'; readonly path: string }
  | { readonly type: 'close' }
  | { readonly type: 'path' }
  | { readonly type: 'favorites'; readonly favorites: readonly string[] };

export interface PickerStep {
  readonly state: PickerState;
  readonly effect?: PickerEffect;
}

/** [proposta] The most favorites kept (the schema of `ui.newProject.favorites` takes as many). */
export const FAVORITES_MAX = 64;

const HERE_KEY = 'h';

/** A state with nothing read: what the prompt holds while the browser is off (`ui.newProject.picker: path`). */
export const EMPTY_PICKER_STATE: PickerState = {
  view: 'folders',
  dir: '',
  entries: [],
  drives: [],
  unreadable: undefined,
  here: undefined,
  root: undefined,
  filter: '',
  showHidden: false,
  selected: HERE_KEY,
};

/** The folders of the projects open (`kind: project`, active), the most recently touched first, each once. */
export function openProjectFolders(
  scenarios: Readonly<
    Record<
      string,
      {
        readonly kind: string;
        readonly state: string;
        readonly folder: string;
        readonly updatedAt: number;
      }
    >
  >,
): string[] {
  const projects = Object.values(scenarios)
    .filter((scenario) => scenario.kind === 'project' && scenario.state === 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const folders: string[] = [];
  for (const project of projects) {
    if (!folders.some((folder) => sameFolder(folder, project.folder))) folders.push(project.folder);
  }
  return folders;
}

// ---- Reading a folder -----------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

function byName(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** The state of the browser on `dir`, with its subfolders read and the filter cleared. */
export function loadFolder(
  fs: FolderFs,
  dir: string,
  showHidden: boolean,
  selected: string = HERE_KEY,
): PickerState {
  const listing = fs.list(dir);
  const entries: FolderEntry[] = listing.ok
    ? [...listing.names].sort(byName).map((name) => {
        const path = resolve(dir, name);
        return { name, path, git: fs.git(path) };
      })
    : [];
  const here = fs.git(dir);
  return {
    view: 'folders',
    dir,
    entries,
    drives: [],
    unreadable: listing.ok ? undefined : listing.code,
    here,
    root: here === undefined ? gitRootAbove(fs, dir) : undefined,
    filter: '',
    showHidden,
    selected,
  };
}

/** The nearest folder above `dir` that has a `.git`, or `undefined`. */
export function gitRootAbove(fs: FolderFs, dir: string): string | undefined {
  let current = dir;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    if (fs.git(parent) !== undefined) return parent;
    current = parent;
  }
}

/**
 * The folder the browser starts on: `wanted` when it exists, else the nearest of its parents that
 * does, and the home folder for an empty text.
 */
export function startFolder(fs: FolderFs, wanted: string): string {
  if (wanted === '') return fs.home;
  let current = wanted;
  while (!fs.isDirectory(current)) {
    const parent = dirname(current);
    if (parent === current) return fs.home;
    current = parent;
  }
  return current;
}

/** The first state of the browser: on `wanted` (see {@link startFolder}), with the hidden folders as the key says. */
export function initialPickerState(fs: FolderFs, wanted: string, showHidden: boolean): PickerState {
  return loadFolder(fs, startFolder(fs, wanted), showHidden);
}

// ---- The rows -------------------------------------------------------------------------------------

function sameFolder(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function matches(name: string, filter: string): boolean {
  return filter === '' || name.toLowerCase().includes(filter.toLowerCase());
}

/**
 * The shortcuts: the favorites first, then the projects already open that are not favorites. A
 * folder that does not exist anymore is left out [proposta].
 */
export function shortcutsOf(
  context: PickerContext,
  filter: string,
): Extract<PickerRow, { kind: 'shortcut' }>[] {
  const found: Extract<PickerRow, { kind: 'shortcut' }>[] = [];
  const add = (path: string, favorite: boolean, project: boolean): void => {
    const full = resolve(path);
    const same = found.find((row) => row.path === full);
    if (same !== undefined) {
      // The same folder is both: one row that says so.
      found[found.indexOf(same)] = {
        ...same,
        favorite: same.favorite || favorite,
        project: same.project || project,
      };
      return;
    }
    if (!context.fs.isDirectory(full) || !matches(basename(full) || full, filter)) return;
    found.push({
      kind: 'shortcut',
      key: `s:${full}`,
      path: full,
      favorite,
      project,
      git: context.fs.git(full),
    });
  };
  for (const path of context.favorites) add(path, true, false);
  for (const path of context.projects) add(path, false, true);
  return found;
}

/** The rows of the list, in the order they are drawn: headers are drawn but never selected. */
export function pickerRows(state: PickerState, context: PickerContext): PickerRow[] {
  if (state.view === 'drives') {
    return [
      { kind: 'header', key: 'hd', section: 'drives' },
      ...state.drives.map((path): PickerRow => ({ kind: 'drive', key: `d:${path}`, path })),
    ];
  }
  const rows: PickerRow[] = [];
  const shortcuts = shortcutsOf(context, state.filter);
  if (shortcuts.length > 0) {
    rows.push({ kind: 'header', key: 'hs', section: 'shortcuts' }, ...shortcuts);
  }
  rows.push({ kind: 'header', key: 'hf', section: 'folders' });
  const isFavorite = (path: string): boolean =>
    context.favorites.some((favorite) => sameFolder(favorite, path));
  rows.push({
    kind: 'here',
    key: HERE_KEY,
    path: state.dir,
    favorite: isFavorite(state.dir),
    git: state.here,
  });
  for (const entry of state.entries) {
    if (!state.showHidden && entry.name.startsWith('.')) continue;
    if (!matches(entry.name, state.filter)) continue;
    rows.push({
      kind: 'folder',
      key: `f:${entry.path}`,
      path: entry.path,
      name: entry.name,
      favorite: isFavorite(entry.path),
      git: entry.git,
    });
  }
  return rows;
}

function selectable(rows: readonly PickerRow[]): PickerRow[] {
  return rows.filter((row) => row.kind !== 'header');
}

/** The index in `rows` of the row under the cursor (the first folder when its key has no row anymore). */
export function selectedIndex(rows: readonly PickerRow[], state: PickerState): number {
  const at = rows.findIndex((row) => row.key === state.selected && row.kind !== 'header');
  if (at >= 0) return at;
  const folder = rows.findIndex((row) => row.kind === 'folder');
  if (folder >= 0) return folder;
  return Math.max(
    0,
    rows.findIndex((row) => row.kind !== 'header'),
  );
}

/** The row under the cursor. */
export function selectedRow(
  rows: readonly PickerRow[],
  state: PickerState,
): Exclude<PickerRow, { kind: 'header' }> | undefined {
  const row = rows[selectedIndex(rows, state)];
  return row === undefined || row.kind === 'header' ? undefined : row;
}

/** The part of `rows` that fits in `height` lines with the cursor in view (the cursor goes to the middle). */
export function pickerWindow(
  rows: readonly PickerRow[],
  state: PickerState,
  height: number,
): { start: number; end: number } {
  const size = Math.max(1, height);
  const at = selectedIndex(rows, state);
  const start = Math.max(0, Math.min(at - Math.floor(size / 2), rows.length - size));
  return { start, end: Math.min(rows.length, start + size) };
}

// ---- The steps ------------------------------------------------------------------------------------

/** The text a key press types into the filter: letters, digits, `-` and `_` (a paste may bring several). */
export function filterText(combo: string | undefined, data: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(data)) return data;
  if (combo === undefined) return '';
  const shifted = /^Shift\+([A-Z])$/.exec(combo);
  if (shifted !== null) return shifted[1] ?? '';
  if (/^[A-Z]$/.test(combo)) return combo.toLowerCase();
  return /^[0-9_-]$/.test(combo) ? combo : '';
}

function withKey(state: PickerState, selected: string): PickerState {
  return { ...state, selected };
}

function moveTo(rows: readonly PickerRow[], state: PickerState, delta: number): PickerState {
  const options = selectable(rows);
  if (options.length === 0) return state;
  const current = options.findIndex(
    (row) => row.key === (rows[selectedIndex(rows, state)]?.key ?? ''),
  );
  const next = Math.max(0, Math.min(options.length - 1, Math.max(0, current) + delta));
  return withKey(state, options[next]?.key ?? state.selected);
}

/** The state after the filter or the hidden folders changed: the cursor goes to the first folder when its row is gone. */
function settled(state: PickerState, context: PickerContext): PickerState {
  const rows = pickerRows(state, context);
  const there = rows.some((row) => row.key === state.selected && row.kind !== 'header');
  if (there) return state;
  const folder = rows.find((row) => row.kind === 'folder');
  const first = folder ?? selectable(rows)[0];
  return first === undefined ? state : withKey(state, first.key);
}

function enterFolder(
  state: PickerState,
  context: PickerContext,
  path: string,
  selected: string = HERE_KEY,
): PickerState {
  if (!context.fs.isDirectory(path)) return state;
  return loadFolder(context.fs, path, state.showHidden, selected);
}

/** The favorites after the folder `path` was marked, or unmarked if it was. */
export function toggleFavorite(favorites: readonly string[], path: string): readonly string[] {
  if (favorites.some((favorite) => sameFolder(favorite, path))) {
    return favorites.filter((favorite) => !sameFolder(favorite, path));
  }
  return favorites.length >= FAVORITES_MAX ? favorites : [...favorites, resolve(path)];
}

function up(state: PickerState, context: PickerContext): PickerState {
  if (state.view === 'drives') return state;
  const parent = dirname(state.dir);
  if (parent !== state.dir) {
    return enterFolder(state, context, parent, `f:${resolve(state.dir)}`);
  }
  const drives = context.fs.drives?.();
  if (drives === undefined) return state;
  const mine = drives.find((drive) => sameFolder(drive, state.dir));
  return {
    ...state,
    view: 'drives',
    drives,
    filter: '',
    selected: mine === undefined ? '' : `d:${mine}`,
    unreadable: undefined,
  };
}

/** One key press: the next state and what the prompt must do (nothing, usually). */
export function pickerStep(
  state: PickerState,
  event: { readonly combo: string | undefined; readonly data: string },
  context: PickerContext,
): PickerStep {
  const rows = pickerRows(state, context);
  const row = selectedRow(rows, state);
  const page = Math.max(1, context.height - 1);
  const done = (next: PickerState, effect?: PickerEffect): PickerStep => {
    const settledState = settled(next, context);
    return effect === undefined ? { state: settledState } : { state: settledState, effect };
  };
  switch (event.combo) {
    case 'Esc':
      return { state, effect: { type: 'close' } };
    case 'Up':
      return done(moveTo(rows, state, -1));
    case 'Down':
      return done(moveTo(rows, state, 1));
    case 'PageUp':
      return done(moveTo(rows, state, -page));
    case 'PageDown':
      return done(moveTo(rows, state, page));
    case 'Home':
      return done(moveTo(rows, state, -rows.length));
    case 'End':
      return done(moveTo(rows, state, rows.length));
    case 'Left':
      return done(up(state, context));
    case 'Enter':
      if (row === undefined || row.kind === 'here') return { state };
      return done(enterFolder(state, context, row.path));
    case 'Space': {
      if (row === undefined) return { state };
      // A drive is not a folder to open a project on: Space goes into it, like Enter.
      if (row.kind === 'drive') return done(enterFolder(state, context, row.path));
      return { state, effect: { type: 'choose', path: row.path } };
    }
    case 'Backspace':
      return done({ ...state, filter: Array.from(state.filter).slice(0, -1).join('') });
    case 'Ctrl+U':
      return done({ ...state, filter: '' });
    case 'Ctrl+R':
      return state.root === undefined ? { state } : done(enterFolder(state, context, state.root));
    case 'Ctrl+F': {
      if (row === undefined || row.kind === 'drive') return { state };
      return {
        state,
        effect: { type: 'favorites', favorites: toggleFavorite(context.favorites, row.path) },
      };
    }
    case '/':
      return { state, effect: { type: 'path' } };
    case '~':
      return done(enterFolder(state, context, context.fs.home));
    case '.':
      return done({ ...state, showHidden: !state.showHidden });
    default:
      break;
  }
  const typed = filterText(event.combo, event.data);
  if (typed === '' || state.view === 'drives') return { state };
  const next = { ...state, filter: state.filter + typed };
  // The cursor goes to the first folder that matches, which is where the person is heading.
  const first = pickerRows(next, context).find((candidate) => candidate.kind === 'folder');
  return done(first === undefined ? next : withKey(next, first.key));
}
