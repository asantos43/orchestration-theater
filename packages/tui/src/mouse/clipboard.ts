// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import type { ClipboardCopyMode } from '../settings.js';

/**
 * Putting text in the clipboard (N36, `ui.clipboard.copy`). `osc52` asks the terminal to do it with
 * an escape sequence (it works over SSH and tmux when the terminal allows it); `system` runs the
 * tool of the system (pbcopy, wl-copy, xclip, xsel, clip.exe); `auto` takes the tool when the
 * interface runs on this machine and finds one, and OSC 52 otherwise; `off` copies nothing.
 */

export type CopyOutcome =
  | { readonly ok: true; readonly via: 'osc52' | 'system'; readonly chars: number }
  | {
      readonly ok: false;
      readonly reason: 'off' | 'empty' | 'too_long' | 'no_tool' | 'tool_failed';
    };

/** The clipboard sequence of the terminal: `ESC ] 52 ; c ; <base64 of the text> BEL`. */
export function osc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/** The sequence of `osc52Sequence` carried through tmux, which passes it on only inside its own wrapper. */
export function tmuxPassthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

export interface ClipboardTool {
  readonly command: string;
  readonly args: readonly string[];
}

/** What `process` tells the clipboard code about the machine. A test passes its own. */
export interface ClipboardEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Running over SSH: the clipboard of this machine is not the one the person sits at. */
function isSet(env: ClipboardEnvironment['env'], name: string): boolean {
  return (env[name] ?? '') !== '';
}

export function isRemote(environment: ClipboardEnvironment): boolean {
  const { env } = environment;
  return isSet(env, 'SSH_CONNECTION') || isSet(env, 'SSH_CLIENT') || isSet(env, 'SSH_TTY');
}

/** The tools to try, in order, on this system. */
export function systemTools(environment: ClipboardEnvironment): readonly ClipboardTool[] {
  const { platform, env } = environment;
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  if (platform === 'win32') return [{ command: 'clip.exe', args: [] }];
  const tools: ClipboardTool[] = [];
  if (isSet(env, 'WAYLAND_DISPLAY')) tools.push({ command: 'wl-copy', args: [] });
  if (isSet(env, 'DISPLAY')) {
    tools.push({ command: 'xclip', args: ['-selection', 'clipboard'] });
    tools.push({ command: 'xsel', args: ['--clipboard', '--input'] });
  }
  // Under WSL the Windows side is reachable.
  if (isSet(env, 'WSL_DISTRO_NAME')) tools.push({ command: 'clip.exe', args: [] });
  return tools;
}

/** The side effects of copying, so a test runs it with none. */
export interface ClipboardPorts {
  /** Writes to the terminal. */
  readonly write: (text: string) => void;
  /** Runs `tool` with `text` on its input; resolves `true` when it ended with success. */
  readonly run: (tool: ClipboardTool, text: string) => Promise<boolean>;
  readonly environment: ClipboardEnvironment;
  /** Inside tmux the sequence is wrapped. Default: from `TMUX` in the environment. */
  readonly tmux?: boolean | undefined;
}

/** Runs a tool with the text on its standard input; a missing tool or a failure resolves `false`. */
export function runClipboardTool(tool: ClipboardTool, text: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(tool.command, [...tool.args], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', () => {
        done(false);
      });
      child.once('close', (code) => {
        done(code === 0);
      });
      child.stdin.once('error', () => {
        done(false);
      });
      child.stdin.end(text);
    } catch {
      done(false);
    }
  });
}

export interface CopyOptions {
  readonly mode: ClipboardCopyMode;
  /** The most bytes (of the text, before the encoding) one copy carries. */
  readonly maxBytes: number;
}

/** Copies `text` as `options.mode` says. */
export async function copyText(
  text: string,
  options: CopyOptions,
  ports: ClipboardPorts,
): Promise<CopyOutcome> {
  if (options.mode === 'off') return { ok: false, reason: 'off' };
  if (text === '') return { ok: false, reason: 'empty' };
  if (Buffer.byteLength(text, 'utf8') > options.maxBytes) return { ok: false, reason: 'too_long' };
  const chars = Array.from(text).length;
  const viaTerminal = (): CopyOutcome => {
    const tmux = ports.tmux ?? isSet(ports.environment.env, 'TMUX');
    const sequence = osc52Sequence(text);
    ports.write(tmux ? tmuxPassthrough(sequence) : sequence);
    return { ok: true, via: 'osc52', chars };
  };
  if (options.mode === 'osc52') return viaTerminal();
  const useTool = options.mode === 'system' || !isRemote(ports.environment);
  if (useTool) {
    for (const tool of systemTools(ports.environment)) {
      if (await ports.run(tool, text)) return { ok: true, via: 'system', chars };
    }
  }
  if (options.mode === 'auto') return viaTerminal();
  return {
    ok: false,
    reason: systemTools(ports.environment).length === 0 ? 'no_tool' : 'tool_failed',
  };
}
