// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execRunner } from './command-runner.js';
import { createServiceManager } from './index.js';
import { ServiceError, type ServiceManager, type ServiceSpec } from './types.js';

/**
 * The real service managers: `systemctl --user`, `launchctl` and `schtasks` (Phase 10, P3). [proposta]
 * They run only with `OT_TEST_REAL_SERVICE=1` and on a CI runner (`CI=true`), which is what
 * `.github/workflows/dist-service.yml` sets: a test of this file never installs anything on a
 * developer machine. Each run uses a test id of its own (never `com.otheater.daemon` nor
 * `otheater-daemon`) and a command that does nothing (Node waiting), and removes what it made.
 *
 * Where the runner cannot do it (no graphical session on macOS, no `systemd --user` on a minimal
 * Linux) the test says so and ends without failing.
 *
 * HOME: macOS and Windows use a temporary one (launchd loads a plist from any path; the Task
 * Scheduler has no home). `systemd --user` reads the units from the config folder of the user it
 * runs as, so on Linux the unit goes to the runner's own `~/.config/systemd/user`, under the test id
 * and removed in the `finally`: a temporary HOME could not be seen by the user manager.
 */
const ENABLED = process.env.OT_TEST_REAL_SERVICE === '1' && process.env.CI === 'true';

const idFor = (platform: NodeJS.Platform): string => {
  const suffix = randomBytes(4).toString('hex');
  return platform === 'darwin' ? `com.otheater.test.${suffix}` : `otheater-test-${suffix}`;
};

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe.skipIf(!ENABLED)(
  'the real service manager of this runner (OT_TEST_REAL_SERVICE=1)',
  () => {
    it('installs, reports, starts, stops and uninstalls a test service, and leaves the data alone', async (ctx) => {
      const platform = process.platform;
      const scratch = await mkdtemp(join(tmpdir(), 'otheater-real-service-'));
      const id = idFor(platform);
      const manager: ServiceManager | undefined = createServiceManager({
        platform,
        env: process.env,
        homedir: platform === 'linux' ? homedir() : join(scratch, 'home'),
        uid: process.getuid?.(),
        run: execRunner,
        tmpDir: scratch,
        id,
      });
      if (manager === undefined) {
        ctx.skip(`no service manager for ${platform}`);
        return;
      }
      const spec: ServiceSpec = {
        id,
        command: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1e9)'] },
        dataDir: join(scratch, 'data'),
        restart: 'on_failure',
        autostart: 'logon',
        console: 'hidden',
        userId:
          platform === 'win32' && process.env.USERNAME !== undefined
            ? `${process.env.USERDOMAIN ?? '.'}\\${process.env.USERNAME}`
            : undefined,
        path: platform === 'win32' ? undefined : process.env.PATH,
      };
      try {
        try {
          await manager.install(spec);
        } catch (error) {
          if (error instanceof ServiceError && error.code === 'unavailable') {
            console.warn(
              `the ${manager.kind} manager is unavailable on this runner: ${error.detail}`,
            );
            ctx.skip(`the ${manager.kind} manager is unavailable on this runner`);
            return;
          }
          throw error;
        }
        const installed = await manager.status();
        expect(installed.installed).toBe(true);
        // N323 (5): on Windows "starts at logon" comes from the XML that the real schtasks prints.
        if (manager.kind === 'task') expect(installed.enabled).toBe(true);
        if (installed.note === 'no_session') {
          console.warn('no user session on this runner: the install is checked, the start is not');
        } else {
          await manager.start();
          // Windows does not read the task state (it is localized): the start is only the call.
          if (manager.kind !== 'task') {
            let active = false;
            for (let attempt = 0; attempt < 50 && !active; attempt += 1) {
              active = (await manager.status()).active === true;
              if (!active) await delay(200);
            }
            expect(active).toBe(true);
          }
          await manager.stop();
        }
      } finally {
        await manager.uninstall().catch((error: unknown) => {
          console.warn(`cleanup of ${id} failed: ${String(error)}`);
        });
        const after = await manager.status().catch(() => undefined);
        await rm(scratch, { recursive: true, force: true });
        expect(after?.installed ?? false).toBe(false);
      }
    }, 60_000);
  },
);
