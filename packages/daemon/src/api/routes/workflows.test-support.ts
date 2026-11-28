// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any -- the answers of the API are read as loose JSON */
import { join } from 'node:path';
import { FakeClock, FakeCodeHost, FakeIssueTracker, InMemoryStore } from '@otheater/core/testing';
import type { DaemonId } from '@otheater/protocol';
import { parseConfig } from '../../config.js';
import { createSilentLogger } from '../../logger.js';
import type { PluginAggregator } from '../../plugins/aggregate.js';
import { RecoveryGate } from '../../recovery/gate.js';
import { makeTempDataDir, RecordingSituations } from '../../test-helpers.js';
import { composeWorkflows, type ComposedWorkflows } from '../../workflows/compose.js';
import { tempFolder } from '../../workflows/packages/packages.test-support.js';
import { FakeAsk } from '../../workflows/runtime.test-support.js';
import { FakePlugins } from '../../workflows/triggers/triggers.test-support.js';
import { ApiServer } from '../server.js';
import { commandRegistrar } from './command.js';
import type { CommandRouteDeps, ReadRouteDeps } from './deps.js';
import { IdempotencyCache } from './idempotency.js';
import { registerWorkflowCommands, registerWorkflowRoutes } from './workflows.js';

/**
 * The rig of the tests of the routes and of `ot flow` (Phase 11b, P10b): the real HTTP server and
 * the real composition of the engine (`composeWorkflows`), with the fakes of the code host. Call
 * {@link closeRigs} in an `afterEach`.
 */

export const DAEMON_ID = '3f2b8a52-6a9a-4a0e-9c7e-7d3e0f6a1b11' as DaemonId;

const cleanups: (() => Promise<void>)[] = [];

/** Stops every rig made since the last call. */
export async function closeRigs(): Promise<void> {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
}

export interface Rig {
  readonly server: ApiServer;
  readonly store: InMemoryStore;
  readonly composed: ComposedWorkflows;
  readonly token: string;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>;
}

export interface RigOptions {
  /** The body of `workflows:` of the configuration. */
  readonly yaml?: string;
  /** Registers the routes with no services (a daemon that composes no engine). */
  readonly bare?: boolean;
}

export async function makeRig(options: RigOptions = {}): Promise<Rig> {
  const tmp = await makeTempDataDir();
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const config = parseConfig(
    options.yaml === undefined ? 'workflows: {}\n' : `workflows:\n${options.yaml}`,
  );
  const composed = composeWorkflows({
    config: () => config.workflows,
    store,
    clock,
    logger: createSilentLogger(),
    dataDir: await tempFolder('otroutes-'),
    aggregator: {} as PluginAggregator,
    plugins: new FakePlugins(),
    ask: new FakeAsk().ask,
    codeHost: new FakeCodeHost({ clock }),
    issueTracker: new FakeIssueTracker({ clock }),
    packageEnv: { env: { PATH: process.env.PATH }, cwd: await tempFolder('otroutes-cwd-') },
  });
  const gate = new RecoveryGate();
  gate.open();
  const token = 'a'.repeat(43);
  const server = await ApiServer.start({
    port: 'auto',
    token,
    tokenMode: 'persistent',
    tokenFile: join(tmp.dir, 'api-token'),
    discoveryFile: join(tmp.dir, 'api.json'),
    daemonId: DAEMON_ID,
    maxBodyBytes: 256 * 1024,
    rejectionWindowMs: 10_000,
    now: () => 1_000_000,
    logger: createSilentLogger(),
    situations: new RecordingSituations(),
    gate,
  });
  cleanups.push(async () => {
    await server.stop();
    await composed.triggers.stop();
    await composed.runtime.stop();
    await tmp.dispose();
  });
  const workflows =
    options.bare === true
      ? undefined
      : {
          library: composed.library,
          bindings: composed.bindings,
          packages: composed.packages,
          validateOptions: composed.validateOptions,
          settings: () => config.workflows,
        };
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play',
    name: 's1',
    folder: tmp.dir,
    baseBranch: 'main',
  });
  registerWorkflowRoutes(server.handlers, { store, workflows } as unknown as ReadRouteDeps);
  registerWorkflowCommands(
    commandRegistrar(
      server.handlers,
      new IdempotencyCache({ clock, ttlMs: () => 60_000 }),
      createSilentLogger(),
    ),
    { store, workflows } as unknown as CommandRouteDeps,
  );
  return {
    server,
    store,
    composed,
    token,
    async call(method, path, body) {
      const response = await fetch(`${server.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- the answers of the API are read as loose JSON
      return { status: response.status, json: await response.json() };
    },
  };
}

/** A sound definition: reads the issue, asks, answers. `version` and the id are the caller's. */
export function definition(
  version: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'triage',
    version,
    engine: '>=1 <2',
    inputs: { issue: { type: 'number' } },
    limits: { redo: 2 },
    nodes: {
      read: { step: 'fetch_issue' },
      ask: { step: 'approval', params: { prompt: 'ok?' } },
      say: { step: 'notify', params: { message: 'done' } },
    },
    edges: [
      'read -> ask when output.state == "open"',
      'read -> done',
      { from: 'ask', to: 'read', when: 'not output.approved', limit: 'redo', on_limit: 'failed' },
      'ask -> say when output.approved',
      'say -> done',
    ],
    ...extra,
  };
}
