// SPDX-License-Identifier: MPL-2.0
import { useInput, type Key } from 'ink';
import {
  createContext,
  useContext,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from 'react';

/**
 * The keys of the text box, bound without a gap (P24 of docs/18; N208, item 5).
 *
 * Ink's `useInput` attaches its listener in a passive effect: React runs it a task after the commit
 * that painted the screen, and on a loaded machine that task can be late. A key that arrives in the
 * gap (the chat painted as the focus, the box not yet listening) is read by the other listeners of
 * the terminal and dropped: the first key of the person was lost. So one `useInput` lives at the
 * root of the TUI, from the first frame, and parses every key once; the box subscribes to it in a
 * layout effect, which runs in the same synchronous task as the commit, before any key can come in.
 * Nothing needs to be held back and replayed: from the commit that gives the box the keyboard to
 * the last key, the box hears every key, in the order they came, whether a letter, a shortcut or a
 * paste (a paste that arrives before the box listens for pastes comes as one long text, which the
 * box already treats as a paste).
 */
export type KeyListener = (input: string, key: Key) => void;

/** One parser of the keys of the terminal, with the subscribers that are listening now. */
export class KeyFeed {
  readonly #listeners = new Set<KeyListener>();

  /** Hands a key to the subscribers, in the order they subscribed. */
  push(input: string, key: Key): void {
    for (const listener of [...this.#listeners]) listener(input, key);
  }

  /** Listens until the returned function is called. */
  subscribe(listener: KeyListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** How many are listening (for tests). */
  get size(): number {
    return this.#listeners.size;
  }
}

const KeyFeedContext = createContext<KeyFeed | undefined>(undefined);

/** Parses the keys from the first frame and hands them to whoever subscribed (`useFeedInput`). */
export function KeyFeedProvider(props: {
  readonly children: ReactNode;
  readonly feed?: KeyFeed | undefined;
}): ReactNode {
  const own = useMemo(() => new KeyFeed(), []);
  const feed = props.feed ?? own;
  useInput((input, key) => {
    feed.push(input, key);
  });
  return <KeyFeedContext.Provider value={feed}>{props.children}</KeyFeedContext.Provider>;
}

/**
 * `useInput` for a component whose keys must not be lost when it takes the keyboard: with a
 * `KeyFeedProvider` above it, it subscribes in a layout effect; without one it is plain `useInput`.
 */
export function useFeedInput(handler: KeyListener, options: { readonly isActive: boolean }): void {
  const feed = useContext(KeyFeedContext);
  const { isActive } = options;
  useInput(handler, { isActive: feed === undefined && isActive });
  const handle = useEffectEvent(handler);
  useLayoutEffect(() => {
    if (feed === undefined || !isActive) return undefined;
    return feed.subscribe((input, key) => {
      handle(input, key);
    });
  }, [feed, isActive]);
}
