// SPDX-License-Identifier: MPL-2.0
import type { ClientAdapter, Clock, ProcessLauncher, SessionTransport } from '@otheater/core';
import { productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths } from '../paths.js';
import type { LedgerProbe } from './provider-probe.js';

/** The fakes the adapters are built over (a `*.test.ts` file makes them: only tests import them). */
export interface ClientFakes {
  readonly launcher: ProcessLauncher;
  readonly transport: SessionTransport;
}

/**
 * For the tests of the quota folder: the REAL adapters the daemon builds for `config`, with no
 * process launched and no executable looked for (the daemon imports adapters only in `compose.ts`,
 * so a test gets them through `productionClients`, as the daemon does).
 */
export function builtClients(
  yaml: string,
  clock: Clock,
  fakes: ClientFakes,
): readonly ClientAdapter[] {
  return productionClients(parseConfig(`security:\n  unenforced: allow\n${yaml}`), {
    env: { PATH: '/usr/bin', HOME: '/home/u' },
    findExecutable: (command) => `/bin/${command}`,
  })({
    launcher: fakes.launcher,
    clock,
    transport: fakes.transport,
    paths: dataPaths('/nonexistent/otheater-test'),
    logger: createSilentLogger(),
  });
}

export function clientOf(clients: readonly ClientAdapter[], id: string): ClientAdapter {
  const found = clients.find((client) => client.id === id);
  if (found === undefined) throw new Error(`no ${id} adapter was built`);
  return found;
}

/** The ledger of the OpenCode adapter the daemon builds for `quota.opencode` (the real one). */
export function realLedger(
  clock: Clock,
  limits: { limitTokens: number | null; limitUsd?: number | null; window?: string },
  fakes: ClientFakes,
): LedgerProbe {
  const yaml =
    'quota:\n  opencode:\n    mode: ledger\n' +
    `    window: ${limits.window ?? '5h'}\n` +
    `    limit_tokens: ${limits.limitTokens === null ? 'null' : String(limits.limitTokens)}\n` +
    `    limit_usd: ${limits.limitUsd == null ? 'null' : String(limits.limitUsd)}\n`;
  return clientOf(builtClients(yaml, clock, fakes), 'opencode').quota as LedgerProbe;
}
