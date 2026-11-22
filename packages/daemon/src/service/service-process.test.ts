// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readDiscovery } from '../api/files.js';
import { dataPaths } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';
import { ensureDaemon, spawnDetachedDaemon } from './ensure-daemon.js';

/**
 * The detached child of `tui.start_daemon: child` with the compiled `dist/cli.js`: the real spawn,
 * the real daemon, an empty PATH (no client), the file vault and a temp HOME. Skipped without
 * `dist` (as `cli-process.test.ts`) and on Windows, where a stop by signal is not clean.
 */
const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const runnable = existsSync(CLI) && process.platform !== 'win32';

const SAFE_CONFIG =
  'ui:\n  locale: en\nadapters:\n  vault: encrypted-file\nvault:\n  scrypt: { N: 16384, r: 8, p: 1 }\nbackup:\n  when: manual\n  content: store_only\n';

describe.skipIf(!runnable)('the detached daemon child (dist/cli.js)', () => {
  it('ensureDaemon starts it, finds it by api.json, and it stops cleanly on SIGTERM', async () => {
    const tmp = await makeTempDataDir();
    let pid: number | undefined;
    try {
      await writeFile(join(tmp.dir, 'config.yaml'), SAFE_CONFIG);
      const discoveryFile = dataPaths(tmp.dir).apiDiscovery;
      const outcome = await ensureDaemon({
        dataDir: tmp.dir,
        discoveryFile,
        mode: 'child',
        timeoutMs: 20_000,
        daemonCommand: {
          command: process.execPath,
          args: [CLI, 'daemon', '--data-dir', tmp.dir],
        },
        service: undefined,
        spawnDaemon: spawnDetachedDaemon,
        env: { PATH: '', HOME: tmp.dir, LANG: 'en_US.UTF-8' },
      });
      expect(outcome).toEqual({ kind: 'started', via: 'child' });
      const reading = await readDiscovery(discoveryFile);
      expect(reading.kind).toBe('live');
      if (reading.kind === 'live') pid = reading.info.pid;
      // A second call finds it and starts nothing.
      expect(
        await ensureDaemon({
          dataDir: tmp.dir,
          discoveryFile,
          mode: 'child',
          timeoutMs: 1000,
          daemonCommand: undefined,
          service: undefined,
          spawnDaemon: spawnDetachedDaemon,
          env: {},
        }),
      ).toEqual({ kind: 'running' });
    } finally {
      if (pid !== undefined) {
        process.kill(pid, 'SIGTERM');
        // The daemon removes api.json on its way out.
        for (let i = 0; i < 100; i += 1) {
          if ((await readDiscovery(dataPaths(tmp.dir).apiDiscovery)).kind !== 'live') break;
          await new Promise((done) => setTimeout(done, 100));
        }
      }
      await tmp.dispose();
    }
  }, 40_000);

  it('spawnDetachedDaemon reports a command that does not exist, without throwing', async () => {
    const result = await spawnDetachedDaemon(
      { command: '/nonexistent/otheater-test-binary', args: [] },
      {},
    );
    expect(result.ok).toBe(false);
  });
});
