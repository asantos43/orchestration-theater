// SPDX-License-Identifier: MPL-2.0
import {
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import type { FindExecutable } from './clients.js';
import { parseConfig } from './config.js';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { captureLogger, makeTempDataDir } from './test-helpers.js';

const MANUAL = 'backup:\n  when: manual\n';
const NOTHING: FindExecutable = () => undefined;
const ONLY_CODEX: FindExecutable = (command) =>
  command === 'codex-acp' ? '/bin/codex-acp' : undefined;

async function start(
  config: string,
  find: FindExecutable,
): Promise<{
  daemon: DaemonHandle;
  lines: ReturnType<typeof captureLogger>['lines'];
  dispose: () => Promise<void>;
}> {
  const tmp = await makeTempDataDir();
  const { logger, lines } = captureLogger();
  const launcher = new FakeProcessLauncher();
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    config: parseConfig(config),
    overrides: {
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      launcher,
      transport: new FakeSessionTransport(),
    },
    clientSearch: { env: { PATH: '/usr/bin' }, findExecutable: find },
    logger,
    version: '0.0.0-test',
  });
  return {
    daemon,
    lines,
    dispose: async () => {
      await daemon.stop();
      await tmp.dispose();
    },
  };
}

describe('startDaemon with the default client factory', () => {
  it('keeps the execution off, with a warning, when no client is configured or found', async () => {
    const t = await start(MANUAL, NOTHING);
    try {
      expect(t.daemon.execution).toBeUndefined();
      const warning = t.lines.find(
        (l) => l.level === 'warn' && l.msg.includes('no client is enabled'),
      );
      expect(warning).toBeDefined();
      expect(t.lines.filter((l) => l.msg === 'client').map((l) => l.fields.reason)).toEqual([
        'not_found',
        'not_found',
        'not_found',
      ]);
    } finally {
      await t.dispose();
    }
  });

  it('keeps the execution off when every client is disabled by the config', async () => {
    const config = `${MANUAL}clients:\n  claude-code: { enabled: false }\n  codex: { enabled: false }\n  opencode: { enabled: false }\n`;
    const t = await start(config, () => '/bin/found');
    try {
      expect(t.daemon.execution).toBeUndefined();
      expect(
        t.lines.some((l) => l.level === 'warn' && l.msg.includes('no client is enabled')),
      ).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it('turns the execution on with the clients it finds, without starting any of them', async () => {
    const t = await start(MANUAL, ONLY_CODEX);
    try {
      expect(t.daemon.execution).toBeDefined();
      expect(t.lines.some((l) => l.msg.includes('no client is enabled'))).toBe(false);
    } finally {
      await t.dispose();
    }
  });
});
