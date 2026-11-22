// SPDX-License-Identifier: MPL-2.0
import { measureElement, type DOMElement } from 'ink';
import type { CopyOutcome } from './clipboard.js';
import type { MouseEvent } from './sgr.js';
import {
  isEmptySelection,
  selectedText,
  selectionRange,
  type Cell,
  type Selection,
} from './selection.js';

/**
 * Where a mouse report goes (N34, N36). The areas of the screen register themselves as targets;
 * the registry finds the one under the pointer (the box that is measured at the moment of the
 * event, cut by the boxes around it that hide what overflows, so a scrolled list answers only for
 * the rows it shows) and runs what the target asked for: a click, a wheel notch, a drag of its
 * edge, or the selection of its text.
 */

/** A point inside a target: `x` and `y` from its top left cell, `col` and `row` of the terminal. */
export interface LocalPoint {
  readonly x: number;
  readonly y: number;
  readonly col: number;
  readonly row: number;
}

export interface DragInfo {
  readonly phase: 'start' | 'move' | 'end';
  /** Where the press was and where the pointer is, in terminal cells. */
  readonly start: { readonly col: number; readonly row: number };
  readonly current: { readonly col: number; readonly row: number };
  readonly dx: number;
  readonly dy: number;
}

/** What a target does. A target with none of these is not hit. */
export interface TargetHandlers {
  /**
   * A press (the button going down) anywhere in the visible box of the target. It is not exclusive:
   * it does not take part in the choice of the smallest target and does not start a gesture, so the
   * click, the drag and the selection of the target under the pointer go on as if it was not there.
   * It is how an area learns it was pressed (to take the focus) while what is inside still gets
   * the click. It runs before the gesture starts, so the drag of an edge has the last word.
   */
  readonly onPress?: ((point: LocalPoint) => void) | undefined;
  /** A press and a release on the same target, with no move between. */
  readonly onClick?: ((point: LocalPoint) => void) | undefined;
  /** `lines` is positive for a notch down (toward the end of a list) and negative for a notch up. */
  readonly onWheel?: ((lines: number, point: LocalPoint) => void) | undefined;
  /** The target is dragged (the edge of the chat); it replaces the selection and the click. */
  readonly onDrag?: ((drag: DragInfo) => void) | undefined;
  /** The rows the area shows, as plain text, top to bottom. It makes the area selectable. */
  readonly rows?: (() => readonly string[]) | undefined;
}

export interface MouseTarget {
  readonly id: number;
  readonly node: () => DOMElement | null | undefined;
  /** The target belongs to an overlay: while one is open, only these answer. */
  readonly modal: boolean;
  readonly handlers: { readonly current: TargetHandlers };
}

/** What the mouse does. `wheel` only scrolls; `full` also clicks, drags and selects. */
export type MouseLayerMode = 'full' | 'wheel';

export interface MouseRegistryConfig {
  readonly mode: MouseLayerMode;
  /** Lines of a list one notch of the wheel moves. */
  readonly wheelLines: number;
  /** Copies the selected text; the registry tells the listeners how it went. */
  readonly copy: (text: string) => Promise<CopyOutcome>;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** A box where it is on the screen now, and the part of it that shows (the boxes around it that hide what overflows cut it). */
export function measureBox(node: DOMElement): { full: Rect; visible: Rect } | undefined {
  const own = measureElement(node);
  if (own.width <= 0 || own.height <= 0) return undefined;
  const full: Rect = { x: own.x, y: own.y, width: own.width, height: own.height };
  let visible = full;
  for (let parent = node.parentNode; parent !== undefined; parent = parent.parentNode) {
    const style = parent.style as { overflow?: string; overflowX?: string; overflowY?: string };
    const clipX = (style.overflowX ?? style.overflow) === 'hidden';
    const clipY = (style.overflowY ?? style.overflow) === 'hidden';
    if (!clipX && !clipY) continue;
    const box = measureElement(parent);
    visible = intersect(visible, {
      x: clipX ? box.x : visible.x,
      y: clipY ? box.y : visible.y,
      width: clipX ? box.width : visible.width,
      height: clipY ? box.height : visible.height,
    });
  }
  return visible.width <= 0 || visible.height <= 0 ? undefined : { full, visible };
}

function contains(rect: Rect, col: number, row: number): boolean {
  return col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height;
}

interface Gesture {
  readonly target: MouseTarget;
  readonly start: { readonly col: number; readonly row: number };
  readonly anchor: Cell;
  moved: boolean;
}

export type SelectionState = Selection & { readonly targetId: number };

export class MouseRegistry {
  #targets = new Map<number, MouseTarget>();
  #nextId = 1;
  #modals = 0;
  #gesture: Gesture | undefined;
  #selection: SelectionState | undefined;
  #selectionListeners = new Set<() => void>();
  #copyListeners = new Set<(outcome: CopyOutcome) => void>();
  #config: MouseRegistryConfig = {
    mode: 'full',
    wheelLines: 3,
    copy: () => Promise.resolve({ ok: false, reason: 'off' }),
  };

  configure(config: MouseRegistryConfig): void {
    this.#config = config;
  }

  newId(): number {
    const id = this.#nextId;
    this.#nextId += 1;
    return id;
  }

  add(target: MouseTarget): () => void {
    this.#targets.set(target.id, target);
    return () => {
      this.#targets.delete(target.id);
      if (this.#gesture?.target.id === target.id) this.#gesture = undefined;
      if (this.#selection?.targetId === target.id) this.#setSelection(undefined);
    };
  }

  /** An overlay is open: only the targets inside it answer. Returns the way to say it closed. */
  pushModal(): () => void {
    this.#modals += 1;
    return () => {
      this.#modals = Math.max(0, this.#modals - 1);
    };
  }

  get size(): number {
    return this.#targets.size;
  }

  // ---- The selection, for the areas that draw it ---------------------------------------------

  get selection(): SelectionState | undefined {
    return this.#selection;
  }

  subscribeSelection(listener: () => void): () => void {
    this.#selectionListeners.add(listener);
    return () => {
      this.#selectionListeners.delete(listener);
    };
  }

  onCopy(listener: (outcome: CopyOutcome) => void): () => void {
    this.#copyListeners.add(listener);
    return () => {
      this.#copyListeners.delete(listener);
    };
  }

  clearSelection(): void {
    this.#setSelection(undefined);
  }

  #setSelection(selection: SelectionState | undefined): void {
    this.#selection = selection;
    for (const listener of [...this.#selectionListeners]) listener();
  }

  // ---- Hit test -------------------------------------------------------------------------------

  /** The target under the cell that has `wants`, the smallest one, and among equals the last registered. */
  #hit(
    col: number,
    row: number,
    wants: (handlers: TargetHandlers) => boolean,
  ): { target: MouseTarget; full: Rect; visible: Rect } | undefined {
    let best: { target: MouseTarget; full: Rect; visible: Rect } | undefined;
    for (const target of this.#targets.values()) {
      if (this.#modals > 0 && !target.modal) continue;
      if (!wants(target.handlers.current)) continue;
      const node = target.node();
      if (node === null || node === undefined) continue;
      const box = measureBox(node);
      if (box === undefined || !contains(box.visible, col, row)) continue;
      const area = box.visible.width * box.visible.height;
      const bestArea = best === undefined ? Infinity : best.visible.width * best.visible.height;
      if (area <= bestArea) best = { target, ...box };
    }
    return best;
  }

  #local(full: Rect, col: number, row: number): LocalPoint {
    return { x: col - full.x, y: row - full.y, col, row };
  }

  // ---- Events ---------------------------------------------------------------------------------

  handle(event: MouseEvent): void {
    if (event.action === 'wheel') {
      this.#wheel(event);
      return;
    }
    if (this.#config.mode !== 'full' || event.button !== 'left') return;
    if (event.action === 'press') this.#press(event);
    else if (event.action === 'drag') this.#drag(event);
    else if (event.action === 'release') this.#release(event);
  }

  #wheel(event: MouseEvent): void {
    const sign = event.wheel === 'up' ? -1 : event.wheel === 'down' ? 1 : 0;
    if (sign === 0) return;
    const hit = this.#hit(event.col, event.row, (h) => h.onWheel !== undefined);
    if (hit === undefined) return;
    if (this.#selection?.targetId === hit.target.id) this.#setSelection(undefined);
    hit.target.handlers.current.onWheel?.(
      sign * this.#config.wheelLines,
      this.#local(hit.full, event.col, event.row),
    );
  }

  /** Tells every target that has `onPress` and shows the cell that it was pressed. */
  #announcePress(col: number, row: number): void {
    for (const target of [...this.#targets.values()]) {
      if (this.#modals > 0 && !target.modal) continue;
      const onPress = target.handlers.current.onPress;
      if (onPress === undefined) continue;
      const node = target.node();
      if (node === null || node === undefined) continue;
      const box = measureBox(node);
      if (box === undefined || !contains(box.visible, col, row)) continue;
      onPress(this.#local(box.full, col, row));
    }
  }

  #press(event: MouseEvent): void {
    this.#setSelection(undefined);
    this.#gesture = undefined;
    this.#announcePress(event.col, event.row);
    const hit = this.#hit(
      event.col,
      event.row,
      (h) => h.onClick !== undefined || h.onDrag !== undefined || h.rows !== undefined,
    );
    if (hit === undefined) return;
    const local = this.#local(hit.full, event.col, event.row);
    this.#gesture = {
      target: hit.target,
      start: { col: event.col, row: event.row },
      anchor: { x: local.x, y: local.y },
      moved: false,
    };
    hit.target.handlers.current.onDrag?.({
      phase: 'start',
      start: { col: event.col, row: event.row },
      current: { col: event.col, row: event.row },
      dx: 0,
      dy: 0,
    });
  }

  #drag(event: MouseEvent): void {
    const gesture = this.#gesture;
    if (gesture === undefined) return;
    if (event.col !== gesture.start.col || event.row !== gesture.start.row) gesture.moved = true;
    const handlers = gesture.target.handlers.current;
    if (handlers.onDrag !== undefined) {
      handlers.onDrag({
        phase: 'move',
        start: gesture.start,
        current: { col: event.col, row: event.row },
        dx: event.col - gesture.start.col,
        dy: event.row - gesture.start.row,
      });
      return;
    }
    if (handlers.rows === undefined || !gesture.moved) return;
    const node = gesture.target.node();
    const box = node === null || node === undefined ? undefined : measureBox(node);
    if (box === undefined) return;
    // The head stays inside the area: a drag that leaves it selects up to its edge.
    const head: Cell = {
      x: Math.max(0, Math.min(box.full.width - 1, event.col - box.full.x)),
      y: Math.max(0, Math.min(box.full.height - 1, event.row - box.full.y)),
    };
    this.#setSelection({ targetId: gesture.target.id, anchor: gesture.anchor, head });
  }

  #release(event: MouseEvent): void {
    const gesture = this.#gesture;
    this.#gesture = undefined;
    if (gesture === undefined) return;
    const handlers = gesture.target.handlers.current;
    if (handlers.onDrag !== undefined) {
      handlers.onDrag({
        phase: 'end',
        start: gesture.start,
        current: { col: event.col, row: event.row },
        dx: event.col - gesture.start.col,
        dy: event.row - gesture.start.row,
      });
      return;
    }
    const selection = this.#selection;
    if (selection?.targetId === gesture.target.id && !isEmptySelection(selection)) {
      const node = gesture.target.node();
      const box = node === null || node === undefined ? undefined : measureBox(node);
      const rows = handlers.rows?.();
      if (box !== undefined && rows !== undefined) {
        const text = selectedText(rows, selectionRange(selection), box.full.width);
        void this.#config.copy(text).then((outcome) => {
          for (const listener of [...this.#copyListeners]) listener(outcome);
        });
      }
      return;
    }
    if (gesture.moved || handlers.onClick === undefined) return;
    // The click counts when the release is on the same target as the press.
    const hit = this.#hit(event.col, event.row, (h) => h.onClick !== undefined);
    if (hit?.target.id !== gesture.target.id) return;
    handlers.onClick(this.#local(hit.full, event.col, event.row));
  }
}
