// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import type { FolderInitMode, FolderState, InspectFolderResult } from '@otheater/protocol';
import { Box } from 'ink';
import { render, cleanup } from 'ink-testing-library';
import type { i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { plain } from '../ink.test-support.js';
import { createTuiI18n, loadTuiCatalogs } from '../locale.js';
import type { FolderFs, GitMark } from './folder-picker.js';
import { NewProjectPrompt, type NewScenarioRequest } from './new-project.js';
import { ThemeProvider } from './theme-context.js';

/**
 * The prompt of a new project with the folder browser (N332), mounted alone over a fake disk: the
 * keys of the browser, what it draws, how it hands over to the field of the path and back, and
 * what it asks the shell to open or to save. Every expected text comes from the catalog.
 */

afterEach(cleanup);

const posix = process.platform !== 'win32';

interface Disk {
  readonly dirs: Record<string, readonly string[]>;
  readonly git?: Record<string, GitMark>;
  readonly denied?: Record<string, string>;
}

function fakeFs(disk: Disk): FolderFs {
  return {
    home: '/home/ana',
    isDirectory: (path) => path in disk.dirs || (disk.denied !== undefined && path in disk.denied),
    list: (dir) => {
      const code = disk.denied?.[dir];
      if (code !== undefined) return { ok: false, code };
      const names = disk.dirs[dir];
      return names === undefined ? { ok: false, code: 'ENOENT' } : { ok: true, names };
    },
    git: (dir) => disk.git?.[dir],
  };
}

const DISK: Disk = {
  dirs: {
    '/': ['home'],
    '/home': ['ana'],
    '/home/ana': ['work', 'docs', '.config', 'locked'],
    '/home/ana/work': ['api', 'web'],
    '/home/ana/work/api': ['src'],
    '/home/ana/work/api/src': [],
    '/home/ana/work/web': [],
    '/home/ana/docs': [],
    '/home/ana/.config': [],
    '/home/ana/locked': [],
  },
  git: {
    '/home/ana/work/api': { ref: 'main', detached: false, worktree: false },
    '/home/ana/work/web': { ref: 'c0ffee1', detached: true, worktree: true },
  },
  denied: { '/home/ana/locked': 'EACCES' },
};

const KEY = {
  down: '\x1b[B',
  up: '\x1b[A',
  left: '\x1b[D',
  enter: '\r',
  esc: '\x1b',
  space: ' ',
  backspace: '\x7f',
  ctrlO: '\x0f',
  ctrlF: '\x06',
  ctrlR: '\x12',
  tab: '\t',
} as const;

const pause = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let i18nEn: I18nInstance;
let i18nPt: I18nInstance;
beforeAll(async () => {
  i18nEn = await createTuiI18n('en', loadTuiCatalogs());
  i18nPt = await createTuiI18n('pt-BR', loadTuiCatalogs());
});

interface Mounted {
  readonly frame: () => string;
  readonly press: (keys: string) => Promise<void>;
  readonly opened: NewScenarioRequest[];
  readonly inspected: string[];
  readonly closed: () => number;
  readonly saved: (readonly string[])[];
  readonly T: (key: string, vars?: Record<string, unknown>) => string;
}

interface Options {
  readonly picker?: 'browser' | 'path';
  readonly initial?: string;
  readonly projects?: readonly string[];
  readonly favorites?: readonly string[];
  readonly showHidden?: boolean;
  readonly startInField?: boolean;
  readonly rows?: number;
  readonly fail?: Error | ((request: NewScenarioRequest) => Error | undefined);
  /** The inspection of the folder (N332); without it the prompt opens as before. */
  readonly inspect?: (path: string) => Promise<InspectFolderResult>;
  readonly pt?: boolean;
  readonly disk?: Disk;
}

async function mount(options: Options = {}): Promise<Mounted> {
  const opened: NewScenarioRequest[] = [];
  const inspected: string[] = [];
  const saved: (readonly string[])[] = [];
  let closed = 0;
  const i18n = options.pt === true ? i18nPt : i18nEn;
  const capture = { current: false };
  const view = render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider mode="terminal">
        {/* The overlay is absolute: it needs a screen to sit on. */}
        <Box width={100} height={options.rows ?? 40}>
          <NewProjectPrompt
            screen={{ columns: 100, rows: options.rows ?? 40 }}
            initial={options.initial ?? '/home/ana/work'}
            initialType="project"
            cwd="/home/ana/work"
            open={(request) => {
              opened.push(request);
              const failure =
                typeof options.fail === 'function' ? options.fail(request) : options.fail;
              return failure === undefined ? Promise.resolve() : Promise.reject(failure);
            }}
            {...(options.inspect === undefined
              ? {}
              : {
                  inspect: (path: string) => {
                    inspected.push(path);
                    return options.inspect?.(path) ?? Promise.reject(new Error('no inspect'));
                  },
                })}
            onClose={() => {
              closed += 1;
            }}
            capture={capture}
            picker={options.picker ?? 'browser'}
            showHidden={options.showHidden ?? false}
            projects={options.projects ?? []}
            favorites={options.favorites ?? []}
            onFavorites={(next) => saved.push(next)}
            startInField={options.startInField ?? false}
            fs={fakeFs(options.disk ?? DISK)}
          />
        </Box>
      </ThemeProvider>
    </I18nextProvider>,
  );
  await pause(80);
  const T = (key: string, vars?: Record<string, unknown>): string =>
    (i18n.t as (key: string, vars?: Record<string, unknown>) => string)(key, vars);
  return {
    frame: () => plain(view.lastFrame() ?? ''),
    press: async (keys) => {
      view.stdin.write(keys);
      await pause();
    },
    opened,
    inspected,
    closed: () => closed,
    saved,
    T,
  };
}

describe.skipIf(!posix)('the folder browser in the prompt', () => {
  it('opens in the browser on the folder of the field, with the list and the hint', async () => {
    const app = await mount();
    const frame = app.frame();
    expect(frame).toContain(app.T('layout.newProject.picker.dir', { dir: '/home/ana/work' }));
    expect(frame).toContain(app.T('layout.newProject.picker.sections.folders'));
    expect(frame).toContain(app.T('layout.newProject.picker.here'));
    expect(frame).toContain('api');
    expect(frame).toContain('web');
    expect(frame).toContain(app.T('layout.newProject.picker.hintMove'));
    expect(frame).toContain(app.T('layout.newProject.picker.hintMore'));
    // The field of the path is not on screen.
    expect(frame).not.toContain(app.T('layout.newProject.label'));
  });

  it('marks the repositories with their branch, a detached HEAD and a worktree', async () => {
    const app = await mount();
    const frame = app.frame();
    expect(frame).toContain(`[${app.T('layout.newProject.picker.git', { ref: 'main' })}]`);
    const detached = app.T('layout.newProject.picker.gitDetached', { ref: 'c0ffee1' });
    expect(frame).toContain(app.T('layout.newProject.picker.worktree', { label: detached }));
  });

  it('walks with the arrows, goes in with Enter and up with Left', async () => {
    const app = await mount({ initial: '/home/ana' });
    await app.press(KEY.down);
    await app.press(KEY.enter);
    // The cursor was on the first folder in alphabetical order, `docs`.
    expect(app.frame()).toContain(app.T('layout.newProject.picker.dir', { dir: '/home/ana/docs' }));
    expect(app.frame()).toContain(app.T('layout.newProject.picker.empty'));
    await app.press(KEY.left);
    expect(app.frame()).toContain(app.T('layout.newProject.picker.dir', { dir: '/home/ana' }));
  });

  it('chooses the folder with Space and opens the project through the same route', async () => {
    const app = await mount();
    await app.press(KEY.down);
    await app.press(KEY.space);
    expect(app.opened).toEqual([{ type: 'project', repo: '/home/ana/work/api' }]);
    expect(app.closed()).toBe(1);
  });

  it('chooses the folder it is on when the cursor is on "this folder"', async () => {
    const app = await mount();
    await app.press(KEY.space);
    expect(app.opened).toEqual([{ type: 'project', repo: '/home/ana/work' }]);
  });

  it('shows a refusal in the browser and stays open for another try', async () => {
    const app = await mount({ fail: new Error('boom') });
    await app.press(KEY.space);
    expect(app.frame()).toContain(app.T('layout.newProject.failed', { message: 'boom' }));
    expect(app.frame()).toContain(app.T('layout.newProject.picker.sections.folders'));
    expect(app.closed()).toBe(0);
    // The next key clears the message.
    await app.press(KEY.down);
    expect(app.frame()).not.toContain('boom');
  });

  it('filters while typing, erases with Backspace, and Esc closes the prompt', async () => {
    const app = await mount();
    await app.press('w');
    await app.press('e');
    expect(app.frame()).toContain(app.T('layout.newProject.picker.filter', { text: 'we' }));
    expect(app.frame()).not.toContain('api');
    await app.press('x');
    expect(app.frame()).toContain(app.T('layout.newProject.picker.noMatch'));
    for (let index = 0; index < 3; index += 1) await app.press(KEY.backspace);
    expect(app.frame()).toContain('api');
    await app.press(KEY.esc);
    expect(app.closed()).toBe(1);
  });

  it('shows the hidden folders with the dot, and starts showing them with ui.newProject.hidden', async () => {
    const hidden = await mount({ initial: '/home/ana' });
    expect(hidden.frame()).not.toContain('.config');
    expect(hidden.frame()).toContain(app_hidden(hidden, false));
    await hidden.press('.');
    expect(hidden.frame()).toContain('.config');
    expect(hidden.frame()).toContain(app_hidden(hidden, true));
    cleanup();
    const shown = await mount({ initial: '/home/ana', showHidden: true });
    expect(shown.frame()).toContain('.config');
  });

  it('goes home with the tilde', async () => {
    const app = await mount();
    await app.press('~');
    expect(app.frame()).toContain(app.T('layout.newProject.picker.dir', { dir: '/home/ana' }));
  });

  it('warns about a folder it cannot read, and goes back', async () => {
    const app = await mount({ initial: '/home/ana' });
    for (const char of 'locked') await app.press(char);
    await app.press(KEY.enter);
    expect(app.frame()).toContain(app.T('layout.newProject.picker.unreadable', { code: 'EACCES' }));
    await app.press(KEY.left);
    expect(app.frame()).toContain(app.T('layout.newProject.picker.dir', { dir: '/home/ana' }));
  });

  it('offers to go up to the root of the repository, and goes with Ctrl+R', async () => {
    const app = await mount({ initial: '/home/ana/work/api/src' });
    expect(app.frame()).toContain(
      app.T('layout.newProject.picker.root', { root: '/home/ana/work/api' }),
    );
    await app.press(KEY.ctrlR);
    expect(app.frame()).toContain(
      app.T('layout.newProject.picker.dir', { dir: '/home/ana/work/api' }),
    );
    expect(app.frame()).not.toContain(app.T('layout.newProject.picker.root', { root: '' }).trim());
  });

  it('shows the shortcuts: favorites and the folders of the projects open', async () => {
    const app = await mount({
      projects: ['/home/ana/work/api'],
      favorites: ['/home/ana/docs'],
    });
    const frame = app.frame();
    expect(frame).toContain(app.T('layout.newProject.picker.sections.shortcuts'));
    expect(frame).toContain('/home/ana/docs');
    expect(frame).toContain('/home/ana/work/api');
    // Enter on a shortcut goes to it; the first row is the first favorite.
    await app.press(KEY.up);
    await app.press(KEY.up);
    await app.press(KEY.up);
    await app.press(KEY.up);
    await app.press(KEY.enter);
    expect(app.frame()).toContain(app.T('layout.newProject.picker.dir', { dir: '/home/ana/docs' }));
  });

  it('asks the shell to save a favorite with Ctrl+F', async () => {
    const app = await mount();
    await app.press(KEY.down);
    await app.press(KEY.ctrlF);
    expect(app.saved).toEqual([['/home/ana/work/api']]);
  });

  it('goes to the field of the path with the slash, on the folder it was on, and back with Ctrl+O', async () => {
    const app = await mount();
    await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.press('/');
    expect(app.frame()).toContain(app.T('layout.newProject.label'));
    expect(app.frame()).toContain('> /home/ana/work/api');
    expect(app.frame()).toContain(app.T('layout.newProject.hintField'));
    // In the field the keys are the ones of the field: Enter opens what is written.
    await app.press(KEY.ctrlO);
    expect(app.frame()).toContain(
      app.T('layout.newProject.picker.dir', { dir: '/home/ana/work/api' }),
    );
    expect(app.opened).toEqual([]);
    await app.press('/');
    await app.press(KEY.enter);
    expect(app.opened).toEqual([{ type: 'project', repo: '/home/ana/work/api' }]);
  });

  it('with the path given, opens in the field', async () => {
    const app = await mount({ startInField: true, initial: '/home/ana/docs' });
    expect(app.frame()).toContain('> /home/ana/docs');
    expect(app.frame()).not.toContain(app.T('layout.newProject.picker.sections.folders'));
    await app.press(KEY.ctrlO);
    expect(app.frame()).toContain(app.T('layout.newProject.picker.dir', { dir: '/home/ana/docs' }));
  });

  it('with picker: path, is the field alone, as before', async () => {
    const app = await mount({ picker: 'path' });
    expect(app.frame()).toContain('> /home/ana/work');
    expect(app.frame()).toContain(app.T('layout.newProject.hint'));
    await app.press(KEY.ctrlO);
    expect(app.frame()).not.toContain(app.T('layout.newProject.picker.sections.folders'));
    await app.press(KEY.enter);
    expect(app.opened).toEqual([{ type: 'project', repo: '/home/ana/work' }]);
  });

  it('the chat keeps its field, and coming back to the project keeps the browser where it was', async () => {
    const app = await mount();
    await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.press(KEY.tab);
    expect(app.frame()).toContain(app.T('layout.newProject.nameLabel'));
    await app.press(KEY.tab);
    expect(app.frame()).toContain(
      app.T('layout.newProject.picker.dir', { dir: '/home/ana/work/api' }),
    );
  });

  it('takes more rows than the field and scrolls the list on a short screen', async () => {
    const names = Array.from({ length: 40 }, (_, index) => `d${String(index).padStart(2, '0')}`);
    const disk: Disk = {
      dirs: { '/home/ana': names, ...Object.fromEntries(names.map((n) => [`/home/ana/${n}`, []])) },
    };
    const tall = await mount({ initial: '/home/ana', disk, rows: 40 });
    const tallLines = tall.frame().split('\n').length;
    expect(tall.frame()).toContain('d00');
    expect(tall.frame()).not.toContain('d39');
    cleanup();
    const short = await mount({ initial: '/home/ana', disk, rows: 20 });
    expect(short.frame().split('\n').length).toBeLessThanOrEqual(tallLines);
    await short.press('\x1b[F');
    expect(short.frame()).toContain('d39');
    expect(short.frame()).not.toContain('d00');
  });

  it('speaks Brazilian Portuguese', async () => {
    const app = await mount({ pt: true });
    expect(app.frame()).toContain(app.T('layout.newProject.picker.hintMove'));
    expect(app.frame()).toContain('Pasta: /home/ana/work');
  });
});

function app_hidden(app: Mounted, shown: boolean): string {
  return app.T(
    shown ? 'layout.newProject.picker.hiddenShown' : 'layout.newProject.picker.hiddenHidden',
  );
}

// N332 (step B2): what the prompt asks when the folder is not a repository yet.

function found(state: FolderState, initMode: FolderInitMode = 'ask') {
  return (path: string): Promise<InspectFolderResult> =>
    Promise.resolve({
      path,
      state,
      git: state === 'repo' || state === 'inside_repo' ? { root: path, branch: 'main' } : null,
      initMode,
    });
}

const needsInit = (): ApiRequestError =>
  new ApiRequestError({
    status: 400,
    body: {
      code: 'invalid_input',
      message: 'needs init',
      details: { reason: 'needs_init', choices: ['commit_all', 'empty_commit'] },
    },
  });

const FOLDER = '/home/ana/work/api';

/** The browser on `FOLDER`, ready to choose it with Space. */
const choose = async (app: Mounted): Promise<void> => {
  await app.press(KEY.down);
  await app.press(KEY.space);
};

describe.skipIf(!posix)('the question of a folder that is not a repository (N332)', () => {
  it('opens a repository, or a folder inside one, with no question', async () => {
    for (const state of ['repo', 'inside_repo'] as const) {
      const app = await mount({ inspect: found(state) });
      await choose(app);
      expect(app.inspected).toEqual([FOLDER]);
      expect(app.opened).toEqual([{ type: 'project', repo: FOLDER }]);
      expect(app.closed()).toBe(1);
      cleanup();
    }
  });

  it('opens as before without the inspection, and when it fails (a daemon without the route)', async () => {
    const plain = await mount();
    await choose(plain);
    expect(plain.opened).toEqual([{ type: 'project', repo: FOLDER }]);
    cleanup();
    const old = await mount({ inspect: () => Promise.reject(new Error('404')) });
    await choose(old);
    expect(old.inspected).toEqual([FOLDER]);
    expect(old.opened).toEqual([{ type: 'project', repo: FOLDER }]);
    expect(old.closed()).toBe(1);
  });

  it('with files and mode ask, asks, with the first option highlighted, and opens nothing yet', async () => {
    const app = await mount({ inspect: found('files') });
    await choose(app);
    const frame = app.frame();
    expect(frame).toContain(app.T('layout.newProject.init.folder', { repo: FOLDER }));
    expect(frame).toContain(app.T('layout.newProject.init.ask.files'));
    for (const option of ['commit_all', 'empty_commit', 'cancel']) {
      expect(frame).toContain(app.T(`layout.newProject.init.options.${option}.label`));
    }
    expect(frame).toContain(app.T('layout.newProject.init.hint'));
    // The browser and its list are gone while the question is on.
    expect(frame).not.toContain(app.T('layout.newProject.picker.sections.folders'));
    expect(app.opened).toEqual([]);
    // Enter takes the highlighted one, the first.
    await app.press(KEY.enter);
    expect(app.opened).toEqual([{ type: 'project', repo: FOLDER, init: 'commit_all' }]);
    expect(app.closed()).toBe(1);
  });

  it('the arrows move the highlight (going around), and the second option is the empty commit', async () => {
    const app = await mount({ inspect: found('files') });
    await choose(app);
    await app.press(KEY.down);
    await app.press(KEY.enter);
    expect(app.opened).toEqual([{ type: 'project', repo: FOLDER, init: 'empty_commit' }]);
    cleanup();
    // Up from the first goes around to the last, which cancels.
    const again = await mount({ inspect: found('files') });
    await choose(again);
    await again.press(KEY.up);
    await again.press(KEY.enter);
    expect(again.opened).toEqual([]);
    expect(again.closed()).toBe(0);
  });

  it('cancel and Esc go back to the browser, opening nothing, and the browser can choose again', async () => {
    const app = await mount({ inspect: found('files') });
    await choose(app);
    await app.press(KEY.esc);
    expect(app.opened).toEqual([]);
    expect(app.closed()).toBe(0);
    expect(app.frame()).toContain(app.T('layout.newProject.picker.sections.folders'));
    // The same folder asks again.
    await app.press(KEY.space);
    expect(app.frame()).toContain(app.T('layout.newProject.init.ask.files'));
    await app.press(KEY.down);
    await app.press(KEY.down);
    await app.press(KEY.enter);
    expect(app.opened).toEqual([]);
    expect(app.frame()).toContain(app.T('layout.newProject.picker.sections.folders'));
    expect(app.closed()).toBe(0);
  });

  it('no other key acts while the question is on (the type does not change)', async () => {
    const app = await mount({ inspect: found('files') });
    await choose(app);
    await app.press(KEY.tab);
    await app.press('x');
    await app.press(KEY.space);
    expect(app.frame()).toContain(app.T('layout.newProject.init.ask.files'));
    expect(app.opened).toEqual([]);
  });

  it('with files and mode commit_all or empty_commit, opens at once (the daemon applies it)', async () => {
    for (const mode of ['commit_all', 'empty_commit'] as const) {
      const app = await mount({ inspect: found('files', mode) });
      await choose(app);
      expect(app.opened).toEqual([{ type: 'project', repo: FOLDER }]);
      expect(app.closed()).toBe(1);
      cleanup();
    }
  });

  it('with files and mode refuse, says so and opens nothing', async () => {
    const app = await mount({ inspect: found('files', 'refuse') });
    await choose(app);
    expect(app.opened).toEqual([]);
    expect(app.closed()).toBe(0);
    // The message wraps in the box: its first words are on one line.
    const refused = app.T('layout.newProject.init.refused', { repo: FOLDER });
    const head = refused.slice(0, refused.indexOf('git repository'));
    expect(app.frame()).toContain(head);
    // Still in the browser, and the next key clears the message.
    expect(app.frame()).toContain(app.T('layout.newProject.picker.sections.folders'));
    await app.press(KEY.down);
    expect(app.frame()).not.toContain(head);
  });

  it.each(['empty', 'missing'] as const)(
    'an %s folder asks between the software model and an empty repository, whatever the mode',
    async (state) => {
      for (const mode of ['ask', 'refuse', 'commit_all'] as const) {
        const software = await mount({ inspect: found(state, mode) });
        await choose(software);
        expect(software.frame()).toContain(software.T(`layout.newProject.init.ask.${state}`));
        expect(software.frame()).toContain(
          software.T('layout.newProject.init.options.software.label'),
        );
        await software.press(KEY.enter);
        expect(software.opened).toEqual([{ type: 'project', repo: FOLDER, newProject: true }]);
        cleanup();
      }
      const repo = await mount({ inspect: found(state) });
      await choose(repo);
      await repo.press(KEY.down);
      await repo.press(KEY.enter);
      expect(repo.opened).toEqual([{ type: 'project', repo: FOLDER, init: 'empty_repo' }]);
      expect(repo.closed()).toBe(1);
      cleanup();
      const cancel = await mount({ inspect: found(state) });
      await choose(cancel);
      await cancel.press(KEY.esc);
      expect(cancel.opened).toEqual([]);
    },
  );

  it('asks from the field of the path too, and cancel goes back to the field', async () => {
    const app = await mount({ inspect: found('files'), picker: 'path', initial: FOLDER });
    await app.press(KEY.enter);
    expect(app.frame()).toContain(app.T('layout.newProject.init.ask.files'));
    await app.press(KEY.esc);
    expect(app.frame()).toContain('> /home/ana/work/api');
    expect(app.opened).toEqual([]);
    await app.press(KEY.enter);
    await app.press(KEY.down);
    await app.press(KEY.enter);
    expect(app.opened).toEqual([{ type: 'project', repo: FOLDER, init: 'empty_commit' }]);
  });

  it('a folder that changed after the inspection (needs_init on the open) asks the same question', async () => {
    const app = await mount({
      inspect: found('repo'),
      fail: (request) =>
        request.type === 'project' && request.init === undefined ? needsInit() : undefined,
    });
    await choose(app);
    expect(app.opened).toEqual([{ type: 'project', repo: FOLDER }]);
    expect(app.frame()).toContain(app.T('layout.newProject.init.ask.files'));
    expect(app.frame()).not.toContain(app.T('layout.newProject.badRepo', { repo: FOLDER }));
    await app.press(KEY.enter);
    expect(app.opened).toEqual([
      { type: 'project', repo: FOLDER },
      { type: 'project', repo: FOLDER, init: 'commit_all' },
    ]);
    expect(app.closed()).toBe(1);
  });

  it('needs_init without the inspection asks too, and other refusals keep their message', async () => {
    const racing = await mount({ fail: () => needsInit() });
    await choose(racing);
    expect(racing.frame()).toContain(racing.T('layout.newProject.init.ask.files'));
    cleanup();
    const other = await mount({ inspect: found('repo'), fail: new Error('boom') });
    await choose(other);
    expect(other.frame()).toContain(other.T('layout.newProject.failed', { message: 'boom' }));
    expect(other.frame()).not.toContain(other.T('layout.newProject.init.ask.files'));
  });

  it('speaks Brazilian Portuguese', async () => {
    const app = await mount({ inspect: found('empty'), pt: true });
    await choose(app);
    expect(app.frame()).toContain(app.T('layout.newProject.init.ask.empty'));
    expect(app.frame()).toContain('Modelo software');
    expect(app.frame()).toContain('Repositório vazio');
    expect(app.frame()).toContain('Cancelar');
  });
});
