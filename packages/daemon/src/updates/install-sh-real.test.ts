// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostPlatform, runInstaller, startReleaseServer } from './install-sh-fixture.js';
import { buildRelease, makeKeys } from './release-fixture.js';

/**
 * `installer/install.sh` with the real single executable (SEA, P1) and the real logon service
 * (Phase 10, P5). [proposta] It runs only on a CI runner (`CI=true`), with
 * `OT_TEST_REAL_SERVICE=1` and `OT_TEST_INSTALL_EXE=<path of the SEA>`, which is what
 * `.github/workflows/dist-install-sh.yml` sets: on a developer machine this file does nothing, so a
 * real service is never installed there.
 *
 * HOME: `systemd --user` reads the units of the HOME of the runner user, so on Linux the install
 * goes to the real HOME of the runner (an ephemeral machine; the test refuses to run if an install
 * is already there). On macOS it is a temporary HOME. The release server is on the loopback and the
 * files are signed by a key made here.
 *
 * Where the runner has no user service manager the test says so and still checks what does not need
 * it (the install with `OT_INSTALL_SERVICE=off`).
 */
const SEA = process.env.OT_TEST_INSTALL_EXE;
const ENABLED =
  process.env.OT_TEST_REAL_SERVICE === '1' &&
  process.env.CI === 'true' &&
  SEA !== undefined &&
  SEA !== '' &&
  hostPlatform() !== undefined;
const OPENSSL = process.env.OT_TEST_OPENSSL ?? 'openssl';

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

function run(command: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(command, args, {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!ENABLED)('install.sh with the real executable and service (CI only)', () => {
  it('installs, refuses a bad signature, and uninstalls', async () => {
    const platform = hostPlatform();
    if (platform === undefined || SEA === undefined) throw new Error('not enabled');
    const scratch = await mkdtemp(join(tmpdir(), 'otheater-install-real-'));
    const home = process.platform === 'linux' ? homedir() : join(scratch, 'home');
    const bin = join(home, '.local', 'bin', 'ot');
    const installed = join(home, '.local', 'share', 'otheater', 'bin', 'otheater');
    if (await exists(installed)) {
      throw new Error(`${installed} already exists: this test only runs on a clean runner`);
    }
    const keys = makeKeys();
    const keyFile = join(scratch, 'public-key.pem');
    await writeFile(keyFile, keys.publicPem);
    const exe = await readFile(SEA);
    const name = `otheater-${platform}`;
    const server = await startReleaseServer();
    const release = buildRelease(keys, { version: '1.0.0', platform, name, exe });
    server.files.set('manifest.json', release.manifestBytes);
    server.files.set('manifest.json.sig', release.signature);
    server.files.set(name, exe);
    const env: Record<string, string> = {
      HOME: home,
      OT_INSTALL_BASE_URL: server.base,
      OT_INSTALL_PUBLIC_KEY_FILE: keyFile,
      OT_INSTALL_OPENSSL: OPENSSL,
    };
    for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'USER']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    try {
      const first = await runInstaller(
        [],
        { ...env, OT_INSTALL_SERVICE: 'auto' },
        { timeoutMs: 170_000 },
      );
      // 4: installed, but this runner has no user service manager (it is said, not hidden).
      if (first.code === 4) console.warn(`no user service manager here: ${first.stderr}`);
      expect([0, 4], first.stderr).toContain(first.code);
      expect(await readFile(installed)).toEqual(exe);
      const version = run(bin, ['--version'], env);
      expect(version.code, version.stderr).toBe(0);
      expect(version.stdout.trim()).not.toBe('');
      if (first.code === 0) {
        const status = run(bin, ['service', 'status', '--json'], env);
        expect(status.code, status.stderr).toBe(0);
        const parsed = JSON.parse(status.stdout) as { service: { installed: boolean } };
        expect(parsed.service.installed).toBe(true);
      }

      // A bad signature: refused, and what was installed stays as it was.
      const other = makeKeys();
      const forged = buildRelease(other, { version: '1.0.1', platform, name, exe });
      server.files.set('manifest.json', forged.manifestBytes);
      server.files.set('manifest.json.sig', forged.signature);
      const bad = await runInstaller(
        [],
        { ...env, OT_INSTALL_SERVICE: 'auto' },
        { timeoutMs: 120_000 },
      );
      expect(bad.code, bad.stderr).toBe(3);
      expect(bad.stderr).toContain('REFUSED');
      expect(await readFile(installed)).toEqual(exe);
    } finally {
      const gone = await runInstaller(
        ['--uninstall'],
        { ...env, OT_INSTALL_SERVICE: 'auto' },
        { timeoutMs: 120_000 },
      );
      await server.close();
      try {
        expect([0, 4], gone.stderr).toContain(gone.code);
        expect(await exists(installed)).toBe(false);
        expect(await exists(bin)).toBe(false);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  }, 420_000);
});
