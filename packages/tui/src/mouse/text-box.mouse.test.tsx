// SPDX-License-Identifier: MPL-2.0
import { DEFAULT_UI_REGISTRY, resolveKeymapFromConfig } from '@otheater/client';
import type { i18n as I18nInstance } from 'i18next';
import { cleanup, render } from 'ink-testing-library';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ClipboardIo, RunResult } from '../input/clipboard-image.js';
import type { EditorIo } from '../input/external-editor.js';
import { MemoryHistoryStore } from '../input/history.js';
import type { BoxPorts } from '../input/ports.js';
import { DEFAULT_INPUT_SETTINGS } from '../input/settings.js';
import { TextBox } from '../input/text-box.js';
import { plain } from '../ink.test-support.js';
import { createTuiI18n, loadTuiCatalogs } from '../locale.js';
import { DEFAULT_UI_SETTINGS } from '../settings.js';
import { MouseLayer } from './provider.js';
import { MOUSE_DISABLE_SEQUENCE } from './modes.js';
import { sgrReport } from './sgr.js';

/**
 * The text box under the mouse layer (N34, N35): no byte of a report becomes text or a key of the
 * box, whole or cut between two reads, and the editor takes the terminal with the mouse off.
 */

let i18n: I18nInstance;
beforeAll(async () => {
  i18n = await createTuiI18n('en', loadTuiCatalogs());
});
afterEach(cleanup);

const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const keymap = resolveKeymapFromConfig(
  DEFAULT_UI_REGISTRY,
  { preset: 'agents', environment: 'auto', overrides: {} },
  { platform: 'other', tmux: false, vscode: false },
).keymap;

const clipboard: ClipboardIo = {
  platform: 'linux',
  env: {},
  run: () => Promise.resolve<RunResult>({ kind: 'missing' }),
  tempPath: () => Promise.resolve('/tmp/never'),
  writeFile: () => Promise.resolve(),
  fileSize: () => Promise.resolve(undefined),
  discard: () => Promise.resolve(),
  now: () => Date.now(),
};

function ports(editor: Partial<EditorIo> = {}): BoxPorts {
  return {
    clipboard,
    editor: {
      env: {},
      platform: 'linux',
      prepare: () => Promise.resolve('/tmp/never'),
      run: () => Promise.resolve({ code: 0 }),
      read: () => Promise.resolve(''),
      cleanup: () => Promise.resolve(),
      ...editor,
    },
    isFile: () => Promise.resolve(false),
    homedir: '/home/u',
    platform: 'linux',
  };
}

function mount(boxPorts: BoxPorts = ports(), writes: string[] = []) {
  const changes: string[] = [];
  const view = render(
    <I18nextProvider i18n={i18n}>
      <MouseLayer
        mode="full"
        copy="osc52"
        tuning={DEFAULT_UI_SETTINGS.tuiMouse}
        terminal={{ write: (text) => writes.push(text) }}
      >
        <TextBox
          keymap={keymap}
          settings={DEFAULT_INPUT_SETTINGS}
          history={new MemoryHistoryStore()}
          ports={boxPorts}
          onSubmit={() => undefined}
          onChange={(text) => changes.push(text)}
        />
      </MouseLayer>
    </I18nextProvider>,
  );
  return {
    writes,
    changes,
    frame: () => plain(view.lastFrame() ?? ''),
    write: async (bytes: string) => {
      view.stdin.write(bytes);
      await settle();
    },
  };
}

describe('the text box under the mouse layer', () => {
  it('takes the keys and none of the bytes of a report, whole or cut', async () => {
    const box = mount();
    await box.write('ab');
    const press = sgrReport({ action: 'press', button: 'left', col: 11, row: 4 });
    await box.write(press);
    await box.write(sgrReport({ action: 'release', button: 'left', col: 11, row: 4 }));
    await box.write(sgrReport({ action: 'wheel', wheel: 'down', col: 3, row: 2 }));
    // Cut in two reads, in the middle of the number and then right after the introducer.
    const cut = sgrReport({ action: 'press', button: 'right', col: 120, row: 33 });
    box.write(cut.slice(0, 9)).catch(() => undefined);
    await box.write(cut.slice(9));
    const cutAtIntroducer = sgrReport({ action: 'drag', button: 'left', col: 7, row: 8 });
    box.write(cutAtIntroducer.slice(0, 3)).catch(() => undefined);
    await box.write(cutAtIntroducer.slice(3));
    await box.write('c');
    expect(box.changes.at(-1)).toBe('abc');
    expect(box.changes.every((text) => /^[abc]*$/.test(text))).toBe(true);
    expect(box.frame()).not.toMatch(/\[<|\d+;\d+;\d+[Mm]/);
  });

  it('gives the terminal to the editor with the mouse off, and takes it back on', async () => {
    let writesInside: string[] = [];
    const writes: string[] = [];
    const box = mount(
      ports({
        env: { EDITOR: 'myeditor' },
        run: () => {
          writesInside = [...writes];
          return Promise.resolve({ code: 0 });
        },
        read: () => Promise.resolve('from the editor'),
      }),
      writes,
    );
    await settle();
    await box.write('\x07');
    await settle(80);
    expect(writesInside.at(-1)).toBe(MOUSE_DISABLE_SEQUENCE);
    expect(box.writes.at(-1)).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    expect(box.changes.at(-1)).toBe('from the editor');
  });
});
