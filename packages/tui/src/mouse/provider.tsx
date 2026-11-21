// SPDX-License-Identifier: MPL-2.0
import { useApp, useStdin } from 'ink';
import { useCallback, useEffect, useMemo, useContext, type ReactNode } from 'react';
import type { ClipboardCopyMode, MouseMode, UiTuiMouseSettings } from '../settings.js';
import { copyText, runClipboardTool, type ClipboardPorts, type CopyOutcome } from './clipboard.js';
import { MouseContext, type MouseContextValue } from './context.js';
import { MouseModes, type MouseTerminal } from './modes.js';
import { MouseRegistry } from './registry.js';
import { tapStdin } from './stdin-tap.js';

export interface MouseLayerProps {
  /** `ui.mouse`. */
  readonly mode: MouseMode;
  /** `ui.clipboard.copy`. */
  readonly copy: ClipboardCopyMode;
  /** `ui.tuiMouse`. */
  readonly tuning: UiTuiMouseSettings;
  /**
   * Where the mode sequences and the OSC 52 copy are written: the terminal of the TUI. With none the
   * layer does nothing, so the screens that do not look at the mouse stay as they were.
   */
  readonly terminal?: MouseTerminal | undefined;
  /** The ports of the copy (the tool of the system, the environment); the defaults are the real ones. */
  readonly clipboard?: Partial<Omit<ClipboardPorts, 'write'>> | undefined;
  readonly children: ReactNode;
}

/**
 * Turns the mouse on while the TUI runs and off when it ends (unmount, Ctrl+C, the terminal given
 * to an editor), takes the reports out of the keyboard line, and hands them to the areas.
 */
export function MouseLayer(props: MouseLayerProps): ReactNode {
  const { mode, terminal, tuning } = props;
  const { stdin } = useStdin();
  const registry = useMemo(() => new MouseRegistry(), []);
  const modes = useMemo(
    () => (terminal === undefined ? undefined : new MouseModes(terminal, mode)),
    [terminal, mode],
  );
  const ports = useMemo(
    (): ClipboardPorts => ({
      write: (text) => {
        terminal?.write(text);
      },
      run: runClipboardTool,
      environment: { platform: process.platform, env: process.env },
      ...props.clipboard,
    }),
    [terminal, props.clipboard],
  );
  registry.configure({
    mode: mode === 'wheel' ? 'wheel' : 'full',
    wheelLines: tuning.wheelLines,
    copy: (text) => copyText(text, { mode: props.copy, maxBytes: tuning.copyMaxBytes }, ports),
  });
  const active = modes !== undefined && mode !== 'off';

  useEffect(() => {
    if (!active) return undefined;
    const restore = tapStdin(stdin, (event) => {
      registry.handle(event);
    });
    modes.enable();
    return () => {
      modes.disable();
      restore();
      registry.clearSelection();
    };
  }, [active, modes, registry, stdin]);

  const suspend = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      modes?.disable();
      try {
        return await run();
      } finally {
        if (active) modes.enable();
      }
    },
    [modes, active],
  );
  const value = useMemo((): MouseContextValue | undefined => {
    return active ? { registry, suspend } : undefined;
  }, [active, registry, suspend]);
  return <MouseContext.Provider value={value}>{props.children}</MouseContext.Provider>;
}

/**
 * `suspendTerminal` of Ink for a program that takes the terminal over (the editor of Ctrl+G): the
 * mouse reports are off while it runs and back on when it is done.
 */
export function useSuspendTerminal(): (callback: () => void | Promise<void>) => Promise<void> {
  const { suspendTerminal } = useApp();
  const mouse = useContext(MouseContext);
  return useCallback(
    (callback) =>
      suspendTerminal(async () => {
        if (mouse === undefined) {
          await callback();
          return;
        }
        await mouse.suspend(async () => {
          await callback();
        });
      }),
    [suspendTerminal, mouse],
  );
}

/** Tells `listener` how each copy of a selection went (the screen says it in the bar). */
export function useMouseCopy(listener: (outcome: CopyOutcome) => void): void {
  const mouse = useContext(MouseContext);
  useEffect(() => mouse?.registry.onCopy(listener), [mouse, listener]);
}
