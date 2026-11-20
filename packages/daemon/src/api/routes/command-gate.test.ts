// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import type { DaemonId } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../../logger.js';
import { RecoveryGate } from '../../recovery/gate.js';
import { makeTempDataDir, RecordingSituations } from '../../test-helpers.js';
import type { DirectiveService } from '../../directives/index.js';
import type { ProfileService } from '../../profiles/service.js';
import { generateApiToken } from '../files.js';
import { ApiServer } from '../server.js';
import { registerCommandRoutes } from './index.js';

/**
 * A command waits for the reconciliation of the start-up (5.21), a read does not: the commands of
 * P6 are registered as commands (every method but GET), so the server holds them at `gate`. The
 * services are stubs that count the calls: what matters is WHEN the command reaches them.
 */

const DAEMON_ID = '3f2b8a52-6a9a-4a0e-9c7e-7d3e0f6a1b11' as DaemonId;

let dir: string;
let dispose: () => Promise<void>;
let server: ApiServer;
let token: string;

beforeEach(async () => {
  const tmp = await makeTempDataDir();
  dir = tmp.dir;
  dispose = tmp.dispose;
  token = generateApiToken();
});

afterEach(async () => {
  await server.stop();
  await dispose();
});

describe('the commands and the recovery gate', () => {
  it('holds a command until the gate opens, then runs it once', async () => {
    const gate = new RecoveryGate();
    server = await ApiServer.start({
      port: 'auto',
      token,
      tokenMode: 'persistent',
      tokenFile: join(dir, 'api-token'),
      discoveryFile: join(dir, 'api.json'),
      daemonId: DAEMON_ID,
      maxBodyBytes: 1024,
      rejectionWindowMs: 10_000,
      now: () => 1_000_000,
      logger: createSilentLogger(),
      situations: new RecordingSituations(),
      gate,
    });
    let calls = 0;
    const directives = {
      revoke: (id: string, reason: string) => {
        calls += 1;
        return Promise.resolve({
          id,
          seq: 1,
          scope: 'global',
          scenarioId: null,
          kind: 'instruction',
          text: 'x',
          ruleKey: null,
          ruleValue: null,
          suspendsId: null,
          roles: [],
          startsAt: 0,
          endsAt: null,
          timezone: 'UTC',
          state: 'revoked',
          origin: 'tui',
          replacesId: null,
          createdAt: 0,
          updatedAt: 0,
          revokedAt: 0,
          revokeReason: reason,
        });
      },
    } as unknown as DirectiveService;
    const clock = new FakeClock();
    registerCommandRoutes(server.handlers, {
      store: new InMemoryStore({ clock }),
      clock,
      logger: createSilentLogger(),
      directives,
      profiles: {} as ProfileService,
      configPath: join(dir, 'config.yaml'),
      idempotencyTtlMs: () => 0,
    });

    let answered = false;
    const command = fetch(`${server.url}/v1/orders/O1/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'later' }),
    }).then((response) => {
      answered = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(answered).toBe(false);
    expect(calls).toBe(0);

    gate.open();
    const response = await command;
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });
});
