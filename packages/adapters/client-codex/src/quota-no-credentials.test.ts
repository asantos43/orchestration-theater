// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every file operation of this test file's module graph goes through the wrappers below, which
// record the path they were given while `armed`. The fake app-server is another process: it is out
// of reach of the wrappers, and it never opens a credential file either.
const touched = vi.hoisted(() => ({ armed: false, paths: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped: Record<string, unknown> = { ...original };
  for (const name of [
    'readFile',
    'writeFile',
    'open',
    'readdir',
    'stat',
    'lstat',
    'access',
    'copyFile',
    'cp',
    'rename',
    'rm',
    'unlink',
    'mkdir',
    'realpath',
  ] as const) {
    const real = original[name] as (...args: unknown[]) => unknown;
    wrapped[name] = (...args: unknown[]) => {
      if (touched.armed && typeof args[0] === 'string') touched.paths.push(args[0]);
      return real(...args);
    };
  }
  return { ...wrapped, default: wrapped };
});

const { CodexAdapter } = await import('./codex-adapter.js');
const { writeFakeAppServer } = await import('./testing/fake-app-server.js');
const { NodeProcessLauncher } = await import('./testing/node-process-launcher.js');

let root: string;
let launcher: InstanceType<typeof NodeProcessLauncher>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ot-codex-quota-nocred-'));
  launcher = new NodeProcessLauncher();
  touched.armed = false;
  touched.paths = [];
});

afterEach(async () => {
  touched.armed = false;
  await launcher.killAll();
  await rm(root, { recursive: true, force: true });
});

describe('the quota probe and the credentials of the profile', () => {
  it('opens no file of the profile but its own config.toml, whatever else the profile holds', async () => {
    const dir = join(root, 'profiles', 'work');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'auth.json'), '{"canary":"never-read"}');
    await writeFile(join(dir, 'client-state.bin'), 'state');
    const server = await writeFakeAppServer(join(root, 'bin'));
    const adapter = new CodexAdapter({
      launcher,
      baseEnv: { FAKE_APP_SCENARIO: 'ok' },
      adapterVersion: '2.6.0',
      sandbox: { fields: ['nativeTools', 'nativeShell', 'network'] },
      quota: { profileDir: () => dir, command: server },
    });

    touched.armed = true;
    const reading = await adapter.quota.read({ client: 'codex', profile: 'work' });
    touched.armed = false;

    expect(reading.windows).toHaveLength(2);
    expect(touched.paths.length).toBeGreaterThan(0);
    for (const path of touched.paths) {
      if (path === dir) continue; // the directory itself is created, never listed
      expect(dirname(path)).toBe(dir);
      expect(basename(path)).toMatch(/^config\.toml(\.[0-9a-f]+\.tmp)?$/u);
    }
    expect(await readFile(join(dir, 'auth.json'), 'utf8')).toBe('{"canary":"never-read"}');
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('has no file system import in the code that talks to the app-server', async () => {
    for (const file of ['quota-probe.ts', 'app-server-session.ts', 'rate-limits.ts']) {
      const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/from 'node:fs|from 'fs/u);
    }
  });
});
