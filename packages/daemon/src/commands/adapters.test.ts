// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtureAdapter,
  startFakeRegistry,
  type FakeRegistry,
} from '../adapters/adapter-fixture.js';
import { main, type CliDeps } from '../cli.js';
import type { FindExecutable } from '../clients.js';
import { dataPaths } from '../paths.js';

/**
 * `ot adapters status|install` (Phase 10, P13). The registry is a fake one on 127.0.0.1, the data
 * folder and HOME are temporary and `find` is injected: the real npm registry and the real `PATH`
 * are never reached.
 */

const LINUX = { os: 'linux', cpu: 'x64', libc: 'glibc' } as const;

let root: string;
let data: string;
let registry: FakeRegistry;
const fixture = fixtureAdapter();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'otheater-adapters-'));
  data = join(root, 'data');
  registry = await startFakeRegistry(fixture);
});
afterEach(async () => {
  await registry.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const seams = (): CliDeps['adapters'] => ({
  lockOf: (id) => ({ ...fixture.lock, id }),
  platform: LINUX,
  self: { sea: false, execPath: '/n/node' },
  installOptions: { retryDelayMs: 0, retries: 0 },
});
const clientsInPath =
  (...names: string[]): FindExecutable =>
  (command) =>
    names.includes(command) ? `/fake/bin/${command}` : undefined;

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}
async function ot(
  argv: readonly string[],
  find: FindExecutable = clientsInPath(),
  locale = 'en',
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, '--data-dir', data], {
    env: { PATH: '/nowhere' },
    platform: 'linux',
    homedir: join(root, 'home'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    systemLocale: locale,
    version: '0.0.0-test',
    serviceHost: {
      manager: undefined,
      spawnDaemon: () => Promise.reject(new Error('no daemon here')),
      find,
    },
    adapters: seams(),
  });
  return { code, out, err };
}
const configure = async (extra: string): Promise<void> => {
  await mkdir(data, { recursive: true });
  await writeFile(
    dataPaths(data).config,
    `clients:\n  adapters:\n    registry: ${registry.url}\n${extra}`,
  );
};
const entryOf = (id: string): string =>
  join(dataPaths(data).adapters, id, '1.2.3', 'node_modules', 'fake-acp', 'dist', 'index.js');

describe('ot adapters', () => {
  it('status says what is pinned, what is installed and what is in PATH', async () => {
    await configure('');
    const result = await ot(['adapters', 'status'], clientsInPath('claude'));
    const text = result.out.join('\n');
    expect(result.code).toBe(0);
    expect(text).toContain('clients.adapters.install is auto');
    expect(text).toContain('claude-code: claude-agent-acp');
    expect(text).toContain('codex: codex-acp');
    expect(text).toContain('/fake/bin/claude');
    expect(text).toContain('not installed by OTheater');
    expect(registry.requests).toEqual([]);
  });

  it('status --json is one JSON document', async () => {
    await configure('');
    const result = await ot(['adapters', 'status', '--json'], clientsInPath('claude'));
    const parsed = JSON.parse(result.out.join('\n')) as {
      install: string;
      registry: string;
      clients: { client: string; installed: boolean; officialPath?: string }[];
    };
    expect(result.code).toBe(0);
    expect(parsed.install).toBe('auto');
    expect(parsed.registry).toBe(registry.url);
    expect(parsed.clients.map((c) => c.client)).toEqual(['claude-code', 'codex']);
    expect(parsed.clients.every((c) => !c.installed)).toBe(true);
    expect(parsed.clients[0]?.officialPath).toBe('/fake/bin/claude');
  });

  it('install with no client installs both; a second run installs nothing', async () => {
    await configure('');
    const first = await ot(['adapters', 'install']);
    expect(first.code).toBe(0);
    expect(first.err).toEqual([]);
    const text = first.out.join('\n');
    expect(text).toContain('Installed claude-agent-acp');
    expect(text).toContain('Installed codex-acp');
    // The client the adapter drives is never installed: the user is told.
    expect(text).toContain('is not in PATH');
    expect(existsSync(entryOf('claude-agent-acp'))).toBe(true);
    expect(existsSync(entryOf('codex-acp'))).toBe(true);
    const requests = registry.requests.length;
    const second = await ot(['adapters', 'install']);
    expect(second.code).toBe(0);
    expect(second.out.join('\n')).toContain('is already installed');
    expect(registry.requests.length).toBe(requests);
  });

  it('install of one client installs only that one', async () => {
    await configure('');
    const result = await ot(['adapters', 'install', 'codex']);
    expect(result.code).toBe(0);
    expect(existsSync(entryOf('codex-acp'))).toBe(true);
    expect(existsSync(entryOf('claude-agent-acp'))).toBe(false);
  });

  it('install refuses when clients.adapters.install is off (exit 1, nothing downloaded)', async () => {
    await configure('    install: off\n');
    const result = await ot(['adapters', 'install']);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('clients.adapters.install is off');
    expect(registry.requests).toEqual([]);
  });

  it('install in the command mode works: that mode is for this command', async () => {
    await configure('    install: command\n');
    const result = await ot(['adapters', 'install', 'claude-code']);
    expect(result.code).toBe(0);
    expect(existsSync(entryOf('claude-agent-acp'))).toBe(true);
  });

  it('a failed install is exit 1 and names the adapter', async () => {
    await configure('');
    registry.failNext(404, 50);
    const result = await ot(['adapters', 'install', 'claude-code']);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('Could not install claude-agent-acp');
    expect(existsSync(entryOf('claude-agent-acp'))).toBe(false);
  });

  it('is a usage error (exit 2) without an action, with an unknown action or client, or extra arguments', async () => {
    expect((await ot(['adapters'])).code).toBe(2);
    expect((await ot(['adapters', 'remove'])).code).toBe(2);
    expect((await ot(['adapters', 'install', 'opencode'])).code).toBe(2);
    expect((await ot(['adapters', 'status', 'codex'])).code).toBe(2);
    expect(registry.requests).toEqual([]);
  });

  it('prints in Portuguese when the system locale is pt-BR', async () => {
    await configure('');
    const result = await ot(['adapters', 'status'], clientsInPath(), 'pt-BR');
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toMatch(/clients\.adapters\.install é auto/);
  });
});
