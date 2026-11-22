// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  isSeaMode,
  resolveAdapterCommand,
  resolveSelfCommand,
  seaModeArgument,
  SEA_MODES,
} from './self-command.js';

const identity = (path: string): string => path;

describe('the internal modes', () => {
  it('knows the five faces and nothing else', () => {
    expect([...SEA_MODES]).toEqual([
      'tui',
      'mcp-shim',
      'verify-release',
      'apply-update',
      'run-adapter',
    ]);
    expect(isSeaMode('tui')).toBe(true);
    expect(isSeaMode('cli')).toBe(false);
    expect(seaModeArgument('mcp-shim')).toBe('--ot-internal=mcp-shim');
  });
});

describe('resolveSelfCommand in the single executable', () => {
  const sea = { sea: true, execPath: '/opt/ot/otheater' } as const;

  it('is the executable alone for the CLI', () => {
    expect(resolveSelfCommand(undefined, sea)).toEqual({ command: '/opt/ot/otheater', args: [] });
  });

  it('is the executable plus the mode argument for a mode', () => {
    expect(resolveSelfCommand('mcp-shim', sea)).toEqual({
      command: '/opt/ot/otheater',
      args: ['--ot-internal=mcp-shim'],
    });
    expect(resolveSelfCommand('tui', sea)?.args).toEqual(['--ot-internal=tui']);
  });
});

describe('resolveSelfCommand in a checkout', () => {
  const base = { sea: false, execPath: '/usr/bin/node', realpath: identity } as const;

  it('is the Node plus the script that is running for the CLI', () => {
    expect(resolveSelfCommand(undefined, { ...base, invoked: '/repo/dist/cli.js' })).toEqual({
      command: '/usr/bin/node',
      args: ['/repo/dist/cli.js'],
    });
  });

  it('follows a link to the real script', () => {
    const result = resolveSelfCommand(undefined, {
      ...base,
      invoked: '/bin/ot',
      realpath: () => '/repo/dist/cli.js',
    });
    expect(result?.args).toEqual(['/repo/dist/cli.js']);
  });

  it('has nothing when no script is known or it cannot be resolved', () => {
    expect(resolveSelfCommand(undefined, { ...base, invoked: undefined })).toBeUndefined();
    expect(
      resolveSelfCommand(undefined, {
        ...base,
        invoked: '/gone.js',
        realpath: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeUndefined();
  });

  it('is the Node plus the shim script for mcp-shim', () => {
    expect(
      resolveSelfCommand('mcp-shim', { ...base, shimScript: '/repo/dist/mcp/stdio-shim.js' }),
    ).toEqual({
      command: '/usr/bin/node',
      args: ['/repo/dist/mcp/stdio-shim.js'],
    });
    expect(resolveSelfCommand('mcp-shim', base)?.args[0]).toMatch(/stdio-shim\.js$/);
  });

  it('has nothing for the modes that exist only in the executable', () => {
    for (const mode of ['tui', 'verify-release', 'apply-update'] as const) {
      expect(resolveSelfCommand(mode, base)).toBeUndefined();
    }
  });
});

describe('resolveAdapterCommand', () => {
  it('is the executable in run-adapter mode inside the single executable', () => {
    expect(
      resolveAdapterCommand('/d/adapters/a/index.js', { sea: true, execPath: '/opt/ot/otheater' }),
    ).toEqual({
      command: '/opt/ot/otheater',
      args: ['--ot-internal=run-adapter', '/d/adapters/a/index.js'],
    });
  });

  it('is the Node that runs this plus the script in a checkout', () => {
    expect(
      resolveAdapterCommand('/d/adapters/a/index.js', { sea: false, execPath: '/usr/bin/node' }),
    ).toEqual({ command: '/usr/bin/node', args: ['/d/adapters/a/index.js'] });
  });
});
