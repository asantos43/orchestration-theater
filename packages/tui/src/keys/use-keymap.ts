// SPDX-License-Identifier: MPL-2.0
import {
  DEFAULT_UI_REGISTRY,
  detectKeymapEnvironment,
  matchKey,
  resolveKeymapFromConfig,
  type KeymapEnv,
  type KeymapError,
  type KeymapNotice,
  type ResolvedKeymap,
  type UiContext,
  type UiRegistry,
} from '@otheater/client';
import { useStdin } from 'ink';
import { EventEmitter } from 'node:events';
import { useEffect, useEffectEvent, useMemo } from 'react';
import type { UiKeymapSettings } from '../settings.js';
import { parseTerminalKey } from './combo.js';

/** The environment the keymap adapts to (macOS, tmux, the terminal of VS Code). */
export interface KeyEnvironment {
  readonly env: KeymapEnv;
  readonly platform: string;
}

export function currentKeyEnvironment(): KeyEnvironment {
  return { env: process.env, platform: process.platform };
}

/** The keymap in force, the registry it was made from, and what the person should be told. */
export interface TuiKeymap {
  readonly registry: UiRegistry;
  readonly keymap: ResolvedKeymap;
  readonly warnings: readonly KeymapNotice[];
  readonly errors: readonly KeymapError[];
  /** The action a key triggers among the contexts alive now; `undefined` for none. */
  match(combo: string, contexts?: readonly UiContext[]): string | undefined;
}

/**
 * `ui.keymap` of the configuration over the registry of the interface (N35). A bad override does
 * not stop the TUI: the preset as written serves and `errors` says why.
 */
export function buildTuiKeymap(
  settings: UiKeymapSettings,
  environment: KeyEnvironment = currentKeyEnvironment(),
  registry: UiRegistry = DEFAULT_UI_REGISTRY,
): TuiKeymap {
  const resolved = resolveKeymapFromConfig(
    registry,
    settings,
    detectKeymapEnvironment(environment.env, environment.platform),
  );
  return {
    registry,
    keymap: resolved.keymap,
    warnings: resolved.warnings,
    errors: resolved.errors,
    match: (combo, contexts = ['global']) => matchKey(resolved.keymap, registry, combo, contexts),
  };
}

export function useTuiKeymap(settings: UiKeymapSettings, environment?: KeyEnvironment): TuiKeymap {
  return useMemo(
    () => buildTuiKeymap(settings, environment),
    [settings.preset, settings.environment, settings.overrides, environment],
  );
}

/** One key press as the layout sees it: the combination (when it is a key) and the raw bytes. */
export interface KeyEvent {
  /** Canonical combination (`Alt+S`), or `undefined` for text and for what is not understood. */
  readonly combo: string | undefined;
  /** What the terminal sent. */
  readonly data: string;
}

/** What `useStdin()` gives at run time, beyond the types: the emitter Ink's own `useInput` listens on. */
interface InkStdin {
  readonly setRawMode: (value: boolean) => void;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  readonly internal_eventEmitter?: EventEmitter | undefined;
}

/**
 * Listens to the keys as the terminal sent them, one call per already split sequence. Ink's
 * `useInput` hides the F keys and the modifiers of the arrows; the keymap needs them. Both read
 * the same stream, so a text box that uses `useInput` keeps working beside this.
 */
export function useRawKeys(
  handler: (event: KeyEvent) => void,
  options: { readonly isActive?: boolean } = {},
): void {
  const stdin = useStdin() as unknown as InkStdin;
  const emitter = stdin.internal_eventEmitter;
  const { setRawMode } = stdin;
  const active = options.isActive ?? true;
  const handle = useEffectEvent((data: unknown) => {
    if (typeof data !== 'string') return;
    handler({ combo: parseTerminalKey(data), data });
  });
  useEffect(() => {
    if (!active || emitter === undefined) return undefined;
    setRawMode(true);
    const listener = (data: unknown): void => {
      handle(data);
    };
    emitter.on('input', listener);
    return () => {
      emitter.removeListener('input', listener);
      setRawMode(false);
    };
  }, [active, emitter, setRawMode]);
}
