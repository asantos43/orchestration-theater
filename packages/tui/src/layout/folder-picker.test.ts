// SPDX-License-Identifier: MPL-2.0
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAVORITES_MAX,
  filterText,
  initialPickerState,
  loadFolder,
  openProjectFolders,
  parseGitdirFile,
  parseGitHead,
  pickerRows,
  pickerStep,
  pickerWindow,
  selectedRow,
  startFolder,
  toggleFavorite,
  type FolderFs,
  type GitMark,
  type PickerContext,
  type PickerState,
} from './folder-picker.js';

/**
 * The model of the folder browser (N332) with a fake disk: nothing here touches the real one. The
 * paths go through `resolve`, so the tests hold on the systems whose separator is not `/`.
 */

const HOME = resolve('/home/ana');

interface Disk {
  /** `dir` to the names of its subfolders. */
  readonly dirs: Record<string, readonly string[]>;
  readonly git?: Record<string, GitMark>;
  /** `dir` to the code its reading fails with. */
  readonly denied?: Record<string, string>;
  readonly drives?: readonly string[];
}

function fakeFs(disk: Disk): FolderFs {
  const dirs = new Map(Object.entries(disk.dirs).map(([dir, names]) => [resolve(dir), names]));
  const git = new Map(Object.entries(disk.git ?? {}).map(([dir, mark]) => [resolve(dir), mark]));
  const denied = new Map(
    Object.entries(disk.denied ?? {}).map(([dir, code]) => [resolve(dir), code]),
  );
  const drives = disk.drives;
  return {
    home: HOME,
    isDirectory: (path) => dirs.has(resolve(path)) || denied.has(resolve(path)),
    list: (dir) => {
      const code = denied.get(resolve(dir));
      if (code !== undefined) return { ok: false, code };
      const names = dirs.get(resolve(dir));
      return names === undefined ? { ok: false, code: 'ENOENT' } : { ok: true, names };
    },
    git: (dir) => git.get(resolve(dir)),
    ...(drives === undefined ? {} : { drives: () => drives }),
  };
}

const BRANCH = (ref: string): GitMark => ({ ref, detached: false, worktree: false });

const DISK: Disk = {
  dirs: {
    '/home/ana': ['work', 'Docs', '.config', 'apps', 'music'],
    '/home/ana/work': ['api', 'web'],
    '/home/ana/work/api': ['src', 'docs'],
    '/home/ana/work/api/src': [],
    '/home/ana/work/api/docs': [],
    '/home/ana/work/web': [],
    '/home/ana/Docs': [],
    '/home/ana/.config': ['tool'],
    '/home/ana/.config/tool': [],
    '/home/ana/apps': [],
    '/home/ana/music': [],
    '/srv': ['data'],
    '/srv/data': [],
    '/': ['home', 'srv'],
    '/home': ['ana'],
  },
  git: {
    '/home/ana/work/api': BRANCH('main'),
    '/home/ana/work/web': { ref: 'a1b2c3d', detached: true, worktree: true },
  },
};

function context(over: Partial<PickerContext> & { fs?: FolderFs } = {}): PickerContext {
  return { fs: fakeFs(DISK), projects: [], favorites: [], height: 8, ...over };
}

function key(combo: string, data: string = combo): { combo: string; data: string } {
  return { combo, data };
}

/** Types text a letter at a time, as the terminal delivers it (the combo of a letter is uppercase). */
function typed(state: PickerState, text: string, ctx: PickerContext): PickerState {
  let current = state;
  for (const char of text) {
    const combo = /[a-z]/.test(char) ? char.toUpperCase() : char;
    current = pickerStep(current, key(combo, char), ctx).state;
  }
  return current;
}

function names(state: PickerState, ctx: PickerContext): string[] {
  return pickerRows(state, ctx).flatMap((row) => (row.kind === 'folder' ? [row.name] : []));
}

function cursor(state: PickerState, ctx: PickerContext): string {
  const row = selectedRow(pickerRows(state, ctx), state);
  if (row === undefined) return '';
  return row.kind === 'folder' ? row.name : row.kind;
}

describe('parseGitHead and parseGitdirFile', () => {
  it('reads a branch, a detached hash and what it cannot read', () => {
    expect(parseGitHead('ref: refs/heads/feature/x\n')).toEqual({
      ref: 'feature/x',
      detached: false,
    });
    expect(parseGitHead('0123456789abcdef0123456789abcdef01234567\n')).toEqual({
      ref: '0123456',
      detached: true,
    });
    expect(parseGitHead(`${'a'.repeat(64)}\n`)).toEqual({ ref: 'aaaaaaa', detached: true });
    expect(parseGitHead('')).toEqual({ ref: '', detached: false });
    expect(parseGitHead('not a head')).toEqual({ ref: '', detached: false });
  });

  it('reads where a .git file points to', () => {
    expect(parseGitdirFile('gitdir: ../main/.git/worktrees/x\n')).toBe('../main/.git/worktrees/x');
    expect(parseGitdirFile('nothing here')).toBeUndefined();
    expect(parseGitdirFile('gitdir:   \n')).toBeUndefined();
  });
});

describe('where the browser starts', () => {
  it('starts on the folder, on its nearest parent that exists, or at home', () => {
    const fs = fakeFs(DISK);
    expect(startFolder(fs, resolve('/home/ana/work/api'))).toBe(resolve('/home/ana/work/api'));
    expect(startFolder(fs, resolve('/home/ana/work/gone/deeper'))).toBe(resolve('/home/ana/work'));
    expect(startFolder(fs, '')).toBe(HOME);
    expect(initialPickerState(fs, '', false).dir).toBe(HOME);
  });
});

describe('reading a folder', () => {
  it('lists the folders in alphabetical order without regard to case, and marks the Git ones', () => {
    const ctx = context();
    const state = loadFolder(ctx.fs, resolve('/home/ana/work'), false);
    expect(names(state, ctx)).toEqual(['api', 'web']);
    const api = pickerRows(state, ctx).find((row) => row.kind === 'folder' && row.name === 'api');
    expect(api).toMatchObject({ git: { ref: 'main', detached: false, worktree: false } });
    const web = pickerRows(state, ctx).find((row) => row.kind === 'folder' && row.name === 'web');
    expect(web).toMatchObject({ git: { ref: 'a1b2c3d', detached: true, worktree: true } });

    const home = loadFolder(ctx.fs, HOME, true);
    expect(names(home, ctx)).toEqual(['.config', 'apps', 'Docs', 'music', 'work']);
  });

  it('hides the hidden folders until the dot shows them', () => {
    const ctx = context();
    let state = loadFolder(ctx.fs, HOME, false);
    expect(names(state, ctx)).toEqual(['apps', 'Docs', 'music', 'work']);
    state = pickerStep(state, key('.'), ctx).state;
    expect(state.showHidden).toBe(true);
    expect(names(state, ctx)).toContain('.config');
    state = pickerStep(state, key('.'), ctx).state;
    expect(names(state, ctx)).not.toContain('.config');
  });

  it('shows the folder itself as Git when it is one, and offers the root when it is inside one', () => {
    const ctx = context();
    const root = loadFolder(ctx.fs, resolve('/home/ana/work/api'), false);
    expect(root.here).toMatchObject({ ref: 'main' });
    expect(root.root).toBeUndefined();
    const inside = loadFolder(ctx.fs, resolve('/home/ana/work/api/src'), false);
    expect(inside.here).toBeUndefined();
    expect(inside.root).toBe(resolve('/home/ana/work/api'));
    const outside = loadFolder(ctx.fs, HOME, false);
    expect(outside.root).toBeUndefined();
  });

  it('goes up to the root of the repository with Ctrl+R, and does nothing out of one', () => {
    const ctx = context();
    const inside = loadFolder(ctx.fs, resolve('/home/ana/work/api/src'), false);
    const up = pickerStep(inside, key('Ctrl+R'), ctx).state;
    expect(up.dir).toBe(resolve('/home/ana/work/api'));
    expect(up.root).toBeUndefined();
    const outside = loadFolder(ctx.fs, HOME, false);
    expect(pickerStep(outside, key('Ctrl+R'), ctx).state).toBe(outside);
  });

  it('says why a folder cannot be read and keeps walking', () => {
    const fs = fakeFs({ ...DISK, denied: { '/home/ana/music': 'EACCES' } });
    const ctx = context({ fs });
    let state = loadFolder(fs, HOME, false);
    state = typed(state, 'music', ctx);
    expect(cursor(state, ctx)).toBe('music');
    state = pickerStep(state, key('Enter'), ctx).state;
    expect(state.dir).toBe(resolve('/home/ana/music'));
    expect(state.unreadable).toBe('EACCES');
    expect(names(state, ctx)).toEqual([]);
    // The folder itself can still be chosen, and Left goes back.
    expect(pickerStep(state, key('Space', ' '), ctx).effect).toEqual({
      type: 'choose',
      path: resolve('/home/ana/music'),
    });
    expect(pickerStep(state, key('Left'), ctx).state.dir).toBe(HOME);
  });
});

describe('walking', () => {
  it('moves the cursor and stops at the ends', () => {
    const ctx = context();
    let state = loadFolder(ctx.fs, resolve('/home/ana/work'), false);
    expect(cursor(state, ctx)).toBe('here');
    state = pickerStep(state, key('Down'), ctx).state;
    expect(cursor(state, ctx)).toBe('api');
    state = pickerStep(state, key('Down'), ctx).state;
    expect(cursor(state, ctx)).toBe('web');
    state = pickerStep(state, key('Down'), ctx).state;
    expect(cursor(state, ctx)).toBe('web');
    state = pickerStep(state, key('Up'), ctx).state;
    state = pickerStep(state, key('Up'), ctx).state;
    state = pickerStep(state, key('Up'), ctx).state;
    expect(cursor(state, ctx)).toBe('here');
  });

  it('jumps with PageDown, PageUp, Home and End', () => {
    const ctx = context({ height: 3 });
    let state = loadFolder(ctx.fs, HOME, false);
    state = pickerStep(state, key('End'), ctx).state;
    expect(cursor(state, ctx)).toBe('work');
    state = pickerStep(state, key('Home'), ctx).state;
    expect(cursor(state, ctx)).toBe('here');
    state = pickerStep(state, key('PageDown'), ctx).state;
    expect(cursor(state, ctx)).toBe('Docs');
    state = pickerStep(state, key('PageUp'), ctx).state;
    expect(cursor(state, ctx)).toBe('here');
  });

  it('goes into a folder with Enter and back to its parent with Left, on the folder it left', () => {
    const ctx = context();
    let state = loadFolder(ctx.fs, HOME, false);
    state = typed(state, 'work', ctx);
    state = pickerStep(state, key('Enter'), ctx).state;
    expect(state.dir).toBe(resolve('/home/ana/work'));
    expect(state.filter).toBe('');
    state = pickerStep(state, key('Left'), ctx).state;
    expect(state.dir).toBe(HOME);
    expect(cursor(state, ctx)).toBe('work');
  });

  it('does nothing with Enter on the folder itself, and chooses it with Space', () => {
    const ctx = context();
    const state = loadFolder(ctx.fs, resolve('/home/ana/work'), false);
    expect(pickerStep(state, key('Enter'), ctx)).toEqual({ state });
    expect(pickerStep(state, key('Space', ' '), ctx).effect).toEqual({
      type: 'choose',
      path: resolve('/home/ana/work'),
    });
    const down = pickerStep(state, key('Down'), ctx).state;
    expect(pickerStep(down, key('Space', ' '), ctx).effect).toEqual({
      type: 'choose',
      path: resolve('/home/ana/work/api'),
    });
  });

  it('goes home with the tilde', () => {
    const ctx = context();
    const state = loadFolder(ctx.fs, resolve('/srv/data'), false);
    expect(pickerStep(state, key('~'), ctx).state.dir).toBe(HOME);
  });

  it('answers Esc with close and the slash with the field of the path', () => {
    const ctx = context();
    const state = loadFolder(ctx.fs, HOME, false);
    expect(pickerStep(state, key('Esc', '\x1b'), ctx).effect).toEqual({ type: 'close' });
    expect(pickerStep(state, key('/'), ctx).effect).toEqual({ type: 'path' });
  });

  it('stays where it is at the root of the disk when there are no drives', () => {
    const ctx = context();
    const state = loadFolder(ctx.fs, resolve('/'), false);
    expect(pickerStep(state, key('Left'), ctx).state.dir).toBe(resolve('/'));
    expect(pickerStep(state, key('Left'), ctx).state.view).toBe('folders');
  });
});

describe('the filter', () => {
  it('filters while typing, moves the cursor to the first match and erases with Backspace', () => {
    const ctx = context();
    let state = loadFolder(ctx.fs, HOME, false);
    state = typed(state, 'DO', ctx);
    expect(state.filter).toBe('DO');
    expect(names(state, ctx)).toEqual(['Docs']);
    expect(cursor(state, ctx)).toBe('Docs');
    state = typed(state, 'x', ctx);
    expect(names(state, ctx)).toEqual([]);
    state = pickerStep(state, key('Backspace', '\x7f'), ctx).state;
    expect(names(state, ctx)).toEqual(['Docs']);
    state = pickerStep(state, key('Ctrl+U', '\x15'), ctx).state;
    expect(state.filter).toBe('');
    expect(names(state, ctx)).toEqual(['apps', 'Docs', 'music', 'work']);
  });

  it('takes digits, the hyphen and the underscore, and a capital', () => {
    expect(filterText('A', 'a')).toBe('a');
    expect(filterText('Shift+A', 'A')).toBe('A');
    expect(filterText('3', '3')).toBe('3');
    expect(filterText('-', '-')).toBe('-');
    expect(filterText('_', '_')).toBe('_');
    expect(filterText(undefined, 'abc-1')).toBe('abc-1');
    expect(filterText('Ctrl+A', '\x01')).toBe('');
    expect(filterText('F5', '\x1b[15~')).toBe('');
    expect(filterText('Up', '\x1b[A')).toBe('');
  });

  it('keeps the letters of the shortcuts out of the way: r and f filter, Ctrl+R and Ctrl+F act', () => {
    const ctx = context();
    let state = loadFolder(ctx.fs, resolve('/home/ana/work/api/src'), false);
    state = typed(state, 'rf', ctx);
    expect(state.filter).toBe('rf');
    expect(state.dir).toBe(resolve('/home/ana/work/api/src'));
  });

  it('filters the shortcuts too', () => {
    const ctx = context({
      favorites: [resolve('/srv/data')],
      projects: [resolve('/home/ana/work/web')],
    });
    let state = loadFolder(ctx.fs, HOME, false);
    expect(pickerRows(state, ctx).filter((row) => row.kind === 'shortcut')).toHaveLength(2);
    state = typed(state, 'web', ctx);
    const shortcuts = pickerRows(state, ctx).flatMap((row) =>
      row.kind === 'shortcut' ? [row.path] : [],
    );
    expect(shortcuts).toEqual([resolve('/home/ana/work/web')]);
  });

  it('ignores typing in the view of the drives', () => {
    const ctx = context({ fs: fakeFs({ ...DISK, drives: ['C:\\', 'D:\\'] }) });
    const state = pickerStep(loadFolder(ctx.fs, resolve('/'), false), key('Left'), ctx).state;
    expect(state.view).toBe('drives');
    expect(pickerStep(state, key('X', 'x'), ctx).state).toBe(state);
  });
});

describe('the shortcuts', () => {
  it('lists the favorites first, then the open projects, each folder once', () => {
    const ctx = context({
      favorites: [resolve('/srv/data'), resolve('/home/ana/work/web')],
      projects: [resolve('/home/ana/work/web'), resolve('/home/ana/work/api')],
    });
    const rows = pickerRows(loadFolder(ctx.fs, HOME, false), ctx);
    expect(rows[0]).toMatchObject({ kind: 'header', section: 'shortcuts' });
    const shortcuts = rows.filter((row) => row.kind === 'shortcut');
    expect(shortcuts).toMatchObject([
      { path: resolve('/srv/data'), favorite: true, project: false },
      { path: resolve('/home/ana/work/web'), favorite: true, project: true },
      { path: resolve('/home/ana/work/api'), favorite: false, project: true },
    ]);
    expect(shortcuts[2]).toMatchObject({ git: { ref: 'main' } });
  });

  it('leaves out a folder that is gone, and has no section when there is nothing to show', () => {
    const ctx = context({ favorites: [resolve('/gone')], projects: [] });
    const rows = pickerRows(loadFolder(ctx.fs, HOME, false), ctx);
    expect(rows.some((row) => row.kind === 'shortcut')).toBe(false);
    expect(rows.some((row) => row.kind === 'header' && row.section === 'shortcuts')).toBe(false);
  });

  it('goes to a shortcut with Enter and chooses it with Space', () => {
    const ctx = context({ projects: [resolve('/home/ana/work/api')] });
    let state = loadFolder(ctx.fs, HOME, false);
    state = pickerStep(state, key('Home'), ctx).state;
    expect(selectedRow(pickerRows(state, ctx), state)).toMatchObject({ kind: 'shortcut' });
    expect(pickerStep(state, key('Space', ' '), ctx).effect).toEqual({
      type: 'choose',
      path: resolve('/home/ana/work/api'),
    });
    state = pickerStep(state, key('Enter'), ctx).state;
    expect(state.dir).toBe(resolve('/home/ana/work/api'));
  });

  it('marks and unmarks a favorite with Ctrl+F, on the folder under the cursor', () => {
    const ctx = context();
    let state = loadFolder(ctx.fs, resolve('/home/ana/work'), false);
    state = pickerStep(state, key('Down'), ctx).state;
    const added = pickerStep(state, key('Ctrl+F', '\x06'), ctx).effect;
    expect(added).toEqual({ type: 'favorites', favorites: [resolve('/home/ana/work/api')] });
    const again = context({ favorites: [resolve('/home/ana/work/api')] });
    const removed = pickerStep(state, key('Ctrl+F', '\x06'), again).effect;
    expect(removed).toEqual({ type: 'favorites', favorites: [] });
    // The row says so.
    const row = pickerRows(state, again).find((r) => r.kind === 'folder' && r.name === 'api');
    expect(row).toMatchObject({ favorite: true });
  });

  it('keeps at most FAVORITES_MAX favorites', () => {
    const full = Array.from({ length: FAVORITES_MAX }, (_, index) =>
      resolve(`/f/${String(index)}`),
    );
    expect(toggleFavorite(full, resolve('/x'))).toBe(full);
    expect(toggleFavorite(full, resolve('/f/3'))).toHaveLength(FAVORITES_MAX - 1);
  });

  it('takes the folders of the projects open: active projects, the latest first, each once', () => {
    const scenario = (kind: string, state: string, folder: string, updatedAt: number) => ({
      kind,
      state,
      folder,
      updatedAt,
    });
    expect(
      openProjectFolders({
        a: scenario('project', 'active', '/w/a', 1),
        b: scenario('project', 'active', '/w/b', 5),
        c: scenario('chat', 'active', '/w/c', 9),
        d: scenario('project', 'archived', '/w/d', 9),
        e: scenario('project', 'active', '/w/b', 3),
      }),
    ).toEqual(['/w/b', '/w/a']);
  });
});

describe('the drives of Windows', () => {
  it('shows the drives on Left at the root of a disk, and goes into one', () => {
    const fs = fakeFs({
      dirs: { '/': ['x'], '/x': [] },
      drives: [resolve('/'), resolve('/x')],
    });
    const ctx = context({ fs });
    const state = loadFolder(fs, resolve('/'), false);
    const drives = pickerStep(state, key('Left'), ctx).state;
    expect(drives.view).toBe('drives');
    expect(drives.drives).toEqual([resolve('/'), resolve('/x')]);
    const rows = pickerRows(drives, ctx);
    expect(rows.map((row) => row.kind)).toEqual(['header', 'drive', 'drive']);
    // The cursor is on the drive the person left.
    expect(selectedRow(rows, drives)).toMatchObject({ kind: 'drive', path: resolve('/') });
    // Left again stays, Down and Enter go into a drive; Space does the same (a drive is not chosen).
    expect(pickerStep(drives, key('Left'), ctx).state).toBe(drives);
    const second = pickerStep(drives, key('Down'), ctx).state;
    expect(pickerStep(second, key('Space', ' '), ctx).state.dir).toBe(resolve('/x'));
    const entered = pickerStep(second, key('Enter'), ctx).state;
    expect(entered.view).toBe('folders');
    expect(entered.dir).toBe(resolve('/x'));
  });
});

describe('the window of the list', () => {
  it('keeps the cursor in view and never goes past the ends', () => {
    const ctx = context();
    let state = loadFolder(ctx.fs, HOME, true);
    const rows = pickerRows(state, ctx);
    expect(pickerWindow(rows, state, 4)).toEqual({ start: 0, end: 4 });
    state = pickerStep(state, key('End'), ctx).state;
    const end = pickerWindow(pickerRows(state, ctx), state, 4);
    expect(end.end).toBe(rows.length);
    expect(end.end - end.start).toBe(4);
    expect(pickerWindow(rows, state, 100)).toEqual({ start: 0, end: rows.length });
  });
});
