// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  copyText,
  isRemote,
  osc52Sequence,
  systemTools,
  tmuxPassthrough,
  type ClipboardEnvironment,
  type ClipboardPorts,
  type ClipboardTool,
} from './clipboard.js';

const local: ClipboardEnvironment = { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } };

function ports(
  environment: ClipboardEnvironment,
  works = true,
): { ports: ClipboardPorts; written: string[]; ran: ClipboardTool[] } {
  const written: string[] = [];
  const ran: ClipboardTool[] = [];
  return {
    written,
    ran,
    ports: {
      write: (text) => written.push(text),
      run: (tool) => {
        ran.push(tool);
        return Promise.resolve(works);
      },
      environment,
    },
  };
}

describe('osc52Sequence', () => {
  it('is ESC ] 52 ; c ; base64 BEL, byte for byte', () => {
    expect(osc52Sequence('hello')).toBe('\x1b]52;c;aGVsbG8=\x07');
    expect(osc52Sequence('hello')).toBe(`\u001b]52;c;${btoa('hello')}\u0007`);
  });

  it('encodes the text as UTF-8', () => {
    expect(osc52Sequence('ação')).toBe('\x1b]52;c;YcOnw6Nv\x07');
  });

  it('carries the sequence through tmux with the escapes doubled', () => {
    expect(tmuxPassthrough('\x1b]52;c;aGk=\x07')).toBe('\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\');
  });
});

describe('copyText', () => {
  it('writes the exact OSC 52 sequence in osc52 mode', async () => {
    const { ports: p, written } = ports(local);
    await expect(copyText('hello', { mode: 'osc52', maxBytes: 100 }, p)).resolves.toEqual({
      ok: true,
      via: 'osc52',
      chars: 5,
    });
    expect(written).toEqual(['\x1b]52;c;aGVsbG8=\x07']);
  });

  it('wraps it for tmux', async () => {
    const { ports: p, written } = ports({
      platform: 'linux',
      env: { TMUX: '/tmp/tmux-1/default,1,0' },
    });
    await copyText('hi', { mode: 'osc52', maxBytes: 100 }, p);
    expect(written).toEqual(['\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\']);
  });

  it('copies nothing when off, empty or too long', async () => {
    const { ports: p, written, ran } = ports(local);
    await expect(copyText('x', { mode: 'off', maxBytes: 100 }, p)).resolves.toEqual({
      ok: false,
      reason: 'off',
    });
    await expect(copyText('', { mode: 'osc52', maxBytes: 100 }, p)).resolves.toEqual({
      ok: false,
      reason: 'empty',
    });
    await expect(copyText('abcdef', { mode: 'osc52', maxBytes: 5 }, p)).resolves.toEqual({
      ok: false,
      reason: 'too_long',
    });
    expect(written).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('counts the limit in bytes, not in characters', async () => {
    const { ports: p } = ports(local);
    await expect(copyText('çç', { mode: 'osc52', maxBytes: 3 }, p)).resolves.toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('uses the tool of the system in system mode and writes no sequence', async () => {
    const { ports: p, written, ran } = ports(local);
    await expect(copyText('hello', { mode: 'system', maxBytes: 100 }, p)).resolves.toMatchObject({
      ok: true,
      via: 'system',
    });
    expect(ran).toEqual([{ command: 'wl-copy', args: [] }]);
    expect(written).toEqual([]);
  });

  it('says so when system mode has no tool or the tool fails', async () => {
    const none = ports({ platform: 'linux', env: {} });
    await expect(copyText('a', { mode: 'system', maxBytes: 100 }, none.ports)).resolves.toEqual({
      ok: false,
      reason: 'no_tool',
    });
    const broken = ports(local, false);
    await expect(copyText('a', { mode: 'system', maxBytes: 100 }, broken.ports)).resolves.toEqual({
      ok: false,
      reason: 'tool_failed',
    });
  });

  it('auto takes the tool here and the terminal when there is none, or over SSH', async () => {
    const here = ports(local);
    await expect(copyText('a', { mode: 'auto', maxBytes: 100 }, here.ports)).resolves.toMatchObject(
      { via: 'system' },
    );
    const broken = ports(local, false);
    await expect(
      copyText('a', { mode: 'auto', maxBytes: 100 }, broken.ports),
    ).resolves.toMatchObject({ via: 'osc52' });
    expect(broken.written).toEqual(['\x1b]52;c;YQ==\x07']);
    const remote = ports({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'w', SSH_TTY: '/dev/pts/1' },
    });
    await expect(
      copyText('a', { mode: 'auto', maxBytes: 100 }, remote.ports),
    ).resolves.toMatchObject({ via: 'osc52' });
    expect(remote.ran).toEqual([]);
  });
});

describe('the machine', () => {
  it('picks the tools of each system', () => {
    expect(systemTools({ platform: 'darwin', env: {} })).toEqual([{ command: 'pbcopy', args: [] }]);
    expect(systemTools({ platform: 'win32', env: {} })).toEqual([
      { command: 'clip.exe', args: [] },
    ]);
    expect(
      systemTools({ platform: 'linux', env: { DISPLAY: ':0' } }).map((tool) => tool.command),
    ).toEqual(['xclip', 'xsel']);
    expect(
      systemTools({ platform: 'linux', env: { WSL_DISTRO_NAME: 'x' } }).map((tool) => tool.command),
    ).toEqual(['clip.exe']);
  });

  it('knows an SSH session', () => {
    expect(isRemote({ platform: 'linux', env: { SSH_CONNECTION: '1 2 3 4' } })).toBe(true);
    expect(isRemote({ platform: 'linux', env: {} })).toBe(false);
  });
});
