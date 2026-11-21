// SPDX-License-Identifier: MPL-2.0
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createClipboardIo,
  pickImageType,
  readClipboardImage,
  runTool,
  toolsFor,
  type ClipboardIo,
  type RunResult,
} from './clipboard-image.js';
import { DEFAULT_INPUT_SETTINGS } from './settings.js';

const settings = DEFAULT_INPUT_SETTINGS.image;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const ok = (text: string | Buffer): RunResult => ({
  kind: 'ok',
  stdout: Buffer.isBuffer(text) ? text : Buffer.from(text),
});

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

/** A clipboard that answers from `answers` (by command and first argument); nothing real runs. */
function fakeIo(
  answers: (call: Call) => RunResult,
  options: {
    platform?: NodeJS.Platform;
    env?: Record<string, string>;
    sizes?: Record<string, number>;
  } = {},
): { io: ClipboardIo; calls: Call[]; written: Map<string, Buffer> } {
  const calls: Call[] = [];
  const written = new Map<string, Buffer>();
  let count = 0;
  let clock = 0;
  const io: ClipboardIo = {
    platform: options.platform ?? 'linux',
    env: options.env ?? {},
    run: (command, args) => {
      calls.push({ command, args });
      clock += 10;
      return Promise.resolve(answers({ command, args }));
    },
    tempPath: (extension) => Promise.resolve(`/tmp/fake/clip-${String((count += 1))}.${extension}`),
    writeFile: (path, bytes) => {
      written.set(path, bytes);
      return Promise.resolve();
    },
    fileSize: (path) => Promise.resolve(options.sizes?.[path]),
    discard: () => Promise.resolve(),
    now: () => clock,
  };
  return { io, calls, written };
}

describe('the image of the clipboard', () => {
  it('picks the type to ask for', () => {
    expect(pickImageType(['text/plain', 'image/jpeg', 'image/png'])).toBe('image/png');
    expect(pickImageType(['image/x-icon'])).toBe('image/x-icon');
    expect(pickImageType(['text/plain', 'STRING'])).toBeUndefined();
    expect(pickImageType([])).toBeUndefined();
  });

  it('chooses the tools by the system and by the setting', () => {
    const linux = (env: Record<string, string>) => ({ platform: 'linux' as const, env });
    expect(toolsFor('auto', linux({ WAYLAND_DISPLAY: 'wayland-0' }))).toEqual([
      'wl-paste',
      'xclip',
    ]);
    expect(toolsFor('auto', linux({}))).toEqual(['xclip', 'wl-paste']);
    expect(toolsFor('auto', { platform: 'darwin', env: {} })).toEqual(['osascript']);
    expect(toolsFor('auto', { platform: 'win32', env: {} })).toEqual(['powershell']);
    expect(toolsFor('xclip', linux({}))).toEqual(['xclip']);
    expect(toolsFor('off', linux({}))).toEqual([]);
  });

  it('reads a PNG with wl-paste to a temporary file', async () => {
    const { io, calls, written } = fakeIo(
      ({ args }) => (args[0] === '--list-types' ? ok('text/plain\nimage/png\n') : ok(PNG)),
      { env: { WAYLAND_DISPLAY: 'wayland-0' } },
    );
    const result = await readClipboardImage(settings, io);
    expect(result).toEqual({
      kind: 'image',
      path: '/tmp/fake/clip-1.png',
      mime: 'image/png',
      tool: 'wl-paste',
    });
    expect(written.get('/tmp/fake/clip-1.png')).toEqual(PNG);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ['wl-paste', '--list-types'],
      ['wl-paste', '--type', 'image/png'],
    ]);
  });

  it('reads with xclip when wl-paste is not installed', async () => {
    const { io } = fakeIo(
      ({ command, args }) => {
        if (command === 'wl-paste') return { kind: 'missing' };
        return args.includes('TARGETS') ? ok('TARGETS\nimage/jpeg\n') : ok(PNG);
      },
      { env: { WAYLAND_DISPLAY: 'wayland-0' } },
    );
    const result = await readClipboardImage(settings, io);
    expect(result).toMatchObject({ kind: 'image', mime: 'image/jpeg', tool: 'xclip' });
    expect((result as { path: string }).path.endsWith('.jpg')).toBe(true);
  });

  it('says what is missing when no tool is installed, and does not hang', async () => {
    const { io, calls } = fakeIo(() => ({ kind: 'missing' }), { env: { WAYLAND_DISPLAY: 'x' } });
    expect(await readClipboardImage(settings, io)).toEqual({
      kind: 'tool_missing',
      tried: ['wl-paste', 'xclip'],
    });
    expect(calls).toHaveLength(2);
  });

  it('says there is no image when the clipboard holds only text, or nothing', async () => {
    const text = fakeIo(() => ok('text/plain\nSTRING\n'));
    expect(await readClipboardImage(settings, text.io)).toMatchObject({ kind: 'no_image' });
    const empty = fakeIo(() => ({ kind: 'failed', code: 1, stderr: 'Nothing is copied\n' }));
    expect(await readClipboardImage(settings, empty.io)).toMatchObject({ kind: 'no_image' });
  });

  it('reports a tool that fails, one that times out and an image that is too big', async () => {
    const failed = fakeIo(() => ({ kind: 'failed', code: 2, stderr: 'boom\nmore' }));
    expect(await readClipboardImage(settings, failed.io)).toEqual({
      kind: 'failed',
      tool: 'xclip',
      message: 'boom',
    });
    const slow = fakeIo(() => ({ kind: 'timeout' }));
    expect(await readClipboardImage(settings, slow.io)).toMatchObject({
      kind: 'timeout',
      ms: settings.timeoutMs,
    });
    const big = fakeIo(({ args }) =>
      args.includes('TARGETS') ? ok('image/png') : { kind: 'too_big' },
    );
    expect(await readClipboardImage(settings, big.io)).toMatchObject({
      kind: 'too_big',
      limit: settings.maxBytes,
    });
  });

  it('does not run anything with `image.tool: off`', async () => {
    const { io, calls } = fakeIo(() => ok(''));
    expect(await readClipboardImage({ ...settings, tool: 'off' }, io)).toEqual({ kind: 'off' });
    expect(calls).toHaveLength(0);
  });

  it('reads with osascript and PowerShell, which write the file themselves', async () => {
    const mac = fakeIo(() => ok(''), {
      platform: 'darwin',
      sizes: { '/tmp/fake/clip-1.png': 2048 },
    });
    expect(await readClipboardImage(settings, mac.io)).toMatchObject({
      kind: 'image',
      tool: 'osascript',
    });
    expect(mac.calls[0]?.args.join(' ')).toContain('«class PNGf»');
    const none = fakeIo(() => ({ kind: 'failed', code: 3, stderr: '' }), { platform: 'win32' });
    expect(await readClipboardImage(settings, none.io)).toMatchObject({
      kind: 'no_image',
      tool: 'powershell',
    });
    const huge = fakeIo(() => ok(''), {
      platform: 'win32',
      sizes: { '/tmp/fake/clip-1.png': settings.maxBytes + 1 },
    });
    expect(await readClipboardImage(settings, huge.io)).toMatchObject({ kind: 'too_big' });
  });

  it('turns an exception of the machine into a failure', async () => {
    const { io } = fakeIo(() => ok('image/png'));
    const broken: ClipboardIo = {
      ...io,
      writeFile: () => Promise.reject(new Error('disk full')),
    };
    const result = await readClipboardImage(settings, {
      ...broken,
      run: (_c, args) => Promise.resolve(args[0] === '--list-types' ? ok('image/png') : ok(PNG)),
      env: { WAYLAND_DISPLAY: 'x' },
    });
    expect(result).toEqual({ kind: 'failed', tool: 'wl-paste', message: 'disk full' });
  });
});

describe('the real runner of tools (local processes only)', () => {
  const folders: string[] = [];
  afterEach(async () => {
    for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  });
  const options = { timeoutMs: 5000, maxBytes: 1024 };

  it('collects the output of a tool', async () => {
    const result = await runTool(process.execPath, ['-e', "process.stdout.write('hi')"], options);
    expect(result).toEqual({ kind: 'ok', stdout: Buffer.from('hi') });
  });

  it('says a command is not installed', async () => {
    expect(await runTool('ot-tool-that-is-not-installed', [], options)).toEqual({
      kind: 'missing',
    });
  });

  it('reports the failure with what the tool said', async () => {
    const result = await runTool(
      process.execPath,
      ['-e', "console.error('bad'); process.exit(4)"],
      options,
    );
    expect(result).toMatchObject({ kind: 'failed', code: 4 });
    expect((result as { stderr: string }).stderr).toContain('bad');
  });

  it('kills a tool that does not answer, at the deadline', async () => {
    const started = Date.now();
    const result = await runTool(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      timeoutMs: 200,
      maxBytes: 1024,
    });
    expect(result).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops a tool that writes more than the limit', async () => {
    const result = await runTool(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(100000))"],
      { timeoutMs: 5000, maxBytes: 100 },
    );
    expect(result).toEqual({ kind: 'too_big' });
  });

  it('gives private temporary files and takes them back', async () => {
    const io = createClipboardIo();
    const path = await io.tempPath('png');
    folders.push(join(path, '..'));
    await io.writeFile(path, PNG);
    expect(await io.fileSize(path)).toBe(PNG.length);
    expect(await readFile(path)).toEqual(PNG);
    await io.discard(path);
    expect(await io.fileSize(path)).toBeUndefined();
  });
});
