// SPDX-License-Identifier: MPL-2.0
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeTempDataDir } from './test-helpers.js';

/**
 * Runs the compiled `dist/cli.js` as a real process: the shebang entry point, `process.argv`, the
 * exit code and the signals, which `main()` tests cannot reach. `pnpm test` does not build, so
 * without `dist` these are skipped (`pnpm check` builds first, so there they run).
 */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const built = existsSync(CLI);
const TIMEOUT_MS = 20_000;

/** No real HOME, no real keyring, no inherited OT_* variables. */
function cleanEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: home, LANG: 'en_US.UTF-8' };
}

/**
 * Config that never touches the real keyring (the file vault, cheapest scrypt) and never reaches the
 * npm registry: this process finds the real `claude` and `codex` in `PATH`, and with the managed
 * adapters on `auto` it would download them (P13).
 */
const SAFE_CONFIG =
  'ui:\n  locale: en\nadapters:\n  vault: encrypted-file\nvault:\n  scrypt: { N: 16384, r: 8, p: 1 }\nbackup:\n  when: manual\n  content: store_only\nclients:\n  adapters:\n    install: off\n';

function run(
  args: string[],
  home: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: cleanEnv(home), timeout: TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') reject(new Error(error.message));
        else resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
      },
    );
  });
}

describe.skipIf(!built)('the compiled ot (dist/cli.js)', () => {
  it('--help prints the usage and exits 0', async () => {
    const tmp = await makeTempDataDir();
    try {
      const result = await run(['--help', '--data-dir', tmp.dir], tmp.dir);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^Usage: ot /);
      expect(result.stderr).toBe('');
    } finally {
      await tmp.dispose();
    }
  });

  it('exits 2 on wrong usage', async () => {
    const tmp = await makeTempDataDir();
    try {
      const result = await run(['frobnicate', '--data-dir', tmp.dir], tmp.dir);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/Unknown command "frobnicate"/);
    } finally {
      await tmp.dispose();
    }
  });

  it('backup makes a copy in a temp data dir and exits 0', async () => {
    const tmp = await makeTempDataDir();
    try {
      await writeFile(join(tmp.dir, 'config.yaml'), SAFE_CONFIG);
      const result = await run(['backup', '--data-dir', tmp.dir], tmp.dir);
      expect(result.stderr).not.toMatch(/Error/);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^Backup saved in /);
      const folders = await readdir(join(tmp.dir, 'backups'));
      expect(folders).toHaveLength(1);
      expect((await readdir(join(tmp.dir, 'backups', folders[0] ?? ''))).sort()).toEqual([
        'manifest.json',
        'store.sqlite',
      ]);
    } finally {
      await tmp.dispose();
    }
  });

  // On Windows child.kill('SIGTERM') is TerminateProcess: the daemon gets no chance to stop
  // cleanly and the exit code is null. Graceful stop on Windows is an open decision (not built).
  it.skipIf(process.platform === 'win32')(
    'daemon runs until SIGTERM, then stops cleanly with exit 0',
    async () => {
      const tmp = await makeTempDataDir();
      try {
        await writeFile(join(tmp.dir, 'config.yaml'), SAFE_CONFIG);
        const child = spawn(process.execPath, [CLI, 'daemon', '--data-dir', tmp.dir], {
          env: cleanEnv(tmp.dir),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        const exit = new Promise<number | null>((resolve) => {
          child.once('close', (code) => {
            resolve(code);
          });
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
        try {
          await new Promise<void>((resolve, reject) => {
            child.stdout.on('data', (chunk: Buffer) => {
              stdout += chunk.toString();
              if (stdout.includes('daemon running')) resolve();
            });
            child.once('exit', () => {
              reject(new Error(`the daemon exited early: ${stdout}`));
            });
          });
          child.kill('SIGTERM');
          expect(await exit).toBe(0);
          expect(stdout).toMatch(/Stopping the daemon[\s\S]*Daemon stopped\./);
        } finally {
          clearTimeout(timer);
          child.kill('SIGKILL');
        }
      } finally {
        await tmp.dispose();
      }
    },
  );
});
