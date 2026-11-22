// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_UI_REGISTRY,
  resolveKeymapFromConfig,
  type ResolvedKeymap,
} from '@otheater/client';
import type { i18n as I18nInstance } from 'i18next';
import { cleanup, render } from 'ink-testing-library';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { plain, waitFor } from '../ink.test-support.js';
import { createTuiI18n, loadTuiCatalogs } from '../locale.js';
import type { ProducerMessage } from './attachments.js';
import type { ClipboardIo, RunResult } from './clipboard-image.js';
import type { EditorIo } from './external-editor.js';
import {
  FileHistoryStore,
  MemoryHistoryStore,
  inputHistoryFile,
  type HistoryStore,
} from './history.js';
import type { BoxPorts } from './ports.js';
import { DEFAULT_INPUT_SETTINGS, parseInputSettings, type InputSettings } from './settings.js';
import { TextBox } from './text-box.js';

/** The bytes a terminal sends for the keys of the table of N35. */
const K = {
  enter: '\r',
  ctrlJ: '\n',
  shiftEnterKitty: '\x1b[13;2u',
  altEnter: '\x1b\r',
  altEnterKitty: '\x1b[13;3u',
  escKitty: '\x1b[27u',
  ctrlCKitty: '\x1b[99;5u',
  shiftTabKitty: '\x1b[9;2u',
  backspace: '\x7f',
  delete: '\x1b[3~',
  left: '\x1b[D',
  right: '\x1b[C',
  up: '\x1b[A',
  down: '\x1b[B',
  home: '\x1b[H',
  end: '\x1b[F',
  ctrlLeft: '\x1b[1;5D',
  ctrlRight: '\x1b[1;5C',
  ctrlA: '\x01',
  ctrlB: '\x02',
  ctrlE: '\x05',
  ctrlF: '\x06',
  ctrlG: '\x07',
  ctrlK: '\x0b',
  ctrlR: '\x12',
  ctrlU: '\x15',
  ctrlV: '\x16',
  ctrlW: '\x17',
  ctrlY: '\x19',
  altB: '\x1bb',
  altD: '\x1bd',
  altF: '\x1bf',
  altBackspace: '\x1b\x7f',
  esc: '\x1b',
} as const;

const pasteOf = (text: string): string => `\x1b[200~${text}\x1b[201~`;

let i18n: I18nInstance;
beforeAll(async () => {
  i18n = await createTuiI18n('en', loadTuiCatalogs());
});
afterEach(() => {
  cleanup();
});

function keymapOf(
  preset: 'agents' | 'classic' = 'agents',
  overrides: Record<string, string | string[]> = {},
): ResolvedKeymap {
  return resolveKeymapFromConfig(
    DEFAULT_UI_REGISTRY,
    { preset, environment: 'auto', overrides },
    { platform: 'other', tmux: false, vscode: false },
  ).keymap;
}

const noClipboard = (): ClipboardIo => ({
  platform: 'linux',
  env: {},
  run: () => Promise.resolve<RunResult>({ kind: 'missing' }),
  tempPath: () => Promise.resolve('/tmp/never'),
  writeFile: () => Promise.resolve(),
  fileSize: () => Promise.resolve(undefined),
  discard: () => Promise.resolve(),
  now: () => Date.now(),
});

const noEditor = (): EditorIo => ({
  env: {},
  platform: 'linux',
  prepare: () => Promise.resolve('/tmp/never'),
  run: () => Promise.resolve({ code: 0 }),
  read: () => Promise.resolve(''),
  cleanup: () => Promise.resolve(),
});

function fakePorts(overrides: Partial<BoxPorts> = {}): BoxPorts {
  return {
    clipboard: noClipboard(),
    editor: noEditor(),
    isFile: () => Promise.resolve(false),
    homedir: '/home/u',
    platform: 'linux',
    ...overrides,
  };
}

interface Mounted {
  readonly sent: ProducerMessage[];
  readonly changes: string[];
  press(keys: string): Promise<void>;
  frame(): string;
  waitForText(text: string | RegExp): Promise<string>;
  /** Presses Enter and waits for the message it sends. */
  send(): Promise<ProducerMessage>;
  unmount(): void;
}

interface MountOptions {
  keymap?: ResolvedKeymap;
  settings?: InputSettings;
  history?: HistoryStore;
  ports?: BoxPorts;
  onSubmit?: (message: ProducerMessage) => void | Promise<void>;
  isActive?: boolean;
}

function mount(options: MountOptions = {}): Mounted {
  const sent: ProducerMessage[] = [];
  const changes: string[] = [];
  const view = render(
    <I18nextProvider i18n={i18n}>
      <TextBox
        keymap={options.keymap ?? keymapOf()}
        settings={options.settings ?? DEFAULT_INPUT_SETTINGS}
        history={options.history ?? new MemoryHistoryStore()}
        ports={options.ports ?? fakePorts()}
        isActive={options.isActive}
        onSubmit={(message) => {
          sent.push(message);
          return options.onSubmit?.(message);
        }}
        onChange={(text) => {
          changes.push(text);
        }}
      />
    </I18nextProvider>,
  );
  const frame = (): string => plain(view.lastFrame() ?? '');
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));
  const mounted: Mounted = {
    sent,
    changes,
    frame,
    press: async (keys) => {
      view.stdin.write(keys);
      await settle();
    },
    waitForText: (text) =>
      waitFor(
        () => {
          const current = frame();
          return (typeof text === 'string' ? current.includes(text) : text.test(current))
            ? current
            : undefined;
        },
        `the text ${String(text)} (last frame: ${frame()})`,
      ),
    send: async () => {
      const before = sent.length;
      view.stdin.write(K.enter);
      return waitFor(() => sent[before], 'a message to be sent');
    },
    unmount: () => {
      view.unmount();
    },
  };
  return mounted;
}

/** Types `keys`, sends, and returns the text of the message: how the tests read where the cursor was. */
async function result(box: Mounted, ...keys: string[]): Promise<string> {
  for (const key of keys) await box.press(key);
  return (await box.send()).text;
}

describe('the text box', () => {
  describe('sending and new lines', () => {
    it('shows what is typed and sends it with Enter', async () => {
      const box = mount();
      await box.press('hello');
      await box.waitForText('hello');
      expect(box.frame()).toContain('❯ hello');
      const message = await box.send();
      expect(message).toEqual({ text: 'hello', attachments: [] });
      await box.waitForText('❯');
      expect(box.frame()).not.toContain('hello');
      expect(box.changes.at(-1)).toBe('');
    });

    it('does not send an empty message', async () => {
      const box = mount();
      await box.press(K.enter);
      await box.press('x');
      expect(await result(box)).toBe('x');
      expect(box.sent).toHaveLength(1);
    });

    it.each([
      ['Ctrl+J', K.ctrlJ],
      ['Shift+Enter (kitty protocol)', K.shiftEnterKitty],
      ['Alt+Enter', K.altEnter],
      ['Alt+Enter (kitty protocol)', K.altEnterKitty],
    ])('%s inserts a new line instead of sending', async (_name, key) => {
      const box = mount();
      expect(await result(box, 'a', key, 'b')).toBe('a\nb');
      expect(box.sent).toHaveLength(1);
    });

    it('shows a long message in a window and says how many lines are out of it', async () => {
      const box = mount({ settings: parseInputSettings({ maxVisibleLines: 3 }) });
      for (const line of ['one', 'two', 'three', 'four', 'five']) {
        await box.press(line);
        await box.press(K.ctrlJ);
      }
      const frame = await box.waitForText(/more lines above/);
      expect(frame).toContain('… 3 more lines above');
      expect(frame).not.toContain('one');
      await box.press(K.up);
      await box.press(K.up);
      await box.press(K.up);
      await box.press(K.up);
      await box.waitForText(/more lines below/);
    });
  });

  describe('readline editing', () => {
    it.each([
      ['Left', [K.left], 'abXc'],
      ['Ctrl+B', [K.ctrlB], 'abXc'],
      ['Left and Right', [K.left, K.left, K.right], 'abXc'],
      ['Ctrl+B and Ctrl+F', [K.ctrlB, K.ctrlB, K.ctrlF], 'abXc'],
      ['Home', [K.home], 'Xabc'],
      ['Ctrl+A', [K.ctrlA], 'Xabc'],
      ['End after Home', [K.home, K.end], 'abcX'],
      ['Ctrl+E after Ctrl+A', [K.ctrlA, K.ctrlE], 'abcX'],
    ])('moves the cursor with %s', async (_name, keys, expected) => {
      const box = mount();
      await box.press('abc');
      for (const key of keys) await box.press(key);
      expect(await result(box, 'X')).toBe(expected);
    });

    it.each([
      ['Ctrl+Left', K.ctrlLeft, K.ctrlRight],
      ['Alt+B and Alt+F', K.altB, K.altF],
    ])('jumps by word with %s', async (_name, back, forward) => {
      const box = mount();
      await box.press('one two three');
      await box.press(back);
      await box.press(back);
      await box.press('X');
      await box.press(forward);
      expect(await result(box, 'Y')).toBe('one XtwoY three');
    });

    it('deletes with Backspace and Delete', async () => {
      const box = mount();
      await box.press('abcd');
      await box.press(K.backspace);
      await box.press(K.left);
      await box.press(K.delete);
      expect(await result(box)).toBe('ab');
    });

    it('cuts with Ctrl+K, Ctrl+U, Ctrl+W, Alt+Backspace and Alt+D, and Ctrl+Y puts it back', async () => {
      const box = mount();
      await box.press('one two three');
      await box.press(K.ctrlW);
      await box.press(K.altBackspace);
      expect(await result(box)).toBe('one ');

      const second = mount();
      await second.press('one two three');
      await second.press(K.ctrlLeft);
      await second.press(K.ctrlK);
      await second.press(K.ctrlY);
      await second.press(K.ctrlY);
      expect(await result(second)).toBe('one two threethree');

      const third = mount();
      await third.press('one two three');
      await third.press(K.ctrlA);
      await third.press(K.altD);
      expect(await result(third)).toBe(' two three');

      const fourth = mount();
      await fourth.press('one two');
      await fourth.press(K.ctrlU);
      await fourth.press('new');
      expect(await result(fourth)).toBe('new');
    });

    it('moves between lines with the arrows, in the same column', async () => {
      const box = mount();
      await box.press('abc');
      await box.press(K.ctrlJ);
      await box.press('de');
      await box.press(K.up);
      await box.press('X');
      expect(await result(box)).toBe('abXc\nde');
    });

    it('keeps typing in the right place with accents and emoji', async () => {
      const box = mount();
      await box.press('ação 👍🏽');
      await box.press(K.left);
      await box.press('!');
      expect(await result(box)).toBe('ação !👍🏽');
    });
  });

  describe('the history', () => {
    it('goes back with Up, forward with Down, and returns to what was being written', async () => {
      const box = mount();
      await box.press('first');
      await box.send();
      await box.press('second');
      await box.send();
      await box.press('draft');
      await box.press(K.up);
      await box.waitForText('second');
      await box.press(K.up);
      await box.waitForText('first');
      await box.press(K.down);
      await box.press(K.down);
      await box.waitForText('draft');
      await box.press(K.up);
      expect(await result(box)).toBe('second');
    });

    it('searches with Ctrl+R, and Enter takes the message without sending it', async () => {
      const history = new MemoryHistoryStore(500, [
        'deploy the app',
        'fix the bug',
        'deploy again',
      ]);
      const box = mount({ history });
      await box.press(K.ctrlR);
      await box.waitForText('Search the history');
      await box.press('bug');
      await box.waitForText('fix the bug');
      await box.press(K.enter);
      expect(box.sent).toHaveLength(0);
      expect(box.frame()).not.toContain('Search the history');
      expect(await result(box)).toBe('fix the bug');
    });

    it('goes to older matches with Ctrl+R again, and says when nothing matches', async () => {
      const history = new MemoryHistoryStore(500, [
        'deploy the app',
        'fix the bug',
        'deploy again',
      ]);
      const box = mount({ history });
      await box.press(K.ctrlR);
      await box.press('deploy');
      await box.waitForText('deploy again');
      await box.press(K.ctrlR);
      await box.waitForText('deploy the app');
      await box.press('zzz');
      await box.waitForText('no message matches');
    });

    it('leaves the search with Esc written as CSI-u (ui.keyboard.protocol on)', async () => {
      const history = new MemoryHistoryStore(500, ['old message']);
      const box = mount({ history });
      await box.press('wip');
      await box.press(K.ctrlR);
      await box.waitForText('old message');
      await box.press(K.escKitty);
      await box.waitForText('wip');
      expect(box.frame()).not.toContain('Search the history');
    });

    it('does not write the CSI-u forms of Ctrl+C and Shift+Tab as text', async () => {
      const box = mount();
      expect(await result(box, 'a', K.ctrlCKitty, K.shiftTabKitty, 'b')).toBe('ab');
    });

    it('leaves the search with Esc and brings back what was written', async () => {
      const history = new MemoryHistoryStore(500, ['old message']);
      const box = mount({ history });
      await box.press('wip');
      await box.press(K.ctrlR);
      await box.waitForText('old message');
      await box.press(K.esc);
      await box.waitForText('wip');
      expect(box.frame()).not.toContain('Search the history');
      expect(await result(box)).toBe('wip');
    });

    describe('kept between runs', () => {
      const folders: string[] = [];
      afterEach(async () => {
        for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
      });

      it('writes the message to the file and the next box recalls it with Up', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'ot-input-history-'));
        folders.push(dataDir);
        const file = inputHistoryFile(dataDir);
        const first = mount({ history: new FileHistoryStore(file) });
        await first.press('remember me');
        await first.send();
        await waitFor(() => (readHistory(file) ? true : undefined), 'the history file');
        first.unmount();

        const second = mount({ history: new FileHistoryStore(file) });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await second.press(K.up);
        await second.waitForText('remember me');
        expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
          entries: ['remember me'],
        });
      });
    });
  });

  describe('paste', () => {
    it('puts a short bracketed paste in the text, with its lines', async () => {
      const box = mount();
      await box.press(pasteOf('line 1\nline 2'));
      await box.waitForText('line 2');
      expect(await result(box)).toBe('line 1\nline 2');
    });

    it('turns a paste of 2,000 lines into a marker, and the attachment keeps the whole text', async () => {
      const lines = Array.from({ length: 2000 }, (_, i) => `line ${String(i + 1)}`);
      const text = lines.join('\n');
      const box = mount();
      await box.press(pasteOf(text));
      const frame = await box.waitForText('[Pasted text #1]');
      expect(frame).not.toContain('line 2000');
      expect(frame).toContain('Attachments: [Pasted text #1]');
      const message = await box.send();
      expect(message.text).toBe('[Pasted text #1]');
      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0]?.body).toEqual({ text, name: 'pasted-text-1.txt' });
    });

    it('removes a marker whole with one Backspace, and then it is not sent', async () => {
      const box = mount();
      await box.press(pasteOf('x\n'.repeat(30)));
      await box.waitForText('[Pasted text #1]');
      await box.press(K.backspace);
      await box.press('ok');
      const message = await box.send();
      expect(message).toEqual({ text: 'ok', attachments: [] });
    });

    it('takes several characters that arrive at once, with no bracketed paste, as a paste', async () => {
      const box = mount({ settings: parseInputSettings({ paste: { lines: 1 } }) });
      await box.press('a\rb\rc');
      await box.waitForText('[Pasted text #1]');
    });

    it('attaches a pasted path of a file that exists, and an image as an image', async () => {
      const existing = new Set(['/home/u/notes.md', '/home/u/shot.png']);
      const box = mount({
        ports: fakePorts({ isFile: (path) => Promise.resolve(existing.has(path)) }),
      });
      await box.press(pasteOf('/home/u/notes.md'));
      await box.waitForText('[File #1]');
      await box.press(pasteOf("'/home/u/shot.png'"));
      await box.waitForText('[Image #2]');
      await box.waitForText('Attached: shot.png.');
      const message = await box.send();
      expect(message.attachments.map((draft) => draft.body)).toEqual([
        { path: '/home/u/notes.md', mode: 'copy' },
        { path: '/home/u/shot.png', mode: 'copy' },
      ]);
    });

    it('pastes the path as text when the file does not exist', async () => {
      const box = mount();
      await box.press(pasteOf('/no/such/file.txt'));
      await box.waitForText('/no/such/file.txt');
      expect(await result(box)).toBe('/no/such/file.txt');
    });
  });

  describe('Ctrl+V with an image', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

    function clipboard(
      answer: (command: string, args: readonly string[]) => RunResult,
      discarded: string[] = [],
    ): ClipboardIo {
      let count = 0;
      return {
        ...noClipboard(),
        env: { WAYLAND_DISPLAY: 'wayland-0' },
        run: (command, args) => Promise.resolve(answer(command, args)),
        tempPath: (extension) =>
          Promise.resolve(`/tmp/ot-fake/clip-${String((count += 1))}.${extension}`),
        discard: (path) => {
          discarded.push(path);
          return Promise.resolve();
        },
      };
    }

    it('attaches the image of the clipboard as an A marker with the temporary file', async () => {
      const discarded: string[] = [];
      const io = clipboard(
        (_command, args) =>
          args[0] === '--list-types'
            ? { kind: 'ok', stdout: Buffer.from('image/png\n') }
            : { kind: 'ok', stdout: PNG },
        discarded,
      );
      const box = mount({ ports: fakePorts({ clipboard: io }) });
      await box.press('see ');
      await box.press(K.ctrlV);
      await box.waitForText('[Image #1]');
      await box.waitForText('Image attached as [Image #1].');
      const message = await box.send();
      expect(message.text).toBe('see [Image #1]');
      expect(message.attachments[0]).toMatchObject({
        kind: 'image',
        body: { path: '/tmp/ot-fake/clip-1.png', mode: 'copy' },
        temporaryPath: '/tmp/ot-fake/clip-1.png',
      });
      box.unmount();
      await waitFor(
        () => (discarded.length > 0 ? discarded : undefined),
        'the temporary file removed',
      );
      expect(discarded).toEqual(['/tmp/ot-fake/clip-1.png']);
    });

    it('says what is missing, without hanging, when there is no tool for the image', async () => {
      const box = mount({
        ports: fakePorts({ clipboard: clipboard(() => ({ kind: 'missing' })) }),
      });
      await box.press(K.ctrlV);
      const frame = await box.waitForText('To paste an image, install one of: wl-paste, xclip.');
      expect(frame).toContain('❯');
      // The box still works.
      await box.press('x');
      expect(await result(box)).toBe('x');
    });

    it('says when the clipboard has no image, when the tool is off and when it does not answer', async () => {
      const text = mount({
        ports: fakePorts({
          clipboard: clipboard(() => ({ kind: 'ok', stdout: Buffer.from('text/plain\n') })),
        }),
      });
      await text.press(K.ctrlV);
      await text.waitForText('There is no image on the clipboard.');

      const off = mount({
        settings: parseInputSettings({ image: { tool: 'off' } }),
        ports: fakePorts(),
      });
      await off.press(K.ctrlV);
      await off.waitForText('Pasting an image is off (ui.input.image.tool).');

      const slow = mount({
        settings: parseInputSettings({ image: { timeoutMs: 100 } }),
        ports: fakePorts({
          clipboard: clipboard(() => ({ kind: 'timeout' })),
        }),
      });
      await slow.press(K.ctrlV);
      await slow.waitForText(/did not answer in 1 s/);
    });
  });

  describe('Ctrl+G, the external editor', () => {
    it('hands the message to the editor and takes back what was saved', async () => {
      const files = new Map<string, string>();
      const runs: string[][] = [];
      const editor: EditorIo = {
        env: { EDITOR: 'myeditor --wait' },
        platform: 'linux',
        prepare: (text) => {
          files.set('/tmp/ot-edit/message.md', text);
          return Promise.resolve('/tmp/ot-edit/message.md');
        },
        run: (command, file) => {
          runs.push([...command, file]);
          files.set(file, `${files.get(file) ?? ''} + written in the editor\n`);
          return Promise.resolve({ code: 0 });
        },
        read: (path) => Promise.resolve(files.get(path) ?? ''),
        cleanup: () => Promise.resolve(),
      };
      const box = mount({ ports: fakePorts({ editor }) });
      await box.press('draft');
      await box.press(K.ctrlG);
      await box.waitForText('draft + written in the editor');
      expect(runs).toEqual([['myeditor', '--wait', '/tmp/ot-edit/message.md']]);
      expect(await result(box)).toBe('draft + written in the editor');
    });

    it('says to set $EDITOR when there is none, and when the editor is off', async () => {
      const none = mount();
      await none.press('keep');
      await none.press(K.ctrlG);
      await none.waitForText('Set the variable VISUAL or EDITOR to write in an editor.');
      expect(await result(none)).toBe('keep');

      const off = mount({
        settings: parseInputSettings({ editor: 'off' }),
        ports: fakePorts({ editor: { ...noEditor(), env: { EDITOR: 'vi' } } }),
      });
      await off.press(K.ctrlG);
      await off.waitForText('The external editor is off (ui.input.editor).');
    });

    it('reports an editor that could not run', async () => {
      const editor: EditorIo = {
        ...noEditor(),
        env: { VISUAL: 'broken' },
        run: () => Promise.reject(new Error('spawn broken ENOENT')),
      };
      const box = mount({ ports: fakePorts({ editor }) });
      await box.press(K.ctrlG);
      await box.waitForText('The editor could not run: spawn broken ENOENT');
    });
  });

  describe('the keymap', () => {
    it('follows the preset: classic gives Ctrl+K to the terminal', async () => {
      const box = mount({ keymap: keymapOf('classic') });
      await box.press('one two');
      await box.press(K.ctrlLeft);
      await box.press(K.ctrlK);
      // In classic, Ctrl+K cuts nothing and types nothing: the text is whole.
      expect(await result(box)).toBe('one two');
    });

    it('follows ui.keymap.overrides: the new line can be moved to another key', async () => {
      const box = mount({ keymap: keymapOf('agents', { 'input.newline': 'Ctrl+T' }) });
      await box.press('a');
      await box.press('\x14');
      await box.press('b');
      expect(await result(box)).toBe('a\nb');
    });

    it('does not take keys while it is not active', async () => {
      const box = mount({ isActive: false });
      await box.press('abc');
      expect(box.frame()).not.toContain('abc');
    });
  });

  it('keeps the message and says so when the owner refuses it', async () => {
    const box = mount({ onSubmit: () => Promise.reject(new Error('daemon is down')) });
    await box.press('hello');
    await box.send();
    await box.waitForText('The message was not sent: daemon is down');
    await box.waitForText('❯ hello');
  });
});

function readHistory(file: string): boolean {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) !== null;
  } catch {
    return false;
  }
}
