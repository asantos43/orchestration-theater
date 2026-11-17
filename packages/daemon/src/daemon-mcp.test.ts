// SPDX-License-Identifier: MPL-2.0
import { createServer, type Server } from 'node:net';
import { AdapterUnavailable } from '@otheater/core';
import { FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig, type DaemonConfig } from './config.js';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { makeTempDataDir, NO_CLIENTS } from './test-helpers.js';

/** The framework MCP server starts and stops with the daemon (architecture 5.3, N81). */

const AUTO = parseConfig('backup:\n  when: manual\n');

function start(dataDir: string, config: DaemonConfig = AUTO): Promise<DaemonHandle> {
  return startDaemon({
    dataDir,
    clientSearch: NO_CLIENTS,
    config,
    overrides: { clock: new FakeClock(), vault: new InMemorySecretVault() },
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

/** A port nobody listens on right now (it may be taken again before the test uses it, rarely). */
async function freePort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) =>
    probe.close(() => {
      resolve();
    }),
  );
  return port;
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'POST', body: '{}' });
    return true;
  } catch {
    return false;
  }
}

describe('startDaemon, the framework MCP server', () => {
  it('listens on a free loopback port with mcp.port auto, different at each start, and stops with the daemon', async () => {
    const first = await makeTempDataDir();
    const second = await makeTempDataDir();
    try {
      const a = await start(first.dir);
      const b = await start(second.dir);
      expect(a.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(b.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(portOf(a.mcpUrl)).not.toBe(portOf(b.mcpUrl));
      expect(await answers(a.mcpUrl)).toBe(true);

      await a.stop();
      expect(await answers(a.mcpUrl)).toBe(false);
      expect(await answers(b.mcpUrl)).toBe(true);
      await b.stop();
      expect(await answers(b.mcpUrl)).toBe(false);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('takes the fixed port of mcp.port, and a taken one stops the start-up and frees the lock', async () => {
    const first = await makeTempDataDir();
    const second = await makeTempDataDir();
    try {
      const port = await freePort();
      const fixed = parseConfig(`backup:\n  when: manual\nmcp:\n  port: ${String(port)}\n`);
      const a = await start(first.dir, fixed);
      expect(portOf(a.mcpUrl)).toBe(port);

      await expect(start(second.dir, fixed)).rejects.toThrow(AdapterUnavailable);
      // The failed start left nothing behind: the same data dir starts once the port is free.
      await a.stop();
      const again = await start(second.dir, fixed);
      expect(portOf(again.mcpUrl)).toBe(port);
      await again.stop();
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
