// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../cli.js';
import { parseConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir, NO_CLIENTS } from '../test-helpers.js';
import { isolatedEnv, manifestText, writePluginFolder } from './plugin-fixture.js';
import { writeFile } from 'node:fs/promises';

describe('a running daemon and `ot plugin` (N235 (a))', () => {
  it('swaps the snapshot when a plugin is turned on or its manifest changes; an open snapshot stays', async () => {
    const data = await makeTempDataDir();
    const work = await makeTempDataDir();
    try {
      const clock = new FakeClock(Date.UTC(2026, 10, 21, 15));
      const daemon = await startDaemon({
        dataDir: data.dir,
        clientSearch: NO_CLIENTS,
        config: parseConfig('backup:\n  when: manual\n'),
        overrides: {
          clock,
          store: new InMemoryStore({ clock }),
          vault: new InMemorySecretVault(),
        },
        logger: createSilentLogger(),
      });
      const ot = async (...argv: string[]): Promise<number> =>
        await main([...argv, '--data-dir', data.dir], {
          env: isolatedEnv(work.dir),
          platform: 'linux',
          homedir: work.dir,
          cwd: work.dir,
          out: () => undefined,
          err: () => undefined,
          systemLocale: 'en',
          version: '1.2.3',
          overrides: { clock },
        });
      try {
        const folder = await writePluginFolder(join(work.dir, 'demo-db'));
        const session = daemon.registryHolder.current(); // a session that is already open
        expect(session.plugins.size).toBe(0);

        expect(await ot('plugin', 'install', folder)).toBe(0);
        // Installing turns nothing on: no swap that matters yet.
        expect(await ot('plugin', 'enable', 'demo-db', '--project', 'p1', '--yes')).toBe(0);
        await vi.waitFor(() => {
          expect(daemon.registryHolder.current().plugins.get('p1')?.[0]?.id).toBe('demo-db');
        });
        const withPlugin = daemon.registryHolder.current();
        expect(withPlugin.generation).toBeGreaterThan(session.generation);
        // The open session keeps the snapshot it read.
        expect(session.plugins.size).toBe(0);
        expect(daemon.plugins.activeFor('p1')[0]?.dir).toBe(folder);

        // The manifest of the local folder is edited: the plugin goes off for the new snapshot.
        await writeFile(join(folder, 'plugin.yaml'), manifestText({ variant: 'changed' }));
        await daemon.plugins.refresh();
        expect(daemon.registryHolder.current().plugins.size).toBe(0);
        expect(withPlugin.plugins.get('p1')).toHaveLength(1);
      } finally {
        await daemon.stop();
      }
    } finally {
      await data.dispose();
      await work.dispose();
    }
  });
});
