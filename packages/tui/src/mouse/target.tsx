// SPDX-License-Identifier: MPL-2.0
import { Box, type BoxProps, type DOMElement } from 'ink';
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { MouseContext, MouseModalContext } from './context.js';
import type { LocalPoint, TargetHandlers } from './registry.js';
import type { Selection } from './selection.js';

/**
 * How an area of the screen takes part in the mouse (N34, N36). `useMouseTarget` registers a box
 * with what it does on a click, on the wheel, on a drag or on a selection; the registry finds the
 * box under the pointer by measuring it at the moment of the event, so a box that moved or scrolled
 * is where it is now.
 */

export interface MouseTargetOptions {
  /** Default `true`; a target that is off is as if it was not there. */
  readonly enabled?: boolean | undefined;
}

export interface MouseTargetState {
  /** The selection inside this area, in its own cells, while there is one (to draw it). */
  readonly selection: Selection | undefined;
}

const NO_SELECTION: MouseTargetState = { selection: undefined };

export function useMouseTarget(
  ref: RefObject<DOMElement | null>,
  handlers: TargetHandlers,
  options: MouseTargetOptions = {},
): MouseTargetState {
  const mouse = useContext(MouseContext);
  const modal = useContext(MouseModalContext);
  const enabled = options.enabled !== false;
  const latest = useRef(handlers);
  latest.current = handlers;
  const idRef = useRef(0);
  if (idRef.current === 0 && mouse !== undefined) idRef.current = mouse.registry.newId();
  const id = idRef.current;
  useEffect(() => {
    if (mouse === undefined || !enabled) return undefined;
    return mouse.registry.add({ id, node: () => ref.current, modal, handlers: latest });
  }, [mouse, enabled, id, ref, modal]);
  const registry = mouse?.registry;
  const selection = useSyncExternalStore(
    (listener) => registry?.subscribeSelection(listener) ?? (() => undefined),
    () => registry?.selection,
  );
  return useMemo(
    () => (selection?.targetId === id ? { selection } : NO_SELECTION),
    [selection, id],
  );
}

export interface ClickTargetProps extends BoxProps {
  readonly onClick: (point: LocalPoint) => void;
  readonly enabled?: boolean | undefined;
  readonly children?: ReactNode;
}

/**
 * A box that answers to a click: the way for a screen to make something clickable without knowing
 * the mouse layer (the options of a decision, P12). Without the layer it is a plain box.
 */
export function ClickTarget(props: ClickTargetProps): ReactNode {
  const { onClick, enabled, children, ...box } = props;
  const ref = useRef<DOMElement>(null);
  useMouseTarget(ref, { onClick }, { enabled });
  return (
    <Box ref={ref} {...box}>
      {children}
    </Box>
  );
}

/** Marks what is inside as an overlay: while it is on screen, the areas behind it do not answer. */
export function MouseModalScope(props: { readonly children: ReactNode }): ReactNode {
  const mouse = useContext(MouseContext);
  useEffect(() => mouse?.registry.pushModal(), [mouse]);
  return <MouseModalContext.Provider value>{props.children}</MouseModalContext.Provider>;
}
