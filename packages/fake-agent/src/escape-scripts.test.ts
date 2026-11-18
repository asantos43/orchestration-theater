// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { playEscape, type EscapeHost, type EscapeScript } from './escape-scripts.js';
import { parseScriptSpec, SCRIPT_NAMES, ScriptError } from './scripts.js';

const scriptOf = (steps: readonly unknown[]): EscapeScript => {
  const script = parseScriptSpec(JSON.stringify({ name: 'escape', steps }));
  if (script.name !== 'escape') throw new Error('not an escape script');
  return script;
};

describe('the escape script', () => {
  it('is one of the named scripts and parses its steps with their defaults', () => {
    expect(SCRIPT_NAMES).toContain('escape');
    const script = scriptOf([
      { kind: 'write', path: '../x' },
      { kind: 'switch_mode' },
      { kind: 'mcp', tool: 'restricted_shell', arguments: { argv: ['ls'] } },
    ]);
    expect(script.steps).toMatchObject([
      { kind: 'write', path: '../x', via: 'ask' },
      { kind: 'switch_mode', mode: 'bypassPermissions' },
      { kind: 'mcp', server: 'otheater', tool: 'restricted_shell' },
    ]);
  });

  it('rejects a step it does not know, a stray field and an empty script', () => {
    expect(() => scriptOf([{ kind: 'teleport' }])).toThrow(ScriptError);
    expect(() => scriptOf([{ kind: 'read', path: 'x', extra: 1 }])).toThrow(ScriptError);
    expect(() => scriptOf([])).toThrow(ScriptError);
  });
});

describe('playEscape', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'otheater-escape-unit-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function hostOf(answer: 'allowed' | 'rejected' | 'cancelled'): {
    host: EscapeHost;
    said: string[];
    asked: { kind: string; locations?: readonly string[] }[];
  } {
    const said: string[] = [];
    const asked: { kind: string; locations?: readonly string[] }[] = [];
    const host: EscapeHost = {
      cwd,
      signal: new AbortController().signal,
      say: (text) => {
        said.push(text);
        return Promise.resolve();
      },
      ask: (request) => {
        asked.push({
          kind: request.kind,
          ...(request.locations === undefined ? {} : { locations: request.locations }),
        });
        return Promise.resolve(answer);
      },
      callTool: () => Promise.resolve(undefined),
      tryConnect: () => Promise.resolve('failed ECONNREFUSED'),
    };
    return { host, said, asked };
  }

  it('asks with the path as given (the .. is left for the daemon) and writes only when allowed', async () => {
    const rejected = hostOf('rejected');
    await playEscape(rejected.host, scriptOf([{ kind: 'write', path: '../x', label: 'up' }]));
    expect(rejected.asked).toEqual([{ kind: 'edit', locations: [`${cwd}/../x`] }]);
    expect(rejected.said).toEqual(['escape up: asked rejected']);

    const allowed = hostOf('allowed');
    await playEscape(allowed.host, scriptOf([{ kind: 'write', path: 'in.txt', content: 'hi' }]));
    expect(allowed.said).toEqual(['escape 1 write: ok']);
    expect(await readFile(join(cwd, 'in.txt'), 'utf8')).toBe('hi');
  });

  it('does not stop at a step that fails: one outcome per step, in order', async () => {
    const { host, said } = hostOf('allowed');
    await playEscape(
      host,
      scriptOf([
        { kind: 'read', path: 'missing.txt', label: 'read' },
        { kind: 'symlink', link: 'l', target: '/elsewhere', label: 'link' },
        { kind: 'spawn', argv: ['/no/such/program'], label: 'spawn' },
        { kind: 'mcp', tool: 'restricted_shell', label: 'mcp' },
        { kind: 'connect', target: '127.0.0.1:1', label: 'connect' },
      ]),
    );
    expect(said).toEqual([
      'escape read: failed ENOENT',
      'escape link: ok',
      'escape spawn: failed ENOENT',
      'escape mcp: failed NO_SERVER',
      'escape connect: failed ECONNREFUSED',
    ]);
    expect(await readlink(join(cwd, 'l'))).toBe('/elsewhere');
  });

  it('never runs the command or the fetch of a request that was not allowed', async () => {
    const { host, said } = hostOf('rejected');
    await playEscape(
      host,
      scriptOf([
        { kind: 'native_shell', command: `touch ${cwd}/marker`, label: 'shell' },
        { kind: 'native_fetch', url: 'http://127.0.0.1:1/', label: 'fetch' },
        { kind: 'switch_mode', label: 'mode' },
      ]),
    );
    expect(said).toEqual([
      'escape shell: asked rejected',
      'escape fetch: asked rejected',
      'escape mode: asked rejected',
    ]);
    await expect(readFile(join(cwd, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
