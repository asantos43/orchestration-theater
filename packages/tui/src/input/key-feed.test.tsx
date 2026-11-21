// SPDX-License-Identifier: MPL-2.0
import {
  DEFAULT_UI_REGISTRY,
  resolveKeymapFromConfig,
  type ResolvedKeymap,
} from '@otheater/client';
import type { i18n as I18nInstance } from 'i18next';
import { useInput, useStdin } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { plain, waitFor } from '../ink.test-support.js';
import { createTuiI18n, loadTuiCatalogs } from '../locale.js';
import type { ProducerMessage } from './attachments.js';
import { MemoryHistoryStore } from './history.js';
import { KeyFeed, KeyFeedProvider } from './key-feed.js';
import { DEFAULT_INPUT_SETTINGS } from './settings.js';
import { TextBox } from './text-box.js';
import type { BoxPorts } from './ports.js';

/**
 * P24 (N208, item 5): the keys that come in between the commit that gives the text box the
 * keyboard and the moment Ink would have attached its listener are not lost. The test makes the
 * gap on purpose: a component written after the box types in its layout effect, which runs in the
 * same synchronous task as the commit, before the passive effect where Ink's `useInput` binds.
 */

const LEFT = '\x1b[D';
const CTRL_E = '\x05';
const ENTER = '\r';
const pasteOf = (text: string): string => `\x1b[200~${text}\x1b[201~`;

let i18n: I18nInstance;
beforeAll(async () => {
  i18n = await createTuiI18n('en', loadTuiCatalogs());
});
afterEach(() => {
  cleanup();
});

const keymap: ResolvedKeymap = resolveKeymapFromConfig(
  DEFAULT_UI_REGISTRY,
  { preset: 'agents', environment: 'auto', overrides: {} },
  { platform: 'other', tmux: false, vscode: false },
).keymap;

const ports: BoxPorts = {
  clipboard: {
    platform: 'linux',
    env: {},
    run: () => Promise.resolve({ kind: 'missing' }),
    tempPath: () => Promise.resolve('/tmp/never'),
    writeFile: () => Promise.resolve(),
    fileSize: () => Promise.resolve(undefined),
    discard: () => Promise.resolve(),
    now: () => Date.now(),
  },
  editor: {
    env: {},
    platform: 'linux',
    prepare: () => Promise.resolve('/tmp/never'),
    run: () => Promise.resolve({ code: 0 }),
    read: () => Promise.resolve(''),
    cleanup: () => Promise.resolve(),
  },
  isFile: () => Promise.resolve(false),
  homedir: '/home/u',
  platform: 'linux',
};

/** What the layout does in the real app: keeps the terminal read (raw mode on) all the time. */
function OtherListener(): ReactNode {
  useInput(() => undefined);
  return null;
}

/** Types `keys` in the commit that sees `go`, right after the box (a sibling written after it). */
function Typist(props: { readonly go: boolean; readonly keys: readonly string[] }): ReactNode {
  const { stdin } = useStdin();
  useLayoutEffect(() => {
    if (!props.go) return;
    // The stdin of `ink-testing-library` takes keys with `write`.
    const typing = stdin as unknown as { write(keys: string): void };
    for (const keys of props.keys) typing.write(keys);
  }, [props.go]);
  return null;
}

interface Harness {
  readonly sent: ProducerMessage[];
  /** Gives the box the keyboard (and types the keys in that very commit when they are set). */
  activate(): void;
  /** The key presses of the test itself, between commits. */
  press(keys: string): void;
  frame(): string;
}

/**
 * `activate` either gives the keyboard to a box that was there without it (`mode: 'focus'`) or
 * mounts the box with the keyboard, as the chat of a scenario that opens (`mode: 'mount'`).
 */
function mountBox(options: {
  readonly keys: readonly string[];
  readonly mode: 'focus' | 'mount';
  readonly feed: boolean;
}): Harness {
  const sent: ProducerMessage[] = [];
  let activate = (): void => undefined;
  function Screen(): ReactNode {
    const [active, setActive] = useState(false);
    activate = () => {
      setActive(true);
    };
    const shown = options.mode === 'focus' || active;
    const box = (
      <>
        <OtherListener />
        {shown && (
          <TextBox
            keymap={keymap}
            settings={DEFAULT_INPUT_SETTINGS}
            history={new MemoryHistoryStore()}
            ports={ports}
            isActive={active}
            onSubmit={(message) => {
              sent.push(message);
            }}
          />
        )}
        <Typist go={active} keys={options.keys} />
      </>
    );
    return options.feed ? <KeyFeedProvider>{box}</KeyFeedProvider> : box;
  }
  const view = render(
    <I18nextProvider i18n={i18n}>
      <Screen />
    </I18nextProvider>,
  );
  return {
    sent,
    activate: () => {
      activate();
    },
    press: (keys) => {
      view.stdin.write(keys);
    },
    frame: () => plain(view.lastFrame() ?? ''),
  };
}

/** Lets React flush the commit and its passive effects. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

/** a, b, Left, c, a paste, Ctrl+E and d: letters, a shortcut and a paste, in an order that shows. */
const KEYS = ['a', 'b', LEFT, 'c', pasteOf('XYZ'), CTRL_E, 'd'] as const;
const TYPED = 'acXYZbd';

describe('the keys that come in before the text box is bound (P24)', () => {
  it('applies, in order, the keys that arrive in the commit that gives the box the keyboard', async () => {
    const box = mountBox({ keys: KEYS, mode: 'focus', feed: true });
    await settle();
    // Not the box's yet: a key now belongs to whoever has the keyboard.
    box.press('q');
    await settle();
    expect(box.frame()).not.toContain('q');
    box.activate();
    await waitFor(() => (box.frame().includes(TYPED) ? true : undefined), 'the typed keys');
    box.press(ENTER);
    await waitFor(() => box.sent[0], 'the message');
    expect(box.sent[0]).toEqual({ text: TYPED, attachments: [] });
  });

  it('does the same when the box is mounted with the keyboard, as the chat of a scenario that opens', async () => {
    const box = mountBox({ keys: KEYS, mode: 'mount', feed: true });
    await settle();
    box.activate();
    await waitFor(() => (box.frame().includes(TYPED) ? true : undefined), 'the typed keys');
    box.press(ENTER);
    await waitFor(() => box.sent[0], 'the message');
    expect(box.sent[0]?.text).toBe(TYPED);
  });

  it('shows the gap of Ink 8: without the feed those keys are dropped', async () => {
    // The reason for the feed. If this starts to fail, Ink binds `useInput` at the commit and the
    // feed is no longer needed.
    const box = mountBox({ keys: KEYS, mode: 'focus', feed: false });
    await settle();
    box.activate();
    await settle();
    expect(box.frame()).not.toContain('ab');
    expect(box.frame()).not.toContain('XYZ');
  });

  it('keeps hearing the keys after the gap', async () => {
    const box = mountBox({ keys: ['a'], mode: 'focus', feed: true });
    box.activate();
    await waitFor(() => (box.frame().includes('❯ a') ? true : undefined), 'the first key');
    box.press('b');
    await waitFor(() => (box.frame().includes('❯ ab') ? true : undefined), 'the next key');
  });
});

describe('the feed', () => {
  it('hands each key to the subscribers in the order they subscribed, until they unsubscribe', () => {
    const feed = new KeyFeed();
    const heard: string[] = [];
    const stopFirst = feed.subscribe((input) => heard.push(`1:${input}`));
    feed.subscribe((input) => heard.push(`2:${input}`));
    const key = {} as never;
    feed.push('a', key);
    stopFirst();
    feed.push('b', key);
    expect(heard).toEqual(['1:a', '2:a', '2:b']);
    expect(feed.size).toBe(1);
  });
});
