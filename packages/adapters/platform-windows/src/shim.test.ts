// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { resolveNpmShim } from './shim.js';

const SHIM = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex-acp.cmd';
const SCRIPT =
  'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@zed-industries\\codex-acp\\bin\\codex-acp.js';
const REL = 'node_modules\\@zed-industries\\codex-acp\\bin\\codex-acp.js';

/** npm 7 to 11 (`cmd-shim` 4 to 8): the `_prog` form. */
const modern = (rel: string, tail = '%*'): string =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" ${tail}`,
    '',
  ].join('\r\n');

/** npm 6 and earlier (`cmd-shim` 2): the interpreter and the script spelled out. */
const legacy = (rel: string): string =>
  [
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${rel}" %*`,
    ') ELSE (',
    '  @SETLOCAL',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${rel}" %*`,
    ')',
    '',
  ].join('\r\n');

const present = (...paths: string[]) => {
  const set = new Set(paths.map((path) => path.toLowerCase()));
  return (path: string): boolean => set.has(path.toLowerCase());
};

const NODE_IN_PATH = 'C:\\Program Files\\nodejs\\node.exe';
const env = { Path: 'C:\\Windows;"C:\\Program Files\\nodejs"' };

describe('resolveNpmShim', () => {
  it('reads the format of npm 7 to 11 and finds node.exe in PATH', () => {
    expect(
      resolveNpmShim(SHIM, {
        env,
        readFile: () => modern(REL),
        isFile: present(SCRIPT, NODE_IN_PATH),
      }),
    ).toEqual({ exe: NODE_IN_PATH, args: [SCRIPT] });
  });

  it('reads the format of npm 6 and earlier, with node.exe beside the shim first', () => {
    const beside = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node.exe';
    expect(
      resolveNpmShim(SHIM, {
        env,
        readFile: () => legacy(REL),
        isFile: present(SCRIPT, beside, NODE_IN_PATH),
      }),
    ).toEqual({ exe: beside, args: [SCRIPT] });
  });

  it('accepts the unix-style slashes of a shim written by a tool other than npm', () => {
    expect(
      resolveNpmShim(SHIM, {
        env,
        readFile: () => modern('node_modules/@zed-industries/codex-acp/bin/codex-acp.js'),
        isFile: present(SCRIPT, NODE_IN_PATH),
      }),
    ).toEqual({ exe: NODE_IN_PATH, args: [SCRIPT] });
  });

  it('never falls back to the node of this process', () => {
    expect(() =>
      resolveNpmShim(SHIM, { env, readFile: () => modern(REL), isFile: present(SCRIPT) }),
    ).toThrow(/no node\.exe/);
  });

  it('refuses a missing script, naming the shim', () => {
    expect(() =>
      resolveNpmShim(SHIM, { env, readFile: () => modern(REL), isFile: present(NODE_IN_PATH) }),
    ).toThrow(/codex-acp\.cmd.*is not there/s);
  });

  it('refuses a shim whose interpreter is not node', () => {
    const text = modern(REL).replace('SET "_prog=node"', 'SET "_prog=python"');
    expect(() =>
      resolveNpmShim(SHIM, { env, readFile: () => text, isFile: present(SCRIPT, NODE_IN_PATH) }),
    ).toThrow(/interpreter is not node/);
  });

  it('refuses arguments baked into the shim and variables in the script path', () => {
    const isFile = present(SCRIPT, NODE_IN_PATH);
    expect(() =>
      resolveNpmShim(SHIM, { env, readFile: () => modern(REL, '--flag %*'), isFile }),
    ).toThrow(/arguments of its own/);
    expect(() =>
      resolveNpmShim(SHIM, { env, readFile: () => modern('%APPDATA%\\x.js'), isFile }),
    ).toThrow(/variable/);
  });

  it('refuses a .cmd that is not a shim, and a file that cannot be read', () => {
    const isFile = present(SCRIPT, NODE_IN_PATH);
    expect(() =>
      resolveNpmShim(SHIM, { env, readFile: () => '@echo off\r\ncodex.exe %*', isFile }),
    ).toThrow(/codex-acp\.cmd.*not an npm shim/s);
    expect(() =>
      resolveNpmShim(SHIM, {
        env,
        readFile: () => {
          throw new Error('EACCES');
        },
        isFile,
      }),
    ).toThrow(expect.objectContaining({ code: 'ADAPTER_UNAVAILABLE' }) as Error);
  });
});
