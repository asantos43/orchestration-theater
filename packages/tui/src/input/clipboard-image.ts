// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { mkdtemp, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InputSettings, ImageTool } from './settings.js';

/**
 * Ctrl+V with an image (N35): the box asks the tool of the system for the image on the clipboard,
 * the way the coding agents do (`wl-paste`, `xclip`, `osascript`). OTheater calls the tool if it
 * is installed and does not bundle it. The tool runs through {@link ClipboardIo}, which the tests
 * replace: nothing real runs in them (N57), and a tool that hangs is killed at `timeoutMs`.
 *
 * Checked locally: `wl-paste --list-types` (Linux, Wayland). NOT checked, and written from the
 * documentation of each tool: `xclip`, `osascript` (macOS) and PowerShell (Windows) [hipótese].
 */

export type ClipboardImageResult =
  | { readonly kind: 'image'; readonly path: string; readonly mime: string; readonly tool: string }
  | { readonly kind: 'no_image'; readonly tool: string }
  | { readonly kind: 'tool_missing'; readonly tried: readonly string[] }
  | { readonly kind: 'off' }
  | { readonly kind: 'timeout'; readonly tool: string; readonly ms: number }
  | { readonly kind: 'too_big'; readonly tool: string; readonly limit: number }
  | { readonly kind: 'failed'; readonly tool: string; readonly message: string };

export type RunResult =
  | { readonly kind: 'ok'; readonly stdout: Buffer }
  | { readonly kind: 'missing' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'too_big' }
  | { readonly kind: 'failed'; readonly code: number | null; readonly stderr: string };

export interface RunOptions {
  readonly timeoutMs: number;
  /** The output is cut off (and the tool killed) past this many bytes. */
  readonly maxBytes: number;
}

/** What the clipboard needs of the machine. */
export interface ClipboardIo {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Runs a tool with no terminal; `missing` when it is not installed. */
  run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult>;
  /** A new path for a file with this extension, in a folder only the user can read. */
  tempPath(extension: string): Promise<string>;
  writeFile(path: string, bytes: Buffer): Promise<void>;
  /** The size of the file, or `undefined` when it is not there. */
  fileSize(path: string): Promise<number | undefined>;
  /** Removes a file `tempPath` made, and its folder when it is left empty. */
  discard(path: string): Promise<void>;
  now(): number;
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'] as const;

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

/** The type to ask for among those the clipboard offers: the usual ones first, then any image. */
export function pickImageType(offered: readonly string[]): string | undefined {
  const types = offered.map((type) => type.trim().toLowerCase()).filter((type) => type !== '');
  for (const wanted of IMAGE_TYPES) if (types.includes(wanted)) return wanted;
  return types.find((type) => /^image\/[a-z0-9.+-]+$/.test(type));
}

/** The tools to try, in order, for the setting `tool` on this system. */
export function toolsFor(tool: ImageTool, io: Pick<ClipboardIo, 'platform' | 'env'>): ImageTool[] {
  if (tool === 'off') return [];
  if (tool !== 'auto') return [tool];
  if (io.platform === 'darwin') return ['osascript'];
  if (io.platform === 'win32') return ['powershell'];
  const wayland = (io.env.WAYLAND_DISPLAY ?? '') !== '';
  return wayland ? ['wl-paste', 'xclip'] : ['xclip', 'wl-paste'];
}

type ToolOutcome = ClipboardImageResult | { readonly kind: 'skip' };

function failure(tool: string, run: Extract<RunResult, { kind: 'failed' }>): ClipboardImageResult {
  const message = run.stderr.trim().split('\n')[0]?.slice(0, 200) ?? '';
  return { kind: 'failed', tool, message: message === '' ? `exit ${String(run.code)}` : message };
}

const NOTHING_COPIED = /nothing is copied|no selection|target .* not available|cannot convert/i;

/** `wl-paste` and `xclip`: list the types, then read the image to a temporary file. */
async function readWithTypes(
  tool: 'wl-paste' | 'xclip',
  io: ClipboardIo,
  options: RunOptions,
  remaining: () => number,
): Promise<ToolOutcome> {
  const listArgs =
    tool === 'wl-paste' ? ['--list-types'] : ['-selection', 'clipboard', '-t', 'TARGETS', '-o'];
  const listed = await io.run(tool, listArgs, { ...options, timeoutMs: remaining() });
  if (listed.kind === 'missing') return { kind: 'skip' };
  if (listed.kind === 'timeout') return { kind: 'timeout', tool, ms: options.timeoutMs };
  if (listed.kind === 'too_big') return { kind: 'failed', tool, message: 'too much output' };
  if (listed.kind === 'failed') {
    return NOTHING_COPIED.test(listed.stderr) ? { kind: 'no_image', tool } : failure(tool, listed);
  }
  const mime = pickImageType(listed.stdout.toString('utf8').split('\n'));
  if (mime === undefined) return { kind: 'no_image', tool };
  const readArgs =
    tool === 'wl-paste' ? ['--type', mime] : ['-selection', 'clipboard', '-t', mime, '-o'];
  const read = await io.run(tool, readArgs, { ...options, timeoutMs: remaining() });
  if (read.kind === 'missing') return { kind: 'skip' };
  if (read.kind === 'timeout') return { kind: 'timeout', tool, ms: options.timeoutMs };
  if (read.kind === 'too_big') return { kind: 'too_big', tool, limit: options.maxBytes };
  if (read.kind === 'failed') return failure(tool, read);
  if (read.stdout.length === 0) return { kind: 'no_image', tool };
  const path = await io.tempPath(EXTENSIONS[mime] ?? 'img');
  await io.writeFile(path, read.stdout);
  return { kind: 'image', path, mime, tool };
}

/** `osascript` and PowerShell write the file themselves; a failure with a known mark is "no image". */
async function readToFile(
  tool: 'osascript' | 'powershell',
  io: ClipboardIo,
  options: RunOptions,
  remaining: () => number,
): Promise<ToolOutcome> {
  const path = await io.tempPath('png');
  const [command, args] =
    tool === 'osascript' ? ['osascript', macScript(path)] : ['powershell', windowsScript(path)];
  const ran = await io.run(command, args, { ...options, timeoutMs: remaining() });
  if (ran.kind === 'missing') return { kind: 'skip' };
  if (ran.kind === 'timeout') return { kind: 'timeout', tool, ms: options.timeoutMs };
  if (ran.kind === 'too_big') return { kind: 'too_big', tool, limit: options.maxBytes };
  if (ran.kind === 'failed') {
    // osascript: "Can't make some data into the expected type" (-1700); PowerShell: exit 3 (below).
    if (ran.code === 3 || /-1700|expected type|can.t make/i.test(ran.stderr)) {
      return { kind: 'no_image', tool };
    }
    return failure(tool, ran);
  }
  const size = await io.fileSize(path);
  if (size === undefined || size === 0) return { kind: 'no_image', tool };
  if (size > options.maxBytes) return { kind: 'too_big', tool, limit: options.maxBytes };
  return { kind: 'image', path, mime: 'image/png', tool };
}

function macScript(path: string): string[] {
  const file = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    '-e',
    'set png_data to the clipboard as «class PNGf»',
    '-e',
    `set fp to open for access POSIX file "${file}" with write permission`,
    '-e',
    'write png_data to fp',
    '-e',
    'close access fp',
  ];
}

function windowsScript(path: string): string[] {
  const file = path.replace(/'/g, "''");
  const command = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$image = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $image) { exit 3 }',
    `$image.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join('; ');
  return ['-NoProfile', '-NonInteractive', '-STA', '-Command', command];
}

/**
 * Reads the image on the clipboard to a temporary file. Never throws and never waits for more than
 * about `image.timeoutMs`: the tools are killed at the deadline.
 */
export async function readClipboardImage(
  settings: InputSettings['image'],
  io: ClipboardIo,
): Promise<ClipboardImageResult> {
  const tools = toolsFor(settings.tool, io);
  if (tools.length === 0) return { kind: 'off' };
  const deadline = io.now() + settings.timeoutMs;
  const remaining = (): number => Math.max(1, deadline - io.now());
  const options: RunOptions = { timeoutMs: settings.timeoutMs, maxBytes: settings.maxBytes };
  const tried: string[] = [];
  try {
    for (const tool of tools) {
      const outcome =
        tool === 'wl-paste' || tool === 'xclip'
          ? await readWithTypes(tool, io, options, remaining)
          : await readToFile(tool as 'osascript' | 'powershell', io, options, remaining);
      if (outcome.kind !== 'skip') return outcome;
      tried.push(tool);
    }
  } catch (error) {
    return { kind: 'failed', tool: tools[0] ?? '', message: errorMessage(error) };
  }
  return { kind: 'tool_missing', tried };
}

export function errorMessage(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 200) ?? ''
  );
}

// ---- The real machine --------------------------------------------------------------------------

/** Runs a command with no terminal, killing it at the deadline or past `maxBytes` of output. */
export function runTool(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ kind: 'timeout' });
    }, options.timeoutMs);
    const out: Buffer[] = [];
    let size = 0;
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) {
        child.kill('SIGKILL');
        done({ kind: 'too_big' });
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.reduce((total, part) => total + part.length, 0) < 4096) err.push(chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') done({ kind: 'missing' });
      else done({ kind: 'failed', code: null, stderr: error.message });
    });
    child.on('close', (code) => {
      if (code === 0) done({ kind: 'ok', stdout: Buffer.concat(out) });
      else done({ kind: 'failed', code, stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

/** The clipboard on this machine. */
export function createClipboardIo(): ClipboardIo {
  let folder: Promise<string> | undefined;
  let count = 0;
  return {
    platform: process.platform,
    env: process.env,
    run: runTool,
    tempPath: async (extension) => {
      // mkdtemp makes the folder with mode 0700.
      folder ??= mkdtemp(join(tmpdir(), 'otheater-clip-'));
      count += 1;
      return join(await folder, `clipboard-${String(count)}.${extension}`);
    },
    writeFile: (path, bytes) => writeFile(path, bytes, { mode: 0o600 }),
    fileSize: async (path) => {
      try {
        return (await stat(path)).size;
      } catch {
        return undefined;
      }
    },
    discard: async (path) => {
      await rm(path, { force: true });
      try {
        await rmdir(dirname(path));
      } catch {
        // Not empty (another image is waiting there) or already gone.
      }
    },
    now: () => Date.now(),
  };
}
